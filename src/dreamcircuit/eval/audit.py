"""The physics audit: does the dream obey the vehicle's physics?

Every measurement is made the same way on dreamed and real frame sequences (pixels in, numbers
out), so the instrument's own error shows up as the "reality" baseline:

1. Fidelity: PSNR / SSIM to the true future vs. horizon, for 1-4 sampling steps.
2. Motion: speed and yaw rate recovered by image registration, compared with the truth.
3. Speedometer consistency: does the dream's HUD speed agree with how fast its world moves?
4. Friction circle: how often does dreamed motion imply more grip than the tyres have?
5. Controllability: from one context, five counterfactual control sequences; does the dream
   turn, accelerate and brake the way the simulator does?
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.dataset import EpisodeStore, to_tensor, to_uint8
from dreamcircuit.eval.registration import estimate_motion, true_motion
from dreamcircuit.model.edm import WorldModel
from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.render import read_hud
from dreamcircuit.sim.track import generate_track
from dreamcircuit.train.world_model import psnr

HZ = 1.0 / DEFAULT.dt
MU_G = DEFAULT.vehicle.mu * DEFAULT.vehicle.g
COUNTERFACTUALS = {  # name: (steer, pedal) held for one second
    "left": (1.0, 0.2),
    "straight": (0.0, 0.2),
    "right": (-1.0, 0.2),
    "throttle": (0.0, 1.0),
    "brake": (0.0, -1.0),
}


def ssim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Mean SSIM over channels for (..., 3, H, W) tensors in [-1, 1] (11x11 Gaussian window)."""
    shape = a.shape
    a = ((a + 1) / 2).reshape(-1, 1, *shape[-2:])
    b = ((b + 1) / 2).reshape(-1, 1, *shape[-2:])
    g = torch.exp(-0.5 * ((torch.arange(11, device=a.device) - 5) / 1.5) ** 2)
    w = (g[:, None] * g[None, :] / g.sum() ** 2)[None, None]
    mu_a, mu_b = F.conv2d(a, w), F.conv2d(b, w)
    var_a = F.conv2d(a * a, w) - mu_a**2
    var_b = F.conv2d(b * b, w) - mu_b**2
    cov = F.conv2d(a * b, w) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
        (mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2)
    )
    return s.mean((-3, -2, -1)).reshape(*shape[:-3], 3).mean(-1)


def _windows(
    store: EpisodeStore, n: int, horizon: int, l: int, seed: int, near_track: bool = True
) -> tuple[np.ndarray, np.ndarray]:
    """Pick (episode, start) pairs whose whole window stays near the circuit (where the
    registration instrument is reliable)."""
    rng = np.random.default_rng(seed)
    off = store.feature_index("offset")
    out_e: list[int] = []
    out_k: list[int] = []
    while len(out_e) < n:
        ei = int(rng.integers(store.n_episodes))
        ki = int(rng.integers(0, store.n_frames - l - horizon))
        if near_track:
            o = np.abs(np.asarray(store.features[ei, ki : ki + l + horizon, off]))
            if o.max() > DEFAULT.track.half_width + 6.0:
                continue
        out_e.append(ei)
        out_k.append(ki)
    return np.array(out_e), np.array(out_k)


def _motion_series(frames: torch.Tensor, chunk: int = 512) -> torch.Tensor:
    """(B, T, 3, H, W) -> per-step ego-motion (B, T-1, 3)."""
    b, t = frames.shape[:2]
    a = frames[:, :-1].reshape(-1, *frames.shape[2:])
    c = frames[:, 1:].reshape(-1, *frames.shape[2:])
    out = torch.cat(
        [estimate_motion(a[i : i + chunk], c[i : i + chunk]) for i in range(0, len(a), chunk)]
    )
    return out.reshape(b, t - 1, 3)


def _hud_speed(frames: torch.Tensor) -> np.ndarray:
    speed_frac, _ = read_hud(to_uint8(frames), DEFAULT.render)
    return speed_frac * DEFAULT.vehicle.top_speed


