"""Train the circuit designer and measure how often it builds a proper circuit.

    dreamcircuit train-tracks

"Proper" means the same constraints the procedural generator enforces (corner radius, grass
between distant stretches, lap length), checked on the reconstructed centerline. Two numbers
are reported on held-out conditions:

- whole-circuit validity: dream a complete circuit from nothing;
- live validity: generate it the way the game does, arc by arc ahead of the karts, then close
  the loop, with the game's retry rule (resample an arc that fails, up to 3 times).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch

from dreamcircuit.config import DEFAULT
from dreamcircuit.sim.track import _resample_closed, _smooth_closed
from dreamcircuit.trackgen.model import TrackDenoiser, TrackModelConfig
from dreamcircuit.trackgen.polar import N_ANGLES, check, destandardize, from_polar, standardize
from dreamcircuit.train.common import EMA, cosine_lr, pick_device, save_checkpoint

# Live generation schedule, mirrored by the browser (web/src/game/trackgen.ts).
INITIAL_KNOWN = (-12, 24)  # the start grid and first stretch, generated before the countdown
CHUNK = 16  # angles generated per step during lap 1
SMOOTH_M = 1.5
SAMPLER_STEPS = 24  # Heun steps per arc (47 network calls)
ARC_SMOOTH = 1.0  # Gaussian smoothing of newly generated radii, in angle samples


def smooth_arc(u: np.ndarray, arc: np.ndarray, sigma: float = ARC_SMOOTH) -> np.ndarray:
    """Circular Gaussian smoothing applied only to the samples in ``arc``; everything else
    (road that already exists) is left untouched. Irons out the small high-frequency wiggles
    that make a sampled corner a little too tight."""
    k = np.arange(-3, 4)
    w = np.exp(-0.5 * (k / sigma) ** 2)
    w /= w.sum()
    sm = sum(wi * np.roll(u, -ki) for wi, ki in zip(w, k, strict=True))
    out = u.copy()
    out[arc] = sm[arc]
    return out


def reconstruct(r: np.ndarray) -> np.ndarray:
    """Polar profile (meters) -> smoothed dense centerline, as in the game."""
    c = from_polar(r)
    return _resample_closed(_smooth_closed(c, SMOOTH_M / DEFAULT.track.ds), DEFAULT.track.ds)


def random_masks(b: int, n: int, rng: np.random.Generator) -> np.ndarray:
    """Known arcs: 20% none (dream a whole circuit), else one random contiguous arc."""
    m = np.zeros((b, n), dtype=np.float32)
    for i in range(b):
        if rng.random() < 0.2:
            continue
        length = int(rng.integers(6, n - 6))
        start = int(rng.integers(0, n))
        m[i, (start + np.arange(length)) % n] = 1.0
    return m


def live_arcs(n: int = N_ANGLES) -> list[np.ndarray]:
    """The order in which the game builds a circuit: the start grid and first stretch, then
    CHUNK-sized arcs around the lap until the loop closes."""
    a, b = INITIAL_KNOWN
    arcs = [np.arange(a, b) % n]
    pos = b
    while pos < n + a:
        arcs.append(np.arange(pos, min(pos + CHUNK, n + a)) % n)
        pos += CHUNK
    return arcs


def live_generate(
    model: TrackDenoiser,
    device: torch.device,
    rng: np.random.Generator,
    steps: int = SAMPLER_STEPS,
    retries: int = 3,
    trace: list[dict] | None = None,
) -> tuple[np.ndarray, int]:
    """The game's lap-1 procedure. Returns the radii (meters) and how many arcs were retried.

    With ``trace``, appends one snapshot per built arc: the arc, the road known so far and the
    designer's guess for the whole circuit at that moment (radii in meters)."""
    n = model.cfg.n
    known = np.zeros(n, dtype=np.float32)
    mask = np.zeros(n, dtype=np.float32)
    retried = 0
    for arc in live_arcs(n):
        for attempt in range(retries + 1):
            g = torch.Generator().manual_seed(int(rng.integers(1 << 31)))
            m = torch.from_numpy(mask)[None, None].to(device)
            kn = torch.from_numpy(known)[None, None].to(device)
            raw = model.sample(m, kn, steps=steps, generator=g)[0, 0].cpu().numpy()
            out = smooth_arc(raw, arc)
            cand_known, cand_mask = known.copy(), mask.copy()
            cand_known[arc] = out[arc]
            cand_mask[arc] = 1.0
            # Check the arc in context: fill the still-unknown rest with this sample's guess.
            full = np.where(cand_mask > 0, cand_known, out)
            ok = check(reconstruct(destandardize(full)), DEFAULT.track).ok
            if ok or attempt == retries:
                if not ok:  # last resort, as in the game: iron out the wiggle and keep racing
                    cand_known[arc] = smooth_arc(raw, arc, 2.0)[arc]
                    full = np.where(cand_mask > 0, cand_known, out)
                known, mask = cand_known, cand_mask
                break
            retried += 1
        if trace is not None:
            trace.append(
                {
                    "arc": arc,
                    "mask": mask.copy(),
                    "known": destandardize(known),
                    "guess": destandardize(full),
                }
            )
    return destandardize(known), retried


