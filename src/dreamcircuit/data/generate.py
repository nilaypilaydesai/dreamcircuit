"""Parallel dataset generation.

Each worker owns one procedurally generated track and drives ``cars_per_track`` cars with the
:class:`~dreamcircuit.sim.drivers.MixedDriver` population for ``steps`` frames, writing straight
into shared ``.npy`` memmaps:

    frames.npy    (E, T+1, 64, 64, 3) uint8   ego-camera frames
    actions.npy   (E, T, 2)          float32  [steer, pedal] applied after frame t
    states.npy    (E, T+1, 7)        float32  vehicle state (see sim.vehicle)
    features.npy  (E, T+1, F)        float32  privileged features (see sim.env.FEATURES)
    meta.json                                 config, track seeds, split

Train and test splits use disjoint track seeds, so evaluation measures generalization to circuits
the world model has never seen.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from tqdm import tqdm

from dreamcircuit.config import DEFAULT
from dreamcircuit.sim.drivers import MixedDriver
from dreamcircuit.sim.env import FEATURES, RaceEnv
from dreamcircuit.sim.track import generate_track
from dreamcircuit.sim.vehicle import STATE_DIM

SPLIT_SEED_OFFSET = {"train": 0, "test": 1_000_000}


@dataclass(frozen=True)
class GenSpec:
    root: Path
    split: str
    n_tracks: int
    cars_per_track: int
    steps: int
    seed: int = 0

    @property
    def n_episodes(self) -> int:
        return self.n_tracks * self.cars_per_track

    def track_seed(self, i: int) -> int:
        return self.seed + SPLIT_SEED_OFFSET[self.split] + i


def _paths(root: Path) -> dict[str, Path]:
    return {k: root / f"{k}.npy" for k in ("frames", "actions", "states", "features")}


def _worker(args: tuple[GenSpec, int]) -> tuple[int, float]:
    spec, i = args
    track_seed = spec.track_seed(i)
    track = generate_track(track_seed, DEFAULT.track)
    rng = np.random.default_rng(track_seed + 17)
    n, t = spec.cars_per_track, spec.steps
    env = RaceEnv(track, n)
    # A fifth of the cars start from standstill so the model learns launches.
    obs = env.reset(rng)
    standing = rng.random(n) < 0.2
    env.state[standing, 3] = 0.0
    obs = env.render()
    driver = MixedDriver(env, rng)

    frames = np.empty((n, t + 1, *obs.shape[1:]), dtype=np.uint8)
    actions = np.empty((n, t, 2), dtype=np.float32)
    states = np.empty((n, t + 1, STATE_DIM), dtype=np.float32)
    feats = np.empty((n, t + 1, len(FEATURES)), dtype=np.float32)
    frames[:, 0], states[:, 0], feats[:, 0] = obs, env.state, env.features()
    grass = 0.0
    for k in range(t):
        a = driver.act()
        obs = env.step(a)
        frames[:, k + 1], actions[:, k] = obs, a
        states[:, k + 1], feats[:, k + 1] = env.state, env.features()
        grass += float(env.tf.on_grass.mean())

    sl = slice(i * n, (i + 1) * n)
    p = _paths(spec.root)
    for key, arr in (
        ("frames", frames),
        ("actions", actions),
        ("states", states),
        ("features", feats),
    ):
        mm = np.load(p[key], mmap_mode="r+")
        mm[sl] = arr
        mm.flush()
        del mm
    return track_seed, grass / t


def generate_dataset(spec: GenSpec, workers: int = 8) -> dict:
    spec.root.mkdir(parents=True, exist_ok=True)
    cfg = DEFAULT
    e, t, s = spec.n_episodes, spec.steps, cfg.render.size
    shapes = {
        "frames": ((e, t + 1, s, s, 3), np.uint8),
        "actions": ((e, t, 2), np.float32),
        "states": ((e, t + 1, STATE_DIM), np.float32),
        "features": ((e, t + 1, len(FEATURES)), np.float32),
    }
    for key, (shape, dtype) in shapes.items():
        np.lib.format.open_memmap(
            _paths(spec.root)[key], mode="w+", dtype=dtype, shape=shape
        ).flush()

    t0 = time.time()
    seeds, grass = [], []
    jobs = [(spec, i) for i in range(spec.n_tracks)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for track_seed, g in tqdm(
            pool.map(_worker, jobs), total=len(jobs), desc=f"generating {spec.split}"
        ):
            seeds.append(track_seed)
            grass.append(g)
    meta = {
        "split": spec.split,
        "n_tracks": spec.n_tracks,
        "cars_per_track": spec.cars_per_track,
        "steps": spec.steps,
        "n_episodes": e,
        "n_frames": e * (t + 1),
        "track_seeds": seeds,
        "features": list(FEATURES),
        "grass_fraction": float(np.mean(grass)),
        "seconds": round(time.time() - t0, 1),
        "sim_config": cfg.to_dict(),
    }
    (spec.root / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta
