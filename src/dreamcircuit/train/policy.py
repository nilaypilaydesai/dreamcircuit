"""Train the pixel autopilot.

    dreamcircuit train-policy

1. Relabel: for every frame of the dataset, ask the privileged expert what it would do there.
   The mixed drivers visited plenty of bad states (slides, grass, wrong angles), so the student
   learns recoveries, not just the racing line.
2. Behaviour cloning from 4-frame pixel stacks, with input noise so it tolerates the slightly
   softer frames of the dream.
3. DAgger: roll the student out in the simulator, relabel the states *it* visits, retrain.
4. Closed-loop evaluation on held-out circuits against the expert it was distilled from.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import torch

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.dataset import EpisodeStore, to_tensor
from dreamcircuit.model.policy import PixelPolicy, policy_loss
from dreamcircuit.sim.drivers import expert_action
from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.track import generate_track
from dreamcircuit.train.common import cosine_lr, pick_device, save_checkpoint

TEACHER_AGGRESSION = 0.8
FRAMES = 4


def _relabel_track(args: tuple[str, int]) -> tuple[int, np.ndarray]:
    root, i = args
    store = EpisodeStore(root)
    c = store.meta["cars_per_track"]
    track = generate_track(store.meta["track_seeds"][i], DEFAULT.track)
    env = RaceEnv(track, c)
    states = np.asarray(store.states[i * c : (i + 1) * c], dtype=np.float64)
    labels = np.empty((c, states.shape[1], 2), dtype=np.float32)
    for t in range(states.shape[1]):
        env.set_state(states[:, t])
        labels[:, t] = expert_action(env, TEACHER_AGGRESSION, 0.0)
    return i, labels


def relabel(root: str | Path, workers: int = 10) -> np.ndarray:
    root = str(root)
    path = Path(root) / "labels.npy"
    if path.exists():
        return np.load(path)
    store = EpisodeStore(root)
    out = np.empty((store.n_episodes, store.n_frames, 2), dtype=np.float32)
    c = store.meta["cars_per_track"]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for i, lab in pool.map(_relabel_track, [(root, i) for i in range(store.meta["n_tracks"])]):
            out[i * c : (i + 1) * c] = lab
    np.save(path, out)
    return out


def _stack(frames: np.ndarray) -> np.ndarray:
    """(..., 4, H, W, 3) uint8 -> (..., 12, H, W) channel stack, oldest first."""
    f = np.moveaxis(frames, -1, -3)  # (..., 4, 3, H, W)
    return f.reshape(*f.shape[:-4], -1, *f.shape[-2:])


def _to_input(frames_u8: np.ndarray, device: torch.device) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(_stack(frames_u8))).to(device).float() / 127.5 - 1


@torch.no_grad()
def drive(
    policy: PixelPolicy | None,
    seeds: list[int],
    cars: int = 4,
    seconds: float = 45.0,
    device: torch.device | str = "cpu",
    record: bool = False,
    noise: float = 0.0,
    seed: int = 0,
) -> dict:
    """Closed-loop driving on the given circuits. ``policy=None`` drives the expert itself."""
    rng = np.random.default_rng(seed)
    steps = int(seconds / DEFAULT.dt)
    laps, grass, speed = [], [], []
    rec_frames, rec_labels = [], []
    for s in seeds:
        env = RaceEnv(generate_track(s, DEFAULT.track), cars)
        obs = env.reset(rng, speed=(4.0, 12.0), lateral_frac=0.3, heading_noise=0.05)
        hist = np.repeat(obs[:, None], FRAMES, axis=1)
        g = np.zeros(cars)
        for _ in range(steps):
            teacher = expert_action(env, TEACHER_AGGRESSION, 0.0)
            if policy is None:
                a = teacher
            else:
                a = policy(_to_input(hist, torch.device(device))).cpu().numpy().astype(np.float64)
                a = np.clip(a + noise * rng.normal(size=a.shape), -1, 1)
            if record:
                rec_frames.append(hist.copy())
                rec_labels.append(teacher.astype(np.float32))
            obs = env.step(a)
            hist = np.concatenate([hist[:, 1:], obs[:, None]], axis=1)
            g += env.tf.on_grass
        laps.append(env.progress / env.track.length)
        grass.append(g / steps)
        speed.append(env.progress / seconds)
    out: dict[str, Any] = {
        "laps_per_min": float(np.mean(laps) * 60.0 / seconds),
        "grass_fraction": float(np.mean(grass)),
        "avg_speed": float(np.mean(speed)),
    }
    if record:
        out["frames"] = np.concatenate(rec_frames)
        out["labels"] = np.concatenate(rec_labels)
    return out


def train_policy(
    data: str = "data/train",
    test: str = "data/test",
    out: str = "runs/policy",
    bc_steps: int = 5000,
    dagger_steps: int = 2500,
    batch: int = 256,
    lr: float = 3e-4,
    device: str = "cpu",
    seed: int = 0,
) -> dict:
    t0 = time.time()
    run = Path(out)
    run.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    dev = pick_device(device)
    store = EpisodeStore(data)
    labels = relabel(data)
    print(
        f"relabelled {labels.shape[0] * labels.shape[1]:,} frames in {time.time() - t0:.0f}s",
        flush=True,
    )

    model = PixelPolicy(FRAMES).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    test_seeds = EpisodeStore(test).meta["track_seeds"][:8]
    train_seeds = store.meta["track_seeds"]
    extra_frames: np.ndarray | None = None
    extra_labels: np.ndarray | None = None
    history = []

    def batch_from_dataset(b: int) -> tuple[np.ndarray, np.ndarray]:
        e = rng.integers(0, store.n_episodes, b)
        t = rng.integers(FRAMES - 1, store.n_frames, b)
        idx = t[:, None] + np.arange(-FRAMES + 1, 1)[None, :]
        return store.frames[e[:, None], idx], labels[e, t]

    total = bc_steps + dagger_steps
    for step in range(total):
        if step == bc_steps:
            res = drive(
                model.eval(),
                train_seeds[:40],
                cars=8,
                seconds=16.0,
                device=dev,
                record=True,
                noise=0.15,
                seed=seed + 1,
            )
            extra_frames, extra_labels = res["frames"], res["labels"]
            print(f"DAgger: collected {len(extra_labels):,} on-policy states", flush=True)
            model.train()
        if extra_frames is not None and step % 2 == 1:
            assert extra_labels is not None
            j = rng.integers(0, len(extra_labels), batch)
            frames, target = extra_frames[j], extra_labels[j]
        else:
            frames, target = batch_from_dataset(batch)
        x = _to_input(frames, dev)
        x = x + torch.rand(batch, 1, 1, 1, device=dev) * 0.08 * torch.randn_like(x)
        for g in opt.param_groups:
            g["lr"] = cosine_lr(step, lr, 200, total, floor=0.1)
        loss = policy_loss(model(x), torch.from_numpy(target).to(dev))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        if (step + 1) % 250 == 0:
            print(f"policy step {step + 1}/{total} loss {loss.item():.4f}", flush=True)
        if (step + 1) in (bc_steps, total):
            ev = drive(model.eval(), test_seeds, device=dev)
            ev["step"] = step + 1
            history.append(ev)
            print("eval (held-out circuits)", json.dumps(ev), flush=True)
            model.train()

    teacher = drive(None, test_seeds)
    result = {
        "student": history[-1],
        "student_bc_only": history[0],
        "teacher": teacher,
        "teacher_aggression": TEACHER_AGGRESSION,
        "params": sum(p.numel() for p in model.parameters()),
        "seconds": round(time.time() - t0, 1),
    }
    save_checkpoint(run / "policy.pt", model=model.state_dict(), result=result)
    (run / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return result


def load_policy(path: str | Path) -> PixelPolicy:
    ck = torch.load(path, map_location="cpu", weights_only=False)
    m = PixelPolicy(FRAMES)
    m.load_state_dict(ck["model"])
    return m.eval()


__all__ = ["drive", "load_policy", "relabel", "to_tensor", "train_policy"]