@torch.no_grad()
def evaluate(
    model: TrackDenoiser,
    device: torch.device,
    n: int = 200,
    seed: int = 1,
    n_live: int | None = None,
) -> dict:
    """Validity of ``n`` whole circuits (one batch) and ``n_live`` circuits built live, arc by arc
    (default ``n // 4``)."""
    rng = np.random.default_rng(seed)
    model.eval()
    whole = 0
    reasons: dict[str, int] = {}
    g = torch.Generator().manual_seed(seed)
    zeros = torch.zeros(n, 1, model.cfg.n, device=device)
    raw = model.sample(zeros, zeros, steps=SAMPLER_STEPS, generator=g)[:, 0].cpu().numpy()
    every = np.arange(model.cfg.n)
    samples = destandardize(np.stack([smooth_arc(u, every) for u in raw]))
    whole_raw = sum(check(reconstruct(destandardize(u)), DEFAULT.track).ok for u in raw)
    lengths = []
    for r in samples:
        v = check(reconstruct(r), DEFAULT.track)
        whole += v.ok
        lengths.append(v.length)
        if not v.ok:
            reasons[v.reason] = reasons.get(v.reason, 0) + 1
    live_ok, retried = 0, 0
    n_live = n // 4 if n_live is None else n_live
    threads = torch.get_num_threads()
    if device.type == "cpu":
        torch.set_num_threads(1)  # a long chain of batch-1 calls: extra threads only add overhead
    try:
        for _ in range(n_live):
            r, k = live_generate(model, device, rng)
            live_ok += check(reconstruct(r), DEFAULT.track).ok
            retried += k
    finally:
        torch.set_num_threads(threads)
    model.train()
    return {
        "whole_valid": whole / n,
        "whole_valid_unsmoothed": whole_raw / n,
        "whole_fail_reasons": reasons,
        "live_valid": live_ok / n_live,
        "live_retries_per_circuit": retried / n_live,
        "mean_length_m": float(np.mean(lengths)),
    }


