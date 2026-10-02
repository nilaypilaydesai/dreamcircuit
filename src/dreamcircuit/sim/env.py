"""Vectorized racing environment: ``n`` independent cars on one track, each with an ego camera."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from dreamcircuit.config import DEFAULT, SimConfig
from dreamcircuit.sim.render import EgoRenderer
from dreamcircuit.sim.track import Track
from dreamcircuit.sim.vehicle import PSI, STATE_DIM, VX, X, Y, step_vehicle

#: Privileged per-frame features logged alongside every frame (used by probes and the audit).
FEATURES = (
    "speed",
    "lateral_speed",
    "yaw_rate",
    "steer",
    "offset",
    "heading_error",
    "curvature_0",
    "curvature_10",
    "curvature_20",
    "curvature_30",
    "on_grass",
    "progress",
)


@dataclass
class TrackFrame:
    idx: np.ndarray  # nearest centerline index
    offset: np.ndarray  # signed lateral offset from the centerline (m, + = left)
    heading_error: np.ndarray  # car heading minus track heading (rad)
    on_grass: np.ndarray  # bool


def wrap_angle(a: np.ndarray) -> np.ndarray:
    return (a + np.pi) % (2 * np.pi) - np.pi


class RaceEnv:
    def __init__(self, track: Track, n: int, cfg: SimConfig = DEFAULT):
        self.track, self.n, self.cfg = track, n, cfg
        self.renderer = EgoRenderer(track, cfg.render, cfg.vehicle)
        self.state = np.zeros((n, STATE_DIM))
        self.idx = np.zeros(n, dtype=np.int64)
        self.progress = np.zeros(n)  # meters driven along the centerline since reset
        self.tf = TrackFrame(self.idx, np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool))
        self._heading = np.arctan2(track.tangent[:, 1], track.tangent[:, 0])

    # ---------------------------------------------------------------------------------------
    def reset(
        self,
        rng: np.random.Generator,
        mask: np.ndarray | None = None,
        speed: tuple[float, float] = (0.0, 18.0),
        lateral_frac: float = 0.6,
        heading_noise: float = 0.12,
        start_idx: np.ndarray | None = None,
    ) -> np.ndarray:
        """Place cars at random points of the lap (or ``start_idx``) and return frames."""
        mask = np.ones(self.n, dtype=bool) if mask is None else mask
        k = int(mask.sum())
        tr = self.track
        i0 = rng.integers(0, tr.n, k) if start_idx is None else np.asarray(start_idx)[mask]
        lat = rng.uniform(-1, 1, k) * lateral_frac * tr.half_width
        pos = tr.center[i0] + lat[:, None] * tr.normal[i0]
        st = np.zeros((k, STATE_DIM))
        st[:, X], st[:, Y] = pos[:, 0], pos[:, 1]
        st[:, PSI] = wrap_angle(self._heading[i0] + rng.normal(0, heading_noise, k))
        st[:, VX] = rng.uniform(*speed, k)
        self.state[mask] = st
        self.idx[mask] = i0
        self.progress[mask] = 0.0
        self._update_track_frame(full_search=mask)
        return self.render()

    def set_state(self, state: np.ndarray) -> None:
        """Teleport cars to explicit states (n, 7) and relocalize them on the track."""
        self.state = state.astype(np.float64).copy()
        self._update_track_frame(full_search=np.ones(self.n, dtype=bool))

    def step(self, action: np.ndarray) -> np.ndarray:
        c = self.cfg
        self.state = step_vehicle(self.state, action, self.tf.on_grass, c.vehicle, c.dt, c.substeps)
        self._update_track_frame()
        return self.render()

    def render(self) -> np.ndarray:
        return self.renderer.render(self.state)

    # ---------------------------------------------------------------------------------------
    def _update_track_frame(self, full_search: np.ndarray | None = None, window: int = 14) -> None:
        tr = self.track
        pos = self.state[:, [X, Y]]
        prev = self.idx.copy()
        cand = (prev[:, None] + np.arange(-window, window + 1)[None, :]) % tr.n
        d2 = ((tr.center[cand] - pos[:, None, :]) ** 2).sum(-1)
        best = cand[np.arange(self.n), d2.argmin(1)]
        far = d2.min(1) > (tr.half_width + 8.0) ** 2
        if full_search is not None:
            far |= full_search
        if far.any():
            d2g = ((tr.center[None, :, :] - pos[far][:, None, :]) ** 2).sum(-1)
            best[far] = d2g.argmin(1)
        step = (best - prev + tr.n // 2) % tr.n - tr.n // 2
        jumped = np.abs(step) * tr.ds > 10.0  # relocalized onto another stretch: no credit
        if full_search is None:
            self.progress += np.where(jumped, 0.0, step * tr.ds)
        self.idx = best
        rel = pos - tr.center[best]
        offset = (rel * tr.normal[best]).sum(-1)
        heading_error = wrap_angle(self.state[:, PSI] - self._heading[best])
        self.tf = TrackFrame(best, offset, heading_error, np.abs(offset) > tr.half_width + 0.25)

    def curvature_ahead(self, meters: float) -> np.ndarray:
        tr = self.track
        return tr.curvature[(self.idx + round(meters / tr.ds)) % tr.n]

    def features(self) -> np.ndarray:
        """Privileged features (n, len(FEATURES)) float32, in the order of :data:`FEATURES`."""
        s = self.state
        return np.stack(
            [
                s[:, 3],
                s[:, 4],
                s[:, 5],
                s[:, 6],
                self.tf.offset,
                self.tf.heading_error,
                self.curvature_ahead(0.0),
                self.curvature_ahead(10.0),
                self.curvature_ahead(20.0),
                self.curvature_ahead(30.0),
                self.tf.on_grass.astype(np.float64),
                self.progress,
            ],
            axis=1,
        ).astype(np.float32)