def _physics(frames: torch.Tensor) -> dict[str, np.ndarray]:
    """Speed, yaw rate, implied accelerations and HUD speed for a frame sequence."""
    m = _motion_series(frames).cpu().numpy()
    v = m[..., 0] * HZ
    r = m[..., 2] * HZ
    a_lat = v * r
    a_long = np.gradient(v, axis=-1) * HZ if v.shape[-1] > 1 else np.zeros_like(v)
    hud = _hud_speed(frames)
    hud_mid = 0.5 * (hud[:, :-1] + hud[:, 1:])
    return {"v": v, "r": r, "a_lat": a_lat, "a_long": a_long, "hud": hud_mid}


@torch.no_grad()
def fidelity(
    model: WorldModel,
    store: EpisodeStore,
    device: torch.device,
    n: int,
    horizon: int,
    steps_list: tuple[int, ...],
    seed: int,
) -> dict:
    l = model.context_frames
    e, k = _windows(store, n, horizon, l, seed)
    t = k[:, None] + np.arange(l + horizon)[None, :]
    frames = to_tensor(store.frames[e[:, None], t], device)
    acts = torch.from_numpy(np.asarray(store.actions[e[:, None], t[:, :-1]])).to(device)
    truth = frames[:, l:]
    res: dict = {"horizon": horizon, "n": n, "copy_last": {}}
    copy = frames[:, l - 1 : l].expand_as(truth)
    res["copy_last"] = {
        "psnr": psnr(copy, truth).mean(0).tolist(),
        "ssim": ssim(copy, truth).mean(0).tolist(),
    }
    dreams = {}
    for steps in steps_list:
        torch.manual_seed(seed)
        t0 = time.time()
        dream = model.rollout(frames[:, :l], acts[:, : l - 1], acts[:, l - 1 :], steps=steps)
        if device.type == "mps":
            torch.mps.synchronize()
        calls = n * horizon * steps
        res[f"steps_{steps}"] = {
            "psnr": psnr(dream, truth).mean(0).tolist(),
            "ssim": ssim(dream, truth).mean(0).tolist(),
            "ms_per_call_batched": 1000 * (time.time() - t0) / (horizon * steps),
            "denoiser_calls": calls,
        }
        dreams[steps] = dream
    # Play-time context-noise level (the browser's "context noise" slider): telling the model
    # its context is slightly noisy invites it to repair, rather than copy, its own mistakes.
    res["context_noise_sweep"] = {}
    for aug in (0.0, 0.05, 0.1, 0.2):
        torch.manual_seed(seed)
        dream = model.rollout(
            frames[:, :l], acts[:, : l - 1], acts[:, l - 1 :], steps=2, aug_sigma=aug
        )
        res["context_noise_sweep"][f"{aug:.2f}"] = psnr(dream, truth).mean(0).tolist()
    return {
        "metrics": res,
        "dreams": dreams,
        "truth": truth,
        "frames": frames,
        "episodes": e,
        "starts": k,
    }


def physics(dream: torch.Tensor, truth: torch.Tensor, context_last: torch.Tensor) -> dict:
    seq_d = torch.cat([context_last[:, None], dream], 1)
    seq_t = torch.cat([context_last[:, None], truth], 1)
    pd, pt = _physics(seq_d), _physics(seq_t)
    lim = 1.25 * MU_G

    def viol(p: dict) -> float:
        return float(np.mean(np.hypot(p["a_lat"], p["a_long"]) > lim))

    horizon_s = np.arange(1, seq_d.shape[1]) / HZ
    return {
        "time_s": horizon_s.tolist(),
        "speed_mae_vs_time": np.abs(pd["v"] - pt["v"]).mean(0).tolist(),
        "yaw_mae_vs_time": np.abs(pd["r"] - pt["r"]).mean(0).tolist(),
        "speed_true_mean": pt["v"].mean(0).tolist(),
        "speed_dream_mean": pd["v"].mean(0).tolist(),
        "hud_consistency_mae": {
            "dream": float(np.abs(pd["hud"] - pd["v"]).mean()),
            "reality": float(np.abs(pt["hud"] - pt["v"]).mean()),
        },
        "friction_violation_rate": {"dream": viol(pd), "reality": viol(pt)},
        "speed_mae_1s": float(np.abs(pd["v"] - pt["v"])[:, : int(HZ)].mean()),
        "speed_mae_3s": float(np.abs(pd["v"] - pt["v"])[:, : int(3 * HZ)].mean()),
        "yaw_mae_1s": float(np.abs(pd["r"] - pt["r"])[:, : int(HZ)].mean()),
        "yaw_mae_3s": float(np.abs(pd["r"] - pt["r"])[:, : int(3 * HZ)].mean()),
        "max_lat_accel_g": {
            "dream": float(np.percentile(np.abs(pd["a_lat"]), 99) / 9.81),
            "reality": float(np.percentile(np.abs(pt["a_lat"]), 99) / 9.81),
        },
    }


