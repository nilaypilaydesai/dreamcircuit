"""A dataset of circuits as polar radius profiles, for the track diffusion model.

    dreamcircuit trackgen-data --n 60000

Circuits come from the same procedural generator the simulator uses (geometry only, no
texture), so every training example satisfies the drivability constraints. Each is stored as
N_ANGLES radii with the start/finish line at theta = 0, running counter-clockwise.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from dreamcircuit.config import DEFAULT
from dreamcircuit.sim.track import sample_valid_centerline
from dreamcircuit.trackgen.polar import N_ANGLES, to_polar

SEED_OFFSET = 5_000_000  # disjoint from the world model's circuit seeds


def _worker(args: tuple[int, int]) -> np.ndarray:
    start, count = args
    out = []
    for seed in range(start, start + count):
        rng = np.random.default_rng(SEED_OFFSET + seed)
        r = to_polar(sample_valid_centerline(rng, DEFAULT.track), N_ANGLES)
        if r is not None:
            out.append(r)
    return np.array(out, dtype=np.float32)


def build(out: Path, n: int, workers: int = 10, chunk: int = 500) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    jobs = [(s, min(chunk, n - s)) for s in range(0, n, chunk)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        parts = list(pool.map(_worker, jobs))
    radii = np.concatenate(parts)
    rng = np.random.default_rng(0)
    order = rng.permutation(len(radii))
    radii = radii[order]
    n_test = max(len(radii) // 20, 100)
    np.save(out / "train.npy", radii[n_test:])
    np.save(out / "test.npy", radii[:n_test])
    meta = {
        "n": len(radii),
        "n_test": int(n_test),
        "n_angles": N_ANGLES,
        "seconds": round(time.time() - t0, 1),
        "mean": float(radii.mean()),
        "std": float(radii.std()),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta
