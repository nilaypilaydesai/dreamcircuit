"""Train the circuit designer and measure how often it builds a proper circuit.

    dreamcircuit train-tracks
    dreamcircuit eval-tracks

"Proper" means the architect's rules (corner radius, grass between stretches, lap length, a
start straight, and for figure-eights one steep crossing on straight road that a bridge can
span), checked on the reconstructed centerline. Reported on held-out conditions:

- whole-circuit validity: dream a complete circuit from nothing, per requested layout;
- live validity: generate it the way the game does, arc by arc ahead of the karts, then close
  the loop, with the game's retry rule (resample an arc that fails, up to 3 times);
- style steering: ask for calm or wild road and measure how technical the result is.
"""

from __future__ import annotations

import json
import resource
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import numpy as np
import torch

from dreamcircuit.sim.track import _catmull_rom_closed, _smooth_closed
from dreamcircuit.trackgen import architect as A
from dreamcircuit.trackgen.data import N_POINTS
from dreamcircuit.trackgen.model import (
    LAYOUTS,
    TrackDenoiser,
    TrackModelConfig,
    from_steps,
    layout_onehot,
    step_mask,
    to_steps,
)
from dreamcircuit.train.common import EMA, cosine_lr, pick_device, save_checkpoint

# Live generation schedule (point indices), mirrored by web/src/game/world/trackgen.ts.
INITIAL_KNOWN = (-24, 40)  # the start grid and first stretch, generated before the countdown
CHUNK = 32  # points generated per step during lap 1 (about 80 m)
SAMPLER_STEPS = 24  # Heun steps per arc (47 network calls)
ARC_SMOOTH = 1.0  # Gaussian smoothing of newly generated points, in point spacings
CORNER_REF = 15.0  # m: a corner of this radius counts as fully "technical" for the style signal
EXPECT = {"any": None, "loop": 0, "figure8": 1}


# ------------------------------------------------------------------------------- geometry


RECON_SMOOTH = 1.0  # m: irons out the spline's overshoot at hairpin apexes


def reconstruct(points: np.ndarray) -> np.ndarray:
    """Lap points (N, 2), model meters -> dense closed centerline at the architect's spacing.

    The spline through ~2.8 m-spaced points overshoots slightly in the tightest hairpins (14% of
    architect circuits would fail the radius rule on that alone); a 1 m smoothing removes it and
    round-trips every architect circuit as valid."""
    dense = _catmull_rom_closed(points.astype(np.float64), n_per_seg=12)
    dense = A.resample(dense, max(round(_length(dense) / A.DS), 16))
    return A.resample(_smooth_closed(dense, RECON_SMOOTH / A.DS), len(dense))


def _length(pts: np.ndarray) -> float:
    seg = np.roll(pts, -1, axis=0) - pts
    return float(np.hypot(seg[:, 0], seg[:, 1]).sum())


def smooth_arc(u: np.ndarray, arc: np.ndarray, sigma: float = ARC_SMOOTH) -> np.ndarray:
    """Circular Gaussian smoothing of the points in ``arc`` only ((dims, N) array); everything
    else (road that already exists) is left untouched."""
    k = np.arange(-3, 4)
    w = np.exp(-0.5 * (k / sigma) ** 2)
    w /= w.sum()
    sm = sum(wi * np.roll(u, -ki, axis=-1) for wi, ki in zip(w, k, strict=True))
    out = u.copy()
    out[..., arc] = sm[..., arc]
    return out


def live_arcs(n: int = N_POINTS) -> list[np.ndarray]:
    """The order in which the game builds a circuit: the start grid and first stretch, then
    CHUNK-sized arcs around the lap until the loop closes."""
    a, b = INITIAL_KNOWN
    arcs = [np.arange(a, b) % n]
    pos = b
    while pos < n + a:
        arcs.append(np.arange(pos, min(pos + CHUNK, n + a)) % n)
        pos += CHUNK
    return arcs


# ------------------------------------------------------------------------------- style


def raw_style(kappa: np.ndarray) -> float:
    """How technical a stretch of road is: the mean of |kappa| * CORNER_REF, capped at 1."""
    return float(np.minimum(1.0, np.abs(kappa) * CORNER_REF).mean())