@torch.no_grad()
def controllability(
    model: WorldModel,
    store: EpisodeStore,
    device: torch.device,
    n: int,
    seconds: float,
    steps: int,
    seed: int,
) -> dict:
    """Counterfactual control: identical context, five different control sequences."""
    l = model.context_frames
    horizon = int(seconds * HZ)
    rng = np.random.default_rng(seed)
    spd, off = store.feature_index("speed"), store.feature_index("offset")
    picks: list[tuple[int, int]] = []
    while len(picks) < n:
        ei = int(rng.integers(store.n_episodes))
        ki = int(rng.integers(l, store.n_frames - 1))
        f = np.asarray(store.features[ei, ki])
        if 8.0 < f[spd] < 22.0 and abs(f[off]) < DEFAULT.track.half_width - 1.0:
            picks.append((ei, ki))
    e = np.array([p[0] for p in picks])
    k = np.array([p[1] for p in picks])
    t = k[:, None] + np.arange(-l + 1, 1)[None, :]
    ctx = to_tensor(store.frames[e[:, None], t], device)
    past = torch.from_numpy(np.asarray(store.actions[e[:, None], t[:, :-1]])).to(device)
    cars = store.meta["cars_per_track"]

    out: dict = {"n": n, "seconds": seconds, "futures": {}}
    examples: dict[str, dict[str, np.ndarray]] = {}
    for name, (steer, pedal) in COUNTERFACTUALS.items():
        fut = torch.tensor([steer, pedal], device=device).expand(n, horizon, 2).contiguous()
        torch.manual_seed(seed)
        dream = model.rollout(ctx, past, fut, steps=steps)
        # Ground truth: the real simulator from the exact same state, same controls.
        real = np.empty((n, horizon, *store.frames.shape[2:]), dtype=np.uint8)
        for i, (ei, ki) in enumerate(picks):
            track = generate_track(store.meta["track_seeds"][ei // cars], DEFAULT.track)
            env = RaceEnv(track, 1)
            env.set_state(np.asarray(store.states[ei, ki], dtype=np.float64)[None])
            for h in range(horizon):
                real[i, h] = env.step(np.array([[steer, pedal]]))[0]
        real_t = to_tensor(real, device)
        last = ctx[:, -1:]
        md = _motion_series(torch.cat([last, dream], 1)).cpu().numpy()
        mr = _motion_series(torch.cat([last, real_t], 1)).cpu().numpy()
        half = horizon // 2
        out["futures"][name] = {
            "yaw_rate_dream": (md[:, half:, 2].mean(1) * HZ).tolist(),
            "yaw_rate_real": (mr[:, half:, 2].mean(1) * HZ).tolist(),
            "dv_dream": ((md[:, -3:, 0].mean(1) - md[:, :3, 0].mean(1)) * HZ).tolist(),
            "dv_real": ((mr[:, -3:, 0].mean(1) - mr[:, :3, 0].mean(1)) * HZ).tolist(),
        }
        examples[name] = {"dream": to_uint8(dream[:4]), "real": real[:4]}

    f = out["futures"]
    yaw_d = np.array(f["left"]["yaw_rate_dream"]) - np.array(f["right"]["yaw_rate_dream"])
    yaw_r = np.array(f["left"]["yaw_rate_real"]) - np.array(f["right"]["yaw_rate_real"])
    dv_d = np.array(f["throttle"]["dv_dream"]) - np.array(f["brake"]["dv_dream"])
    dv_r = np.array(f["throttle"]["dv_real"]) - np.array(f["brake"]["dv_real"])
    all_d = np.concatenate([f[c]["yaw_rate_dream"] for c in ("left", "straight", "right")])
    all_r = np.concatenate([f[c]["yaw_rate_real"] for c in ("left", "straight", "right")])
    out["summary"] = {
        "steer_sign_agreement": float(np.mean(np.sign(yaw_d) == np.sign(yaw_r))),
        "pedal_sign_agreement": float(np.mean(np.sign(dv_d) == np.sign(dv_r))),
        "yaw_rate_correlation": float(np.corrcoef(all_d, all_r)[0, 1]),
        "yaw_response_ratio": float(
            np.median(yaw_d / np.where(np.abs(yaw_r) > 1e-3, yaw_r, np.nan))
        ),
        "dv_response_ratio": float(
            np.nanmedian(dv_d / np.where(np.abs(dv_r) > 1e-3, dv_r, np.nan))
        ),
    }
    return {"metrics": out, "examples": examples}


@torch.no_grad()
def instrument_validation(
    store: EpisodeStore, device: torch.device, n: int = 512, seed: int = 0
) -> dict:
    """How well does the registration instrument recover true motion from *real* frames?
    (Everything the audit says about dreams is only as good as this.)"""
    rng = np.random.default_rng(seed)
    e = rng.integers(0, store.n_episodes, n)
    t = rng.integers(0, store.n_frames - 1, n)
    off = np.abs(np.asarray(store.features[e, t, store.feature_index("offset")]))
    near = off < DEFAULT.track.half_width + 6.0
    e, t = e[near], t[near]
    est = (
        estimate_motion(
            to_tensor(store.frames[e, t], device), to_tensor(store.frames[e, t + 1], device)
        )
        .cpu()
        .numpy()
    )
    st = torch.from_numpy(np.asarray(store.states[e, t], dtype=np.float32))
    st1 = torch.from_numpy(np.asarray(store.states[e, t + 1], dtype=np.float32))
    tru = true_motion(st, st1).numpy()

    def r2(a: np.ndarray, b: np.ndarray) -> float:
        return float(1 - ((a - b) ** 2).sum() / ((a - a.mean()) ** 2).sum())

    v_t, v_e, r_t, r_e = tru[:, 0] * HZ, est[:, 0] * HZ, tru[:, 2] * HZ, est[:, 2] * HZ
    return {
        "pairs": len(e),
        "speed_r2": r2(v_t, v_e),
        "speed_mae": float(np.abs(v_t - v_e).mean()),
        "yaw_r2": r2(r_t, r_e),
        "yaw_mae": float(np.abs(r_t - r_e).mean()),
        "speed_range": [float(np.percentile(v_t, 5)), float(np.percentile(v_t, 95))],
    }


def run_audit(
    model: WorldModel,
    test_root: str | Path,
    device: torch.device,
    out_dir: Path,
    n: int = 64,
    horizon: int = 60,
    steps_list: tuple[int, ...] = (1, 2, 3, 4),
    physics_steps: int = 2,
    n_counterfactual: int = 24,
    seed: int = 0,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    store = EpisodeStore(test_root)
    t0 = time.time()
    fid = fidelity(model, store, device, n, horizon, steps_list, seed)
    l = model.context_frames
    phys = physics(fid["dreams"][physics_steps], fid["truth"], fid["frames"][:, l - 1])
    ctrl = controllability(model, store, device, n_counterfactual, 1.0, physics_steps, seed)
    report = {
        "instrument": instrument_validation(store, device),
        "fidelity": fid["metrics"],
        "physics": phys,
        "controllability": ctrl["metrics"],
        "physics_steps": physics_steps,
        "seconds": round(time.time() - t0, 1),
    }
    (out_dir / "audit.json").write_text(json.dumps(report))
    media: dict[str, Any] = {"truth": to_uint8(fid["truth"][:8])}
    media.update({f"dream_{s}": to_uint8(d[:8]) for s, d in fid["dreams"].items()})
    media.update(
        {f"cf_{k}_{w}": v[w] for k, v in ctrl["examples"].items() for w in ("dream", "real")}
    )
    np.savez_compressed(out_dir / "audit_media.npz", **media)
    return report
