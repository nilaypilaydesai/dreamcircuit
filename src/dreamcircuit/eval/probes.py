"""What does the world model know? Linear probes on the bottleneck, then causal steering.

Probes. The denoiser's 8x8 bottleneck activations (taken at the first sampling step, when the
network must imagine the next frame from pure noise) are average-pooled to one vector per
frame. Ridge regressions fit on training circuits and are scored (R^2) on held-out circuits for
quantities the simulator knows but the network was never told: yaw rate (which exists in no
single frame), lateral slip, offset from the centerline, and the curvature of road up to 30 m
ahead (past the top edge of the view). Two controls keep this honest: the same probe on a
randomly initialized network of identical architecture, and a probe on the raw pixels of the
context frames.

Steering. A direction in activation space is added to the bottleneck at every sampling step
("activation steering") and the dream's behavior is measured with the registration instrument:
does the network *use* the direction, not merely encode it? Two kinds of direction are compared
at equal perturbation norm: the ridge probe's weight vector, and the mass-mean (difference of
class means) direction. As in language models (Marks & Tegmark, 2023), the regression direction
decodes well but barely steers, while the mass-mean direction moves the dream: push "speed" and
the world rushes past without the throttle being touched.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.dataset import EpisodeStore, to_tensor
from dreamcircuit.eval.registration import estimate_motion
from dreamcircuit.model.edm import WorldModel

TARGETS = (
    "speed",
    "yaw_rate",
    "lateral_speed",
    "steer",
    "offset",
    "heading_error",
    "curvature_0",
    "curvature_10",
    "curvature_20",
    "curvature_30",
    "on_grass",
)
LABELS = {
    "speed": "Speed",
    "yaw_rate": "Yaw rate",
    "lateral_speed": "Lateral slip",
    "steer": "Steering angle",
    "offset": "Offset from centerline",
    "heading_error": "Heading vs. track",
    "curvature_0": "Curvature here",
    "curvature_10": "Curvature 10 m ahead",
    "curvature_20": "Curvature 20 m ahead",
    "curvature_30": "Curvature 30 m ahead (beyond view)",
    "on_grass": "On grass",
}
# target -> (high class, low class) thresholds for mass-mean directions
STEER_TARGETS = {"speed": (18.0, 8.0), "yaw_rate": (0.4, -0.4), "curvature_20": (0.03, -0.03)}
STEER_LABELS = {
    "speed": "Speed",
    "yaw_rate": "Turn (left / right)",
    "curvature_20": "Road ahead bends (left / right)",
}


def _sample(store: EpisodeStore, n: int, l: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    e = rng.integers(0, store.n_episodes, n)
    k = rng.integers(l - 1, store.n_frames - 1, n)  # k = index of the last context frame
    return e, k


@torch.no_grad()
def bottleneck_features(
    model: WorldModel,
    store: EpisodeStore,
    e: np.ndarray,
    k: np.ndarray,
    device: torch.device,
    batch: int = 256,
    seed: int = 0,
) -> np.ndarray:
    """Pooled bottleneck activation (N, C) at the first sampling step."""
    l = model.context_frames
    g = torch.Generator(device="cpu").manual_seed(seed)
    feats = []
    sigma_max = model.edm.sigma_max
    for i in range(0, len(e), batch):
        eb, kb = e[i : i + batch], k[i : i + batch]
        t = kb[:, None] + np.arange(-l + 1, 1)[None, :]
        ctx = to_tensor(store.frames[eb[:, None], t], device)
        acts = torch.from_numpy(np.asarray(store.actions[eb[:, None], t])).to(device)
        b = len(eb)
        x = torch.randn(b, 3, 64, 64, generator=g).to(device) * sigma_max
        model.denoise(
            x, torch.full((b,), sigma_max, device=device), ctx, acts, torch.zeros(b, device=device)
        )
        feats.append(model.unet._mid_activation.mean((-2, -1)).float().cpu().numpy())
    return np.concatenate(feats)


def raw_pixel_features(store: EpisodeStore, e: np.ndarray, k: np.ndarray, l: int) -> np.ndarray:
    """Control: the context frames themselves, 4x average-pooled (16x16x3 per frame)."""
    t = k[:, None] + np.arange(-l + 1, 1)[None, :]
    f = np.asarray(store.frames[e[:, None], t], dtype=np.float32)  # (N, L, 64, 64, 3)
    n = f.shape[0]
    return f.reshape(n, l, 16, 4, 16, 4, 3).mean((3, 5)).reshape(n, -1) / 255.0


class Ridge:
    """Standardized ridge regression with the penalty chosen on a validation split."""

    def fit(self, x: np.ndarray, y: np.ndarray, alphas=(1e-2, 1e-1, 1.0, 10.0, 100.0)) -> Ridge:
        self.mu, self.sd = x.mean(0), x.std(0) + 1e-6
        self.ymu, self.ysd = y.mean(), y.std() + 1e-9
        z = (x - self.mu) / self.sd
        yz = (y - self.ymu) / self.ysd
        n = len(z)
        cut = int(0.8 * n)
        best = (-np.inf, alphas[0])
        for a in alphas:
            w = self._solve(z[:cut], yz[:cut], a)
            r2 = _r2(yz[cut:], z[cut:] @ w)
            if r2 > best[0]:
                best = (r2, a)
        self.alpha = best[1]
        self.w = self._solve(z, yz, self.alpha)
        return self

    @staticmethod
    def _solve(z: np.ndarray, y: np.ndarray, a: float) -> np.ndarray:
        d = z.shape[1]
        return np.linalg.solve(z.T @ z + a * len(z) / 100.0 * np.eye(d), z.T @ y)

    def predict(self, x: np.ndarray) -> np.ndarray:
        return ((x - self.mu) / self.sd) @ self.w * self.ysd + self.ymu

    def direction(self) -> np.ndarray:
        """Activation-space vector that raises the prediction by one target std."""
        d = self.w / self.sd  # d(pred / ysd) / d(x)
        return d / (d @ d)


def _r2(y: np.ndarray, p: np.ndarray) -> float:
    return float(1.0 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum())


def run_probes(
    model: WorldModel,
    random_model: WorldModel,
    train_root: str | Path,
    test_root: str | Path,
    device: torch.device,
    out_dir: Path,
    n_train: int = 12000,
    n_test: int = 4000,
    seed: int = 0,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    train, test = EpisodeStore(train_root), EpisodeStore(test_root)
    l = model.context_frames
    e_tr, k_tr = _sample(train, n_train, l, seed)
    e_te, k_te = _sample(test, n_test, l, seed + 1)

    feats = {
        "trained": (
            bottleneck_features(model, train, e_tr, k_tr, device),
            bottleneck_features(model, test, e_te, k_te, device),
        ),
        "random_init": (
            bottleneck_features(random_model, train, e_tr, k_tr, device),
            bottleneck_features(random_model, test, e_te, k_te, device),
        ),
        "raw_pixels": (
            raw_pixel_features(train, e_tr, k_tr, l),
            raw_pixel_features(test, e_te, k_te, l),
        ),
    }
    results: dict = {"n_train": n_train, "n_test": n_test, "labels": LABELS, "r2": {}}
    probes: dict[str, Ridge] = {}
    for target in TARGETS:
        fi_tr = train.feature_index(target)
        fi_te = test.feature_index(target)
        y_tr = np.asarray(train.features[e_tr, k_tr, fi_tr], dtype=np.float64)
        y_te = np.asarray(test.features[e_te, k_te, fi_te], dtype=np.float64)
        results["r2"][target] = {}
        for name, (x_tr, x_te) in feats.items():
            r = Ridge().fit(x_tr.astype(np.float64), y_tr)
            results["r2"][target][name] = _r2(y_te, r.predict(x_te.astype(np.float64)))
            if name == "trained":
                probes[target] = r
    (out_dir / "probes.json").write_text(json.dumps(results, indent=2))
    mass_mean = mass_mean_directions(feats["trained"][0], train, e_tr, k_tr)
    return {"results": results, "probes": probes, "mass_mean": mass_mean, "test": (e_te, k_te)}


def mass_mean_directions(
    x: np.ndarray, store: EpisodeStore, e: np.ndarray, k: np.ndarray
) -> dict[str, np.ndarray]:
    """Difference of class-mean activations (high minus low) for each steering target."""
    out = {}
    for target, (hi, lo) in STEER_TARGETS.items():
        y = np.asarray(store.features[e, k, store.feature_index(target)])
        out[target] = x[y > hi].mean(0) - x[y < lo].mean(0)
    return out


@torch.no_grad()
def steering_experiment(
    model: WorldModel,
    probes: dict,
    mass_mean: dict[str, np.ndarray],
    test_root: str | Path,
    device: torch.device,
    out_dir: Path,
    n: int = 32,
    horizon: int = 16,
    alphas: tuple[float, ...] = (-2.0, -1.0, 0.0, 1.0, 2.0),
    steps: int = 2,
    seed: int = 0,
) -> dict:
    """Dose-response of the dream to bottleneck pushes along mass-mean vs. ridge directions."""
    store = EpisodeStore(test_root)
    l = model.context_frames
    rng = np.random.default_rng(seed)
    spd, off = store.feature_index("speed"), store.feature_index("offset")
    picks: list[tuple[int, int]] = []
    while len(picks) < n:
        ei = int(rng.integers(store.n_episodes))
        ki = int(rng.integers(l, store.n_frames - horizon - 1))
        f = np.asarray(store.features[ei, ki])
        if 9.0 < f[spd] < 16.0 and abs(f[off]) < DEFAULT.track.half_width - 1.0:
            picks.append((ei, ki))
    e = np.array([p[0] for p in picks])
    k = np.array([p[1] for p in picks])
    t = k[:, None] + np.arange(-l + 1, 1)[None, :]
    ctx = to_tensor(store.frames[e[:, None], t], device)
    past = torch.from_numpy(np.asarray(store.actions[e[:, None], t[:, :-1]])).to(device)
    # Hold the controls neutral (straight, light throttle) so any change comes from the edit.
    fut = torch.tensor([0.0, 0.2], device=device).expand(n, horizon, 2).contiguous()
    hz = 1.0 / DEFAULT.dt

    def dream_motion(bias: np.ndarray | None) -> tuple[float, float]:
        mb = None if bias is None else torch.from_numpy(bias.astype(np.float32)).to(device)[None]
        torch.manual_seed(seed)
        dream = model.rollout(
            ctx, past, fut, steps=steps, mid_bias=None if mb is None else mb.expand(n, -1)
        )
        seq = torch.cat([ctx[:, -1:], dream], 1)
        motion = torch.stack([estimate_motion(seq[:, i], seq[:, i + 1]) for i in range(horizon)], 1)
        m = motion.cpu().numpy()[:, horizon // 2 :]
        return float(m[..., 0].mean() * hz), float(m[..., 2].mean() * hz)

    out: dict = {
        "alphas": list(alphas),
        "n": n,
        "horizon": horizon,
        "effects": {},
        "labels": STEER_LABELS,
    }
    for target in STEER_TARGETS:
        mm = mass_mean[target]
        ridge = probes[target].direction()
        ridge = ridge / np.linalg.norm(ridge) * np.linalg.norm(mm)  # equal perturbation norm
        eff: dict = {}
        for kind, vec in (("mass_mean", mm), ("ridge", ridge)):
            res = [dream_motion(None if a == 0 else a * vec) for a in alphas]
            eff[kind] = {"dream_speed": [r[0] for r in res], "dream_yaw_rate": [r[1] for r in res]}
        out["effects"][target] = eff
    (out_dir / "steering.json").write_text(json.dumps(out))
    return out


def browser_directions(mass_mean: dict[str, np.ndarray]) -> list[dict]:
    """The "Edit the dream's mind" sliders: mass-mean vectors, slider value = alpha."""
    scale = {"speed": 1.0, "yaw_rate": 1.5, "curvature_20": 1.5}
    return [
        {"name": t, "label": STEER_LABELS[t], "vector": np.round(v, 5).tolist(), "scale": scale[t]}
        for t, v in mass_mean.items()
    ]
