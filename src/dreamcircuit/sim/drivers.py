"""Scripted drivers.

``expert_action`` is a privileged controller: it reads the true track geometry and car state
(pure-pursuit steering on an offset racing line plus a friction-limited speed profile). It is the
"teacher" for the pixel autopilot and the backbone of :class:`MixedDriver`, which perturbs it into
a population of drivers (tidy, keyboard-style, over-driven, wandering, braking, coasting) so that
the world model sees slides, spins, off-track excursions and standing starts, not just laps.
"""

from __future__ import annotations

import numpy as np

from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.vehicle import PSI, VX, X, Y, steer_limit


def expert_action(
    env: RaceEnv,
    aggression: np.ndarray | float = 0.9,
    offset: np.ndarray | float = 0.0,
    horizon_m: float = 70.0,
) -> np.ndarray:
    tr, p = env.track, env.cfg.vehicle
    n = env.n
    aggression = np.broadcast_to(np.asarray(aggression, dtype=np.float64), (n,))
    offset = np.broadcast_to(np.asarray(offset, dtype=np.float64), (n,))
    s = env.state
    v = np.maximum(s[:, VX], 0.0)

    # Pure pursuit toward a point on the (offset) racing line ahead.
    look = np.clip(5.0 + 0.55 * v, 5.0, 16.0)
    j = (env.idx + np.round(look / tr.ds).astype(np.int64)) % tr.n
    target = tr.center[j] + offset[:, None] * tr.normal[j]
    dx, dy = target[:, 0] - s[:, X], target[:, 1] - s[:, Y]
    c, sn = np.cos(s[:, PSI]), np.sin(s[:, PSI])
    fwd, lat = dx * c + dy * sn, -dx * sn + dy * c
    alpha = np.arctan2(lat, fwd)
    dist = np.maximum(np.hypot(fwd, lat), 1.0)
    delta = np.arctan(2.0 * p.wheelbase * np.sin(alpha) / dist)
    steer = delta / steer_limit(s[:, VX], p)
    steer = np.where(np.abs(alpha) > np.pi / 2, np.sign(alpha), steer)  # facing the wrong way

    # Friction-limited speed profile with braking-distance lookahead.
    k = int(horizon_m / tr.ds)
    ahead = (env.idx[:, None] + np.arange(k)[None, :]) % tr.n
    kappa = np.maximum(np.abs(tr.curvature[ahead]), 1e-4)
    mu_g = p.mu * p.g
    v_corner = np.sqrt(aggression[:, None] * 0.92 * mu_g / kappa)
    dist_ahead = np.arange(k)[None, :] * tr.ds
    v_allow = np.sqrt(v_corner**2 + 2.0 * aggression[:, None] * 0.75 * mu_g * dist_ahead)
    v_target = np.minimum(v_allow.min(axis=1), 0.98 * p.top_speed)
    v_target = np.where(env.tf.on_grass, np.minimum(v_target, 9.0), v_target)
    pedal = np.clip(0.6 * (v_target - v), -1.0, 1.0)
    return np.stack([np.clip(steer, -1.0, 1.0), pedal], axis=1)


MODES = ("expert", "keys", "push", "wander", "brake", "coast")
MODE_PROBS = np.array([0.44, 0.26, 0.10, 0.08, 0.06, 0.06])
MODE_SECONDS = {
    "expert": (2.0, 8.0),
    "keys": (2.0, 8.0),
    "push": (2.0, 5.0),
    "wander": (0.5, 1.6),
    "brake": (0.4, 1.8),
    "coast": (0.8, 2.5),
}


class MixedDriver:
    """A population of imperfect drivers that switch behavior every few seconds."""

    def __init__(self, env: RaceEnv, rng: np.random.Generator):
        self.env, self.rng = env, rng
        n = env.n
        self.mode = np.zeros(n, dtype=np.int64)
        self.timer = np.zeros(n)
        self.aggression = np.ones(n)
        self.offset = np.zeros(n)
        self.noise_std = np.zeros((n, 2))
        self.ou = np.zeros((n, 2))
        self.key_thresh = np.full(n, 0.25)
        self.wander_bias = np.zeros(n)
        self._resample(np.ones(n, dtype=bool))

    def _resample(self, mask: np.ndarray) -> None:
        k = int(mask.sum())
        if k == 0:
            return
        rng, hw = self.rng, self.env.track.half_width
        mode = rng.choice(len(MODES), size=k, p=MODE_PROBS)
        self.mode[mask] = mode
        lo = np.array([MODE_SECONDS[MODES[m]][0] for m in mode])
        hi = np.array([MODE_SECONDS[MODES[m]][1] for m in mode])
        self.timer[mask] = rng.uniform(lo, hi)
        push = mode == MODES.index("push")
        self.aggression[mask] = np.where(
            push, rng.uniform(0.95, 1.25, k), rng.uniform(0.5, 0.88, k)
        )
        self.offset[mask] = rng.uniform(-1, 1, k) * (hw - 1.6)
        self.noise_std[mask] = rng.uniform(0.0, 0.18, (k, 2))
        self.key_thresh[mask] = rng.uniform(0.15, 0.4, k)
        self.wander_bias[mask] = rng.uniform(0.0, 0.6, k)

    def act(self) -> np.ndarray:
        env, rng, dt = self.env, self.rng, self.env.cfg.dt
        a = expert_action(env, self.aggression, self.offset)
        # Ornstein-Uhlenbeck exploration noise (temporally correlated, like a human hand).
        self.ou += -2.0 * self.ou * dt + np.sqrt(dt) * rng.normal(size=self.ou.shape)
        noisy = a + self.noise_std * self.ou

        m = self.mode
        out = noisy.copy()
        keys = m == MODES.index("keys")
        if keys.any():
            st, pd = noisy[keys, 0], noisy[keys, 1]
            th = self.key_thresh[keys]
            out[keys, 0] = np.where(st > th, 1.0, np.where(st < -th, -1.0, 0.0))
            out[keys, 1] = np.where(pd > 0.3, 1.0, np.where(pd < -0.3, -1.0, 0.0))
        wander = m == MODES.index("wander")
        if wander.any():
            out[wander, 0] = np.clip(1.4 * self.ou[wander, 0], -1, 1)
            out[wander, 1] = np.clip(self.wander_bias[wander] + 0.8 * self.ou[wander, 1], -1, 1)
        brake = m == MODES.index("brake")
        out[brake, 1] = -1.0
        coast = m == MODES.index("coast")
        out[coast, 1] = 0.0

        # Anyone who strays far from the circuit hands control back to a tidy driver.
        lost = np.abs(env.tf.offset) > env.track.half_width + 12.0
        out[lost] = expert_action(env, 0.7, 0.0)[lost]

        self.timer -= dt
        self._resample(self.timer <= 0)
        return np.clip(out, -1.0, 1.0).astype(np.float64)
