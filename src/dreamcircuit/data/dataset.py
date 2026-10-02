"""Random-access window sampling from the memmapped dataset, with background prefetching.

A training example is a window of L+1 consecutive frames and the L actions between them:
frames o_{k-L+1..k} are context, a_{k-L+1..k} the actions, and o_{k+1} is the target.
"""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path

import numpy as np
import torch


class EpisodeStore:
    """Read-only view of a generated split (see :mod:`dreamcircuit.data.generate`)."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.meta = json.loads((self.root / "meta.json").read_text())
        self.frames = np.load(self.root / "frames.npy", mmap_mode="r")
        self.actions = np.load(self.root / "actions.npy", mmap_mode="r")
        self.states = np.load(self.root / "states.npy", mmap_mode="r")
        self.features = np.load(self.root / "features.npy", mmap_mode="r")
        self.n_episodes, self.n_frames = self.frames.shape[:2]

    def feature_index(self, name: str) -> int:
        return self.meta["features"].index(name)


def to_tensor(frames: np.ndarray, device: torch.device | str) -> torch.Tensor:
    """uint8 (..., H, W, 3) -> float (..., 3, H, W) in [-1, 1] on ``device``."""
    t = torch.from_numpy(np.ascontiguousarray(frames)).to(device)
    return t.movedim(-1, -3).float().div_(127.5).sub_(1.0)


def to_uint8(x: torch.Tensor) -> np.ndarray:
    """float (..., 3, H, W) in [-1, 1] -> uint8 (..., H, W, 3)."""
    y = ((x.clamp(-1, 1) + 1.0) * 127.5).round().to(torch.uint8)
    return y.movedim(-3, -1).cpu().numpy()


class WindowSampler:
    def __init__(
        self,
        store: EpisodeStore,
        context: int,
        batch_size: int,
        seed: int = 0,
        episodes: np.ndarray | None = None,
    ):
        self.store, self.l, self.b = store, context, batch_size
        self.rng = np.random.default_rng(seed)
        self.episodes = np.arange(store.n_episodes) if episodes is None else episodes
        self.max_start = store.n_frames - (context + 1)

    def sample_numpy(self) -> tuple[np.ndarray, np.ndarray]:
        e = self.rng.choice(self.episodes, self.b)
        w = self.rng.integers(0, self.max_start + 1, self.b)
        order = np.lexsort((w, e))  # sorted reads are friendlier to the page cache
        e, w = e[order], w[order]
        t = w[:, None] + np.arange(self.l + 1)[None, :]
        frames = self.store.frames[e[:, None], t]  # (B, L+1, H, W, 3)
        actions = self.store.actions[e[:, None], t[:, :-1]]  # (B, L, 2)
        return frames, np.asarray(actions, dtype=np.float32)


class Prefetcher:
    """Runs a sampler in a background thread so disk reads overlap GPU compute."""

    def __init__(self, sampler: WindowSampler, depth: int = 6):
        self.sampler = sampler
        self.q: queue.Queue = queue.Queue(maxsize=depth)
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            self.q.put(self.sampler.sample_numpy())

    def next(self) -> tuple[np.ndarray, np.ndarray]:
        return self.q.get()

    def close(self) -> None:
        self._stop.set()
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass
