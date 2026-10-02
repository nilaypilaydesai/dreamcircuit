"""The circuit designer's training set: architect circuits as 256 points along the road.

    dreamcircuit trackgen-data --n 70000

Each circuit is stored as N_POINTS (x, y) points evenly spaced along the lap, starting at the
start line with the car heading +x, in model meters; with its curvature at those points (the
style signal is computed from it) and its topology (0 = plain loop, 1 = figure-eight).
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from dreamcircuit.trackgen import architect as A

N_POINTS = 256
FIGURE8_SHARE = 0.35
SEED_OFFSET = 7_000_000  # disjoint from every other generator seed in the project


def encode(dense: np.ndarray, n: int = N_POINTS) -> tuple[np.ndarray, np.ndarray]:
    """Dense centerline (DS spacing, start at 0) -> (n, 2) points and their curvature."""
    kap = A.curvature(dense)
    w = np.exp(-0.5 * (np.arange(-8, 9) / 4.0) ** 2)  # ~2 m smoothing before sub-sampling
    w /= w.sum()
    kap_s = np.convolve(np.concatenate([kap[-8:], kap, kap[:8]]), w, mode="valid")
    idx = np.round(np.arange(n) * (len(dense) / n)).astype(int) % len(dense)
    return A.resample(dense, n).astype(np.float32), kap_s[idx].astype(np.float32)


def lap_lengths(pts: np.ndarray) -> np.ndarray:
    """Lap length (m) of each (B, N, 2) circuit."""
    seg = np.roll(pts, -1, axis=1) - pts
    return np.hypot(seg[..., 0], seg[..., 1]).sum(axis=1)


def _worker(args: tuple[int, int]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    start, count = args
    pts, kaps, topo = [], [], []
    for seed in range(start, start + count):
        rng = np.random.default_rng(SEED_OFFSET + seed)
        t = 1 if rng.random() < FIGURE8_SHARE else 0
        dense = A.generate(rng, A.TOPOLOGIES[t])
        if dense is None:
            continue
        p, k = encode(dense)
        pts.append(p)
        kaps.append(k)
        topo.append(t)
    return np.array(pts), np.array(kaps), np.array(topo, dtype=np.int8)


def build(out: Path, n: int, workers: int = 10, chunk: int = 250) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    jobs = [(s, min(chunk, n - s)) for s in range(0, n, chunk)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        parts = [p for p in pool.map(_worker, jobs) if len(p[0])]
    pts = np.concatenate([p[0] for p in parts])
    kap = np.concatenate([p[1] for p in parts])
    topo = np.concatenate([p[2] for p in parts])
    order = np.random.default_rng(0).permutation(len(pts))
    pts, kap, topo = pts[order], kap[order], topo[order]
    n_test = max(len(pts) // 20, 100)
    for split, sl in (("test", slice(0, n_test)), ("train", slice(n_test, None))):
        np.save(out / f"{split}_points.npy", pts[sl])
        np.save(out / f"{split}_kappa.npy", kap[sl])
        np.save(out / f"{split}_topology.npy", topo[sl])
    meta = {
        "n": len(pts),
        "n_test": int(n_test),
        "n_points": N_POINTS,
        "figure8_share": float(topo.mean()),
        "seconds": round(time.time() - t0, 1),
        "coord_std": float(pts.std()),
        "mean_length_m": float(lap_lengths(pts).mean()),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta
