"""The measuring instruments: ego-motion registration, image metrics and linear probes."""

from __future__ import annotations

import numpy as np
import pytest
import torch

from dreamcircuit.config import DEFAULT
from dreamcircuit.data.dataset import to_tensor
from dreamcircuit.eval.audit import ssim
from dreamcircuit.eval.probes import Ridge, _r2
from dreamcircuit.eval.registration import estimate_motion, true_motion, warp
from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.track import generate_track
from dreamcircuit.sim.vehicle import PSI, X, Y
from dreamcircuit.train.world_model import psnr


@pytest.fixture(scope="module")
def env():
    e = RaceEnv(generate_track(3), 6)
    e.reset(np.random.default_rng(0), speed=(0.0, 0.0), lateral_frac=0.3, heading_noise=0.0)
    return e


def moved(env: RaceEnv, df: np.ndarray, dl: np.ndarray, dpsi: np.ndarray) -> np.ndarray:
    s = env.state.copy()
    c, sn = np.cos(s[:, PSI]), np.sin(s[:, PSI])
    s[:, X] += df * c - dl * sn
    s[:, Y] += df * sn + dl * c
    s[:, PSI] += dpsi
    return s


def test_registration_recovers_known_ego_motion(env):
    rng = np.random.default_rng(0)
    df = rng.uniform(0.0, 2.0, env.n)
    dl = rng.uniform(-0.3, 0.3, env.n)
    dpsi = rng.uniform(-0.1, 0.1, env.n)
    a = env.render()
    s0 = env.state.copy()
    env.set_state(moved(env, df, dl, dpsi))
    b = env.render()
    env.set_state(s0)
    est = estimate_motion(to_tensor(a, "cpu"), to_tensor(b, "cpu")).numpy()
    assert np.abs(est[:, 0] - df).max() < 0.15  # m: < 0.3 px
    assert np.abs(est[:, 1] - dl).max() < 0.15
    assert np.abs(est[:, 2] - dpsi).max() < 0.01  # rad


def test_true_motion_in_car_frame():
    s0 = torch.tensor([[0.0, 0.0, np.pi / 2, 0, 0, 0, 0]])
    s1 = torch.tensor([[0.0, 1.0, np.pi / 2 + 0.1, 0, 0, 0, 0]])  # 1 m "north" = 1 m forward
    m = true_motion(s0, s1)[0]
    assert torch.allclose(m, torch.tensor([1.0, 0.0, 0.1]), atol=1e-6)


def test_zero_motion_warp_is_identity():
    x = torch.rand(2, 3, 64, 64)
    w, valid = warp(x, torch.zeros(2, 3), DEFAULT.render)
    assert torch.allclose(w, x, atol=1e-5)
    assert valid.mean() > 0.8


def test_image_metrics():
    x = torch.rand(2, 4, 3, 64, 64) * 2 - 1
    assert torch.allclose(ssim(x, x), torch.ones(2, 4), atol=1e-5)
    assert (psnr(x, x) > 90).all()
    noisy = (x + 0.2 * torch.randn_like(x)).clamp(-1, 1)
    assert (psnr(noisy, x) < 30).all() and (ssim(noisy, x) < 0.95).all()


def test_ridge_probe_recovers_a_linear_signal_and_its_direction():
    rng = np.random.default_rng(0)
    x = rng.normal(size=(3000, 20)) * rng.uniform(0.1, 3.0, 20)
    w = rng.normal(size=20)
    y = x @ w + 0.01 * rng.normal(size=3000)
    r = Ridge().fit(x[:2000], y[:2000])
    assert _r2(y[2000:], r.predict(x[2000:])) > 0.99
    d = r.direction()
    base = r.predict(x[:5])
    pushed = r.predict(x[:5] + d)
    assert np.allclose(pushed - base, r.ysd, rtol=1e-6)  # +1 direction = +1 target std