def train_tracks(
    data: str = "data/tracks",
    out: str = "runs/trackgen",
    steps: int = 8000,
    batch: int = 256,
    lr: float = 3e-4,
    device_name: str = "auto",
    channels: tuple[int, ...] = (32, 64, 128),
    seed: int = 0,
    init: str | None = None,
) -> dict:
    dev = pick_device(device_name)
    run = Path(out)
    run.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    radii = np.load(Path(data) / "train.npy")
    x_all = torch.from_numpy(standardize(radii).astype(np.float32))
    cfg = TrackModelConfig(n=N_ANGLES, channels=channels)
    model = TrackDenoiser(cfg).to(dev)
    if init:  # continue from earlier weights with a fresh learning-rate schedule
        model.load_state_dict(torch.load(init, map_location="cpu", weights_only=False)["ema"])
    ema = EMA(model, 0.999)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    log = []
    t0 = time.time()
    for step in range(steps):
        idx = rng.integers(0, len(x_all), batch)
        x = x_all[idx].clone()
        flip = torch.from_numpy(rng.random(batch) < 0.5)
        rev = torch.roll(torch.flip(x, dims=[1]), 1, dims=1)  # the same lap driven backwards
        x[flip] = rev[flip]
        x = x[:, None].to(dev)
        mask = torch.from_numpy(random_masks(batch, cfg.n, rng))[:, None].to(dev)
        for gp in opt.param_groups:
            gp["lr"] = cosine_lr(step, lr, 300, steps, floor=0.05)
        loss = model.loss(x, mask)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        ema.update(model, step)
        if (step + 1) % 250 == 0:
            print(
                f"track step {step + 1}/{steps} loss {loss.item():.4f} "
                f"({(step + 1) / (time.time() - t0):.1f} it/s)",
                flush=True,
            )
        if (step + 1) % 2000 == 0 or step + 1 == steps:
            ev = evaluate(ema.model, dev, n=120 if step + 1 < steps else 400)  # type: ignore[arg-type]
            ev["step"] = step + 1
            log.append(ev)
            print("eval", json.dumps(ev), flush=True)
            save_checkpoint(
                run / "trackgen.pt",
                ema=ema.model.state_dict(),
                config=cfg.__dict__,
                step=step + 1,
                evals=log,
            )
    result = {
        "evals": log,
        "params": sum(p.numel() for p in model.parameters()),
        "seconds": round(time.time() - t0, 1),
        "train_circuits": len(radii),
    }
    (run / "result.json").write_text(json.dumps(result, indent=2))
    return result


def load_track_model(path: str | Path, device: torch.device | str = "cpu") -> TrackDenoiser:
    ck = torch.load(path, map_location="cpu", weights_only=False)
    cfg = dict(ck["config"])
    cfg["channels"] = tuple(cfg["channels"])
    m = TrackDenoiser(TrackModelConfig(**cfg))
    m.load_state_dict(ck["ema"])
    return m.to(device).eval()


def evaluate_designer(
    checkpoint: str | Path,
    out: str | Path = "results/trackgen.json",
    n_whole: int = 1000,
    n_live: int = 200,
    device_name: str = "cpu",
    data: str = "data/tracks",
    web: str | Path | None = "web/public/results",
    figures: str | Path | None = "docs/assets",
) -> dict:
    """The published numbers: validity at scale, plus circuits for the DATA page gallery.

    Runs on the CPU by default: the 1-D model is tiny, and live generation is a long chain of
    batch-1 calls that a GPU (especially one that is busy training) does not speed up."""
    dev = pick_device(device_name)
    model = load_track_model(checkpoint, dev)
    t0 = time.time()
    ev = evaluate(model, dev, n=n_whole, n_live=n_live)
    g = torch.Generator().manual_seed(2026)
    zeros = torch.zeros(24, 1, model.cfg.n, device=dev)
    u = model.sample(zeros, zeros, steps=SAMPLER_STEPS, generator=g)[:, 0].cpu().numpy()
    every = np.arange(model.cfg.n)
    dreamed = [destandardize(smooth_arc(x, every)).round(2).tolist() for x in u]
    real = np.load(Path(data) / "test.npy")[:12].round(2).tolist()
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
        "real": real,
    }
    text = json.dumps(result)
    for path in [Path(out)] + ([Path(web) / "trackgen.json"] if web else []):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if figures:
        from dreamcircuit.trackgen.figures import write_figures

        write_figures(model, dev, result, figures)
    return result
