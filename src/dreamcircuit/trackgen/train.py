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


def live_generate(
    model: TrackDenoiser,
    device: torch.device,
    rng: np.random.Generator,
    steps: int = 12,
    retries: int = 3,
) -> tuple[np.ndarray, int]:
    """The game's lap-1 procedure. Returns the radii (meters) and how many arcs were retried."""
    n = model.cfg.n
    known = np.zeros(n, dtype=np.float32)
    mask = np.zeros(n, dtype=np.float32)
    a, b = INITIAL_KNOWN
    arcs = [np.arange(a, b) % n]
    pos = b
    while pos < n + a:
        arcs.append(np.arange(pos, min(pos + CHUNK, n + a)) % n)
        pos += CHUNK
    retried = 0
    for k, arc in enumerate(arcs):
        last = k == len(arcs) - 1
        for attempt in range(retries + 1):
            g = torch.Generator().manual_seed(int(rng.integers(1 << 31)))
            m = torch.from_numpy(mask)[None, None].to(device)
            kn = torch.from_numpy(known)[None, None].to(device)
            out = model.sample(m, kn, steps=steps, generator=g)[0, 0].cpu().numpy()
            cand_known, cand_mask = known.copy(), mask.copy()
            cand_known[arc] = out[arc]
            cand_mask[arc] = 1.0
            # Check the arc in context: fill the still-unknown rest with this sample's guess.
            full = np.where(cand_mask > 0, cand_known, out)
            if check(reconstruct(destandardize(full)), DEFAULT.track).ok or attempt == retries:
                known, mask = cand_known, cand_mask
                break
            retried += 1
        if last:
            break
    return destandardize(known), retried


@torch.no_grad()
def evaluate(model: TrackDenoiser, device: torch.device, n: int = 200, seed: int = 1) -> dict:
    rng = np.random.default_rng(seed)
    model.eval()
    whole = 0
    reasons: dict[str, int] = {}
    g = torch.Generator().manual_seed(seed)
    zeros = torch.zeros(n, 1, model.cfg.n, device=device)
    samples = destandardize(model.sample(zeros, zeros, steps=12, generator=g)[:, 0].cpu().numpy())
    lengths = []
    for r in samples:
        v = check(reconstruct(r), DEFAULT.track)
        whole += v.ok
        lengths.append(v.length)
        if not v.ok:
            reasons[v.reason] = reasons.get(v.reason, 0) + 1
    live_ok, retried = 0, 0
    n_live = n // 4
    for _ in range(n_live):
        r, k = live_generate(model, device, rng)
        live_ok += check(reconstruct(r), DEFAULT.track).ok
        retried += k
    model.train()
    return {
        "whole_valid": whole / n,
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