class StyleScale:
    """Maps raw style to 0..1 using the 5th and 95th percentiles of training arcs."""

    def __init__(self, lo: float, hi: float):
        self.lo, self.hi = lo, hi

    @classmethod
    def fit(cls, kappa: np.ndarray, rng: np.random.Generator, n: int = 20000) -> StyleScale:
        rows = rng.integers(0, len(kappa), n)
        starts = rng.integers(0, kappa.shape[1], n)
        idx = (starts[:, None] + np.arange(CHUNK)[None]) % kappa.shape[1]
        raw = np.minimum(1.0, np.abs(kappa[rows[:, None], idx]) * CORNER_REF).mean(1)
        return cls(float(np.percentile(raw, 5)), float(np.percentile(raw, 95)))

    def __call__(self, raw: float | np.ndarray) -> np.ndarray:
        return np.clip((np.asarray(raw) - self.lo) / max(self.hi - self.lo, 1e-6), 0.0, 1.0)


# ------------------------------------------------------------------------------- training


def random_masks(b: int, n: int, rng: np.random.Generator) -> np.ndarray:
    """Known road: 20% none (dream a whole circuit), 40% the lap so far from the grid (as in
    the game), 40% one random contiguous stretch."""
    m = np.zeros((b, n), dtype=np.float32)
    a0 = INITIAL_KNOWN[0] % n
    for i in range(b):
        u = rng.random()
        if u < 0.2:
            continue
        if u < 0.6:
            length = int(rng.integers(INITIAL_KNOWN[1] - INITIAL_KNOWN[0], n - 8))
            m[i, (a0 + np.arange(length)) % n] = 1.0
        else:
            length = int(rng.integers(6, n - 6))
            start = int(rng.integers(0, n))
            m[i, (start + np.arange(length)) % n] = 1.0
    return m


