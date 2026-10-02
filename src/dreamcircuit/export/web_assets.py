"""Export everything the browser needs besides the networks.

web/public/assets/sim_config.json   physics + rendering constants (single source of truth)
web/public/assets/sprite.json       the exact car sprite the renderer composites
web/public/assets/tracks/*.{json,png}  held-out circuits (test-split seeds, never trained on)
web/tests/fixtures/golden.json      reference trajectories + frames for the TS parity tests
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.generate import SPLIT_SEED_OFFSET
from dreamcircuit.model.edm import EDMConfig, karras_sigmas
from dreamcircuit.sim.drivers import MixedDriver
from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.render import car_sprite
from dreamcircuit.sim.track import generate_track


def export_sprite(path: Path) -> None:
    rgb, alpha = car_sprite(DEFAULT.render)
    a = alpha[..., 0]
    idx = np.flatnonzero(a > 0)
    flat_rgb = rgb.reshape(-1, 3)
    entries = [[int(i), *flat_rgb[i].tolist(), float(a.flat[i])] for i in idx]
    path.write_text(json.dumps({"size": DEFAULT.render.size, "pixels": entries}))


def export_tracks(out: Path, n: int = 6, seed: int = 0) -> list[dict]:
    """Circuits from the *test* split: the browser only ever shows tracks the model never saw."""
    tracks = []
    for i in range(n):
        s = seed + SPLIT_SEED_OFFSET["test"] + 500 + i
        tr = generate_track(s, DEFAULT.track)
        stem = out / f"track_{i:02d}"
        tr.save(stem)
        tracks.append({"id": f"track_{i:02d}", "seed": s, "length_m": round(tr.length, 1)})
    (out / "index.json").write_text(json.dumps(tracks, indent=2))
    return tracks


def export_golden(path: Path, track_dir: Path, steps: int = 90, cars: int = 3) -> None:
    """Drive a few cars with the mixed driver population on track_00 and record everything."""
    meta = json.loads((track_dir / "index.json").read_text())[0]
    tr = generate_track(meta["seed"], DEFAULT.track)
    rng = np.random.default_rng(7)
    env = RaceEnv(tr, cars)
    env.reset(rng, speed=(0.0, 15.0))
    driver = MixedDriver(env, rng)
    init = env.state.copy()
    states, actions, idx, frames = [env.state.copy()], [], [env.idx.copy()], [env.render()]
    for _ in range(steps):
        a = driver.act()
        env.step(a)
        actions.append(a)
        states.append(env.state.copy())
        idx.append(env.idx.copy())
        frames.append(env.render())
    keep = list(range(0, steps + 1, 15))
    edm = EDMConfig()
    golden = {
        "track": meta["id"],
        "init_state": init.tolist(),
        "init_idx": idx[0].tolist(),
        "actions": np.stack(actions).tolist(),  # (T, n, 2)
        "states": np.stack(states).tolist(),  # (T+1, n, 7)
        "idx": np.stack(idx).tolist(),
        "frame_steps": keep,
        "edm": {"sigma_min": edm.sigma_min, "sigma_max": edm.sigma_max, "rho": edm.rho},
        "sigmas": {str(n): karras_sigmas(n, edm).tolist() for n in (1, 2, 3, 4)},
        "frames": {
            str(k): [base64.b64encode(frames[k][c].tobytes()).decode() for c in range(cars)]
            for k in keep
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(golden))


def export_web_assets(web_dir: Path, n_tracks: int = 6) -> dict:
    assets = web_dir / "public" / "assets"
    (assets / "tracks").mkdir(parents=True, exist_ok=True)
    (assets / "sim_config.json").write_text(json.dumps(DEFAULT.to_dict(), indent=2))
    export_sprite(assets / "sprite.json")
    tracks = export_tracks(assets / "tracks", n_tracks)
    export_golden(web_dir / "tests" / "fixtures" / "golden.json", assets / "tracks")
    return {"tracks": tracks}