def train_tracks(
    data: str = "data/circuits",
    out: str = "runs/designer",
    steps: int = 14000,
    batch: int = 256,
    lr: float = 3e-4,
    device_name: str = "auto",
    seed: int = 0,
    init: str | None = None,
    p_mean: float | None = None,
    p_std: float | None = None,
    resume: bool = False,
    self_cond: bool = False,
) -> dict:
    """Train (or, with ``init``, continue training) the designer. ``p_mean``/``p_std`` override
    the log-normal noise-level distribution, e.g. to spend a refinement phase on the small noise
    levels where corner apexes get their last tenth of a meter. The full training state is saved
    every 1,000 steps; ``resume`` picks a stopped run up from there."""
    dev = pick_device(device_name)
    run = Path(out)
    run.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    pts = np.load(Path(data) / "train_points.npy")
    kap = np.load(Path(data) / "train_kappa.npy")
    topo = np.load(Path(data) / "train_topology.npy")
    cfg = TrackModelConfig(n=pts.shape[1])
    if p_mean is not None:
        cfg = replace(cfg, p_mean=p_mean)
    if p_std is not None:
        cfg = replace(cfg, p_std=p_std)
    if self_cond:
        cfg = replace(cfg, self_cond=True)
    style_scale = StyleScale.fit(kap, rng)
    x_all = torch.from_numpy(to_steps(pts, cfg.scale).transpose(0, 2, 1).astype(np.float32))
    model = TrackDenoiser(cfg).to(dev)
    if init:
        weights = torch.load(init, map_location="cpu", weights_only=False)["ema"]
        own = model.state_dict()
        w, mine = weights["inp.weight"], own["inp.weight"]
        if w.shape != mine.shape:
            # a self-conditioning model has extra input channels: keep the trained ones and start
            # the new ones at zero, so it begins exactly where the model it grew from left off
            grown = torch.zeros_like(mine)
            grown[:, : w.shape[1]] = w
            weights["inp.weight"] = grown
        model.load_state_dict(weights)
    ema = EMA(model, 0.999)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    log: list[dict] = []
    start = 0
    state_path = run / "state.pt"
    if resume and state_path.exists():
        st = torch.load(state_path, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model"])
        ema.model.load_state_dict(st["ema"])
        opt.load_state_dict(st["opt"])
        rng.bit_generator.state = st["rng"]
        start, log = st["step"], st["evals"]
        print(f"resuming at step {start}", flush=True)

    def save(step_done: int) -> None:
        save_checkpoint(
            run / "designer.pt",
            ema=ema.model.state_dict(),
            config=cfg.__dict__,
            style_scale=[style_scale.lo, style_scale.hi],
            step=step_done,
            evals=log,
        )
        save_checkpoint(
            state_path,
            model=model.state_dict(),
            ema=ema.model.state_dict(),
            opt=opt.state_dict(),
            rng=rng.bit_generator.state,
            step=step_done,
            evals=log,
        )

    t0 = time.time()
    for step in range(start, steps):
        idx = rng.integers(0, len(x_all), batch)
        x = x_all[idx].clone()
        k = kap[idx]
        flip = torch.from_numpy(rng.random(batch) < 0.5)  # mirror: left-handers <-> right-handers
        x[flip, 1] *= -1
        mask_np = random_masks(batch, cfg.n, rng)
        # style of the road to be dreamed (the unknown points; the whole lap if none is known)
        unknown = np.where(mask_np.sum(1, keepdims=True) > 0, 1 - mask_np, 1.0)
        raw = (np.minimum(1.0, np.abs(k) * CORNER_REF) * unknown).sum(1) / unknown.sum(1)
        style = torch.from_numpy(style_scale(raw).astype(np.float32))
        style_on = torch.from_numpy((rng.random(batch) < 0.8).astype(np.float32))
        names = [LAYOUTS[1 + int(t)] if rng.random() < 0.75 else "any" for t in topo[idx]]
        layout = layout_onehot(names)
        mask = torch.from_numpy(step_mask(mask_np))[:, None]  # the network sees steps
        for gp in opt.param_groups:
            gp["lr"] = cosine_lr(step, lr, 400, steps, floor=0.05)
        loss = model.loss(x.to(dev), mask.to(dev), style.to(dev), style_on.to(dev), layout.to(dev))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        ema.update(model, step)
        if (step + 1) % 250 == 0:
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20  # MB (macOS: bytes)
            print(
                f"designer step {step + 1}/{steps} loss {loss.item():.4f} "
                f"({(step + 1 - start) / (time.time() - t0):.1f} it/s, peak {peak:.0f} MB)",
                flush=True,
            )
        if (step + 1) % 1000 == 0:
            save(step + 1)
        if (step + 1) % 3500 == 0 or step + 1 == steps:
            last = step + 1 == steps
            ev = evaluate(
                ema.model,  # type: ignore[arg-type]
                dev,
                style_scale,
                n_whole=300 if last else 96,
                n_live=40 if last else 8,
            )
            ev["step"] = step + 1
            log.append(ev)
            print("eval", json.dumps(ev), flush=True)
            save(step + 1)
    result = {
        "evals": log,
        "params": sum(p.numel() for p in model.parameters()),
        "seconds": round(time.time() - t0, 1),
        "train_circuits": len(pts),
    }
    (run / "result.json").write_text(json.dumps(result, indent=2))
    return result


def load_track_model(
    path: str | Path, device: torch.device | str = "cpu"
) -> tuple[TrackDenoiser, StyleScale]:
    ck = torch.load(path, map_location="cpu", weights_only=False)
    cfg = dict(ck["config"])
    cfg["channels"] = tuple(cfg["channels"])
    m = TrackDenoiser(TrackModelConfig(**cfg))
    m.load_state_dict(ck["ema"])
    return m.to(device).eval(), StyleScale(*ck["style_scale"])


# ------------------------------------------------------------------------------- generation


def _cond(
    style: float | None, layout: str, dev: torch.device, b: int = 1
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    on = torch.full((b,), 0.0 if style is None else 1.0, device=dev)
    val = torch.full((b,), 0.0 if style is None else float(style), device=dev)
    return val, on, layout_onehot([layout] * b, dev)


@torch.no_grad()
def dream_whole(
    model: TrackDenoiser,
    dev: torch.device,
    b: int,
    layout: str = "any",
    style: float | None = None,
    steps: int = SAMPLER_STEPS,
    seed: int = 0,
) -> np.ndarray:
    """``b`` whole circuits from nothing: (b, N, 2) model meters, lightly smoothed."""
    n = model.cfg.n
    zeros = torch.zeros(b, 1, n, device=dev)
    known = torch.zeros(b, model.cfg.dims, n, device=dev)
    g = torch.Generator().manual_seed(seed)
    out = model.sample(zeros, known, steps, g, *_cond(style, layout, dev, b)).cpu().numpy()
    every = np.arange(n)
    laps = [from_steps(u.T, None, None, model.cfg.scale) for u in out]
    return np.stack([smooth_arc(p.T, every).T for p in laps])


@torch.no_grad()
def live_generate(
    model: TrackDenoiser,
    device: torch.device,
    rng: np.random.Generator,
    layout: str = "any",
    style: Callable[[int], float | None] | None = None,
    steps: int = SAMPLER_STEPS,
    retries: int = 3,
    trace: list[dict] | None = None,
) -> tuple[np.ndarray, int]:
    """The game's lap-1 procedure. Returns the points (N, 2, model meters) and the number of
    arcs retried. ``style(k)`` gives the style asked of arc k (None: don't care).

    With ``trace``, appends one snapshot per built arc: the arc, the known mask, and the
    designer's whole-circuit guess at that moment (model meters)."""
    n, scale = model.cfg.n, model.cfg.scale
    known = np.zeros((n, 2))  # the road so far, model meters
    mask = np.zeros(n, dtype=np.float32)
    retried = 0
    for k, arc in enumerate(live_arcs(n)):
        s = style(k) if style else None
        full = known
        steps_mask = step_mask(mask)
        steps_known = (to_steps(known, scale) * steps_mask[:, None]).T.astype(np.float32)
        m = torch.from_numpy(steps_mask)[None, None].to(device)
        kn = torch.from_numpy(steps_known)[None].to(device)
        for attempt in range(retries + 1):
            g = torch.Generator().manual_seed(int(rng.integers(1 << 31)))
            raw = model.sample(m, kn, steps, g, *_cond(s, layout, device))[0].cpu().numpy()
            lap = from_steps(raw.T, known, mask, scale)
            out = smooth_arc(lap.T, arc).T
            cand_known, cand_mask = known.copy(), mask.copy()
            cand_known[arc] = out[arc]
            cand_mask[arc] = 1.0
            # check the arc in context: the rest of the lap is this sample's guess
            full = np.where(cand_mask[:, None] > 0, cand_known, out)
            v = A.check(reconstruct(full), expect=EXPECT[layout])
            if v.ok or attempt == retries:
                if not v.ok:  # last resort, as in the game: iron out the wiggle and keep racing
                    cand_known[arc] = smooth_arc(lap.T, arc, 2.0).T[arc]
                    full = np.where(cand_mask[:, None] > 0, cand_known, out)
                known, mask = cand_known, cand_mask
                break
            retried += 1
        if trace is not None:
            trace.append({"arc": arc, "mask": mask.copy(), "guess": full.copy()})
    return known, retried


def constant_style(target: float) -> Callable[[int], float | None]:
    """Ask every arc for the same style."""
    return lambda _arc: target


# ------------------------------------------------------------------------------- evaluation


def arc_styles(points: np.ndarray, scale: StyleScale) -> list[float]:
    """The style (0..1) of each arc the game dreams during lap 1, measured on the result."""
    dense = reconstruct(points)
    kap = A.curvature(dense)
    n = len(points)
    idx = np.round(np.arange(n) * (len(dense) / n)).astype(int) % len(dense)
    k_pts = kap[idx]
    return [float(scale(raw_style(k_pts[arc]))) for arc in live_arcs(n)[1:]]


_WORKER: TrackDenoiser | None = None  # one designer per evaluation worker process


def _worker_init(checkpoint: str) -> None:
    global _WORKER
    torch.set_num_threads(1)  # a long chain of batch-1 calls: one thread each is fastest
    _WORKER, _ = load_track_model(checkpoint, "cpu")


def _live_task(args: tuple[str, int, float | None, float, float]) -> tuple[bool, int, list[float]]:
    """One circuit built live in a worker: (drivable, arcs retried, measured arc styles)."""
    layout, seed, target, lo, hi = args
    assert _WORKER is not None
    style = None if target is None else constant_style(target)
    rng = np.random.default_rng(seed)
    p, r = live_generate(_WORKER, torch.device("cpu"), rng, layout, style=style)
    ok = A.check(reconstruct(p), expect=EXPECT[layout]).ok
    return ok, r, ([] if target is None else arc_styles(p, StyleScale(lo, hi)))


@torch.no_grad()
def evaluate(
    model: TrackDenoiser,
    device: torch.device,
    style_scale: StyleScale,
    n_whole: int = 300,
    n_live: int = 40,
    seed: int = 1,
    checkpoint: str | Path | None = None,
    workers: int = 1,
) -> dict:
    """Validity of whole circuits dreamed in one pass, of circuits built live (as in the game),
    and how well the style condition steers. With ``checkpoint`` and ``workers`` > 1, the live
    builds run in that many processes, each with its own seed."""
    model.eval()
    rng = np.random.default_rng(seed)
    res: dict = {}
    for layout in LAYOUTS:
        pts = dream_whole(model, device, n_whole, layout, seed=seed + LAYOUTS.index(layout))
        verdicts = [A.check(reconstruct(p), expect=EXPECT[layout]) for p in pts]
        reasons: dict[str, int] = {}
        for v in verdicts:
            if not v.ok:
                reasons[v.reason] = reasons.get(v.reason, 0) + 1
        res[f"whole_valid_{layout}"] = sum(v.ok for v in verdicts) / n_whole
        res[f"whole_fail_{layout}"] = reasons
        if layout == "any":
            res["whole_figure8_share_any"] = (
                sum(v.ok and len(v.crossings) == 1 for v in verdicts) / n_whole
            )
            res["mean_length_m"] = float(np.mean([v.length for v in verdicts]))
    if checkpoint is not None and workers > 1:
        res.update(_live_parallel(str(checkpoint), workers, n_live, seed, style_scale))
        model.train()
        return res
    threads = torch.get_num_threads()
    if device.type == "cpu":
        torch.set_num_threads(1)  # a long chain of batch-1 calls: extra threads only add overhead
    try:
        for layout in ("loop", "figure8"):
            ok, retried = 0, 0
            for _ in range(n_live):
                p, r = live_generate(model, device, rng, layout)
                ok += A.check(reconstruct(p), expect=EXPECT[layout]).ok
                retried += r
            res[f"live_valid_{layout}"] = ok / n_live
            res[f"live_retries_{layout}"] = retried / n_live
        steer = {}
        for target in (0.1, 0.9):
            got: list[float] = []
            for _ in range(max(n_live // 2, 4)):
                p, _r = live_generate(model, device, rng, "loop", style=constant_style(target))
                got.extend(arc_styles(p, style_scale))
            steer[f"{target:.1f}"] = float(np.mean(got))
        res["style_steering"] = steer
    finally:
        torch.set_num_threads(threads)
    model.train()
    return res


def _live_parallel(
    checkpoint: str, workers: int, n_live: int, seed: int, scale: StyleScale
) -> dict:
    import multiprocessing as mp

    tasks: list[tuple[str, int, float | None, float, float]] = []
    for k, layout in enumerate(("loop", "figure8")):
        base = seed * 100_003 + k * 10_007
        tasks += [(layout, base + i, None, scale.lo, scale.hi) for i in range(n_live)]
    for k, target in enumerate((0.1, 0.9)):
        tasks += [
            ("loop", seed * 100_003 + 50_000 + k * 10_007 + i, target, scale.lo, scale.hi)
            for i in range(max(n_live // 2, 4))
        ]
    with mp.get_context("spawn").Pool(workers, _worker_init, (checkpoint,)) as pool:
        out = pool.map(_live_task, tasks, chunksize=1)
    res: dict = {}
    for layout in ("loop", "figure8"):
        rows = [o for t, o in zip(tasks, out, strict=True) if t[0] == layout and t[2] is None]
        res[f"live_valid_{layout}"] = sum(o[0] for o in rows) / len(rows)
        res[f"live_retries_{layout}"] = sum(o[1] for o in rows) / len(rows)
    steer = {}
    for target in (0.1, 0.9):
        got = [x for t, o in zip(tasks, out, strict=True) if t[2] == target for x in o[2]]
        steer[f"{target:.1f}"] = float(np.mean(got))
    res["style_steering"] = steer
    return res


def growth_trace(model: TrackDenoiser, device: torch.device, seed: int = 2026) -> dict:
    """One figure-8 built live, arc by arc, for the DATA page's step-by-step figure: after each
    arc, the road built so far and the designer's guess at the rest of the lap (model meters).
    The first seed whose circuit passes every rule is used; ``tries`` says how many it took."""
    for k in range(10):
        trace: list[dict] = []
        pts, retried = live_generate(
            model, device, np.random.default_rng(seed + k), "figure8", trace=trace
        )
        if A.check(reconstruct(pts), expect=EXPECT["figure8"]).ok or k == 9:
            break
    return {
        "layout": "figure8",
        "tries": k + 1,
        "retries": retried,
        "steps": [
            {
                "arc": [int(t["arc"][0]), len(t["arc"])],
                "known": int(t["mask"].sum()),
                "guess": t["guess"].round(1).tolist(),
            }
            for t in trace
        ],
        "final": pts.round(1).tolist(),
    }


def evaluate_designer(
    checkpoint: str | Path,
    out: str | Path = "results/trackgen.json",
    n_whole: int = 1000,
    n_live: int = 200,
    device_name: str = "auto",
    data: str = "data/circuits",
    web: str | Path | None = "web/public/results",
    figures: str | Path | None = "docs/assets",
    workers: int = 8,
) -> dict:
    """The published numbers: validity at scale, plus circuits for the DATA page gallery.

    Whole circuits are dreamed in big batches on ``device_name``; live builds are long chains of
    batch-1 calls, which run fastest on the CPU, one process per worker."""
    dev = pick_device(device_name)
    model, scale = load_track_model(checkpoint, dev)
    t0 = time.time()
    ev = evaluate(
        model, dev, scale, n_whole=n_whole, n_live=n_live, checkpoint=checkpoint, workers=workers
    )
    dreamed, verdicts = {}, {}
    for i, layout in enumerate(("loop", "figure8")):
        pts = dream_whole(model, dev, 12, layout, seed=2026 + i)
        dreamed[layout] = pts.round(2).tolist()
        checks = [A.check(reconstruct(p), expect=EXPECT[layout]) for p in pts]
        verdicts[layout] = [v.reason or "ok" for v in checks]
    growth = growth_trace(model, dev)
    meta = json.loads((Path(data) / "meta.json").read_text())
    real_pts = np.load(Path(data) / "test_points.npy")
    real_topo = np.load(Path(data) / "test_topology.npy")
    real = {
        "loop": real_pts[real_topo == 0][:12].round(2).tolist(),
        "figure8": real_pts[real_topo == 1][:12].round(2).tolist(),
    }
    ck = torch.load(checkpoint, map_location="cpu", weights_only=False)
    result = {
        **ev,
        "n_whole": n_whole,
        "n_live": n_live,
        "train_steps": ck.get("step"),
        "params": sum(p.numel() for p in model.parameters()),
        "sampler_steps": SAMPLER_STEPS,
        "arc_smoothing": ARC_SMOOTH,
        "seconds": round(time.time() - t0, 1),
        "dreamed": dreamed,
        "dreamed_verdicts": verdicts,
        "real": real,
        "growth": growth,
        "train_circuits": int(meta["n"] - meta["n_test"]),
        "figure8_share_data": meta["figure8_share"],
    }
    text = json.dumps(result)
    for path in [Path(out)] + ([Path(web) / "trackgen.json"] if web else []):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if figures:
        from dreamcircuit.trackgen.figures import write_figures

        write_figures(model, dev, result, figures)
    return result
