"""Simulator invariants: physics sanity, determinism, rendering and track geometry."""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from dreamcircuit.config import DEFAULT
from dreamcircuit.sim.drivers import MixedDriver, expert_action
from dreamcircuit.sim.env import RaceEnv
from dreamcircuit.sim.render import car_sprite, read_hud
from dreamcircuit.sim.track import _frames, _min_clearance, generate_track
from dreamcircuit.sim.vehicle import DELTA, PSI, VX, VY, X, Y, step_vehicle

P = DEFAULT.vehicle


@pytest.fixture(scope="module")
def track():
    return generate_track(3)


def state(vx: float = 10.0, **kw: float) -> np.ndarray:
    s = np.zeros((1, 7))
    s[0, VX] = vx
    for k, v in kw.items():
        s[0, {"vy": VY, "psi": PSI, "delta": DELTA}[k]] = v
    return s


def run(s: np.ndarray, action: tuple[float, float], frames: int, grass: bool = False) -> np.ndarray:
    for _ in range(frames):
        s = step_vehicle(s, np.array([action]), np.array([grass]), P, DEFAULT.dt, DEFAULT.substeps)
    return s


# ---------------------------------------------------------------- vehicle dynamics


def test_standstill_stays_put():
    s = run(state(vx=0.0), (0.0, 0.0), 30)
    assert np.allclose(s[0, [X, Y, VX, VY]], 0.0, atol=1e-9)


def test_steering_at_standstill_does_not_move_the_car():
    s = run(state(vx=0.0), (1.0, 0.0), 30)
    assert np.hypot(s[0, X], s[0, Y]) < 1e-6
    assert s[0, DELTA] > 0.3  # the wheels did turn


def test_top_speed_is_respected():
    s = run(state(vx=0.0), (0.0, 1.0), 15 * 30)
    assert P.top_speed - 1.0 < s[0, VX] <= P.top_speed + 0.05


def test_launch_is_torque_then_power_limited():
    s = run(state(vx=0.0), (0.0, 1.0), 15)  # one second at full throttle
    assert 4.0 < s[0, VX] < 9.0  # 0.4 - 0.9 g average, an FSAE-EV launch


def test_braking_decelerates_hard_but_within_grip():
    s0 = state(vx=20.0)
    s = run(s0, (0.0, -1.0), 15)
    decel = (s0[0, VX] - s[0, VX]) / 1.0
    assert 9.0 < decel < P.mu * P.g + 1e-6


def test_left_steer_turns_left_and_right_steer_turns_right():
    left = run(state(vx=12.0), (0.5, 0.2), 15)
    right = run(state(vx=12.0), (-0.5, 0.2), 15)
    assert left[0, PSI] > 0.2 and right[0, PSI] < -0.2
    assert np.isclose(left[0, PSI], -right[0, PSI], rtol=1e-6)  # mirror symmetry


def test_grass_is_slower_than_asphalt():
    asphalt = run(state(vx=0.0), (0.0, 1.0), 30)
    grass = run(state(vx=0.0), (0.0, 1.0), 30, grass=True)
    assert grass[0, VX] < 0.8 * asphalt[0, VX]


def test_steady_cornering_lateral_accel_is_bounded_by_friction():
    s = run(state(vx=15.0), (1.0, 0.3), 45)
    a_lat = abs(s[0, VX] * s[0, 5])
    assert a_lat < 1.05 * P.mu * P.g


@settings(max_examples=40, deadline=None)
@given(
    st.lists(st.tuples(st.floats(-1, 1), st.floats(-1, 1)), min_size=5, max_size=60),
    st.floats(0.0, 30.0),
    st.booleans(),
)
def test_random_inputs_never_explode(actions, v0, grass):
    s = state(vx=v0)
    for a in actions:
        s = step_vehicle(s, np.array([a]), np.array([grass]), P, DEFAULT.dt, DEFAULT.substeps)
        assert np.isfinite(s).all()
        assert np.hypot(s[0, VX], s[0, VY]) < P.top_speed + 5.0
        assert -np.pi <= s[0, PSI] < np.pi
        assert abs(s[0, DELTA]) <= P.max_steer + 1e-9


def test_dynamics_are_deterministic():
    a = np.random.default_rng(0).uniform(-1, 1, (50, 4, 2))
    s1 = s2 = np.tile(state(vx=8.0), (4, 1))
    for t in range(50):
        s1 = step_vehicle(s1, a[t], np.zeros(4, bool), P, DEFAULT.dt, DEFAULT.substeps)
        s2 = step_vehicle(s2, a[t], np.zeros(4, bool), P, DEFAULT.dt, DEFAULT.substeps)
    assert np.array_equal(s1, s2)


# ---------------------------------------------------------------- tracks


@pytest.mark.parametrize("seed", [0, 1, 2, 17, 1000500])
def test_tracks_satisfy_geometric_constraints(seed):
    tr = generate_track(seed)
    spec = DEFAULT.track
    assert 450 <= tr.length <= 1500
    assert np.abs(tr.curvature).max() <= 1.0 / spec.min_radius + 1e-9
    assert _min_clearance(tr.center, tr.ds) >= 2 * spec.half_width + spec.clearance
    steps = np.hypot(*np.diff(np.vstack([tr.center, tr.center[:1]]), axis=0).T)
    assert np.allclose(steps, tr.ds, rtol=0.05)  # uniform arc-length sampling
    assert np.allclose(np.hypot(*tr.normal.T), 1.0)


def test_track_generation_is_deterministic():
    a, b = generate_track(42), generate_track(42)
    assert np.array_equal(a.center, b.center)
    assert np.array_equal(a.texture, b.texture)


def test_frames_of_a_circle_have_constant_curvature():
    r, ds = 50.0, 0.5
    n = int(2 * np.pi * r / ds)
    th = np.arange(n) * 2 * np.pi / n
    c = np.stack([r * np.cos(th), r * np.sin(th)], 1)
    _, normal, kappa = _frames(c, 2 * np.pi * r / n)
    assert np.allclose(kappa, 1 / r, rtol=1e-3)
    assert np.allclose((normal * -c / r).sum(1), 1.0, atol=1e-3)  # left normal points inward


# ---------------------------------------------------------------- environment + rendering


def test_render_shape_and_hud(track):
    env = RaceEnv(track, 3)
    env.reset(np.random.default_rng(0), speed=(5.0, 25.0))
    frames = env.render()
    assert frames.shape == (3, 64, 64, 3) and frames.dtype == np.uint8
    speed_frac, steer_frac = read_hud(frames, DEFAULT.render)
    assert np.allclose(speed_frac * P.top_speed, env.state[:, VX], atol=0.02)
    assert np.allclose(steer_frac, env.state[:, DELTA] / P.max_steer, atol=0.01)


def test_render_is_egocentric(track):
    """Moving the car along its heading scrolls the world down; the car sprite stays put."""
    env = RaceEnv(track, 1)
    env.reset(np.random.default_rng(1), speed=(0.0, 0.0), lateral_frac=0.0, heading_noise=0.0)
    a = env.render()[0].astype(int)
    s = env.state.copy()
    s[0, X] += 2.0 * np.cos(s[0, PSI])  # 2 m forward = 4 px
    s[0, Y] += 2.0 * np.sin(s[0, PSI])
    env.set_state(s)
    b = env.render()[0].astype(int)
    shifted = np.abs(a[:50] - b[4:54]).mean()
    unshifted = np.abs(a[:50] - b[:50]).mean()
    assert shifted < 0.35 * unshifted
    # The car is ~3 px wide and anti-aliased: its mostly-covered pixels barely change.
    covered = car_sprite(DEFAULT.render)[1][..., 0] > 0.75
    assert covered.sum() >= 8
    assert np.abs(a[covered] - b[covered]).mean() < 0.25 * unshifted


def test_expert_completes_laps_without_leaving_the_track(track):
    env = RaceEnv(track, 2)
    env.reset(
        np.random.default_rng(0),
        speed=(0.0, 0.0),
        lateral_frac=0.0,
        heading_noise=0.0,
        start_idx=np.zeros(2, int),
    )
    grass = 0
    for _ in range(15 * 40):
        env.step(expert_action(env, 0.7))
        grass += env.tf.on_grass.sum()
    assert (env.progress / track.length >= 1.0).all()
    assert grass == 0


def test_mixed_driver_produces_diverse_but_valid_actions(track):
    rng = np.random.default_rng(0)
    env = RaceEnv(track, 16)
    env.reset(rng)
    drv = MixedDriver(env, rng)
    acts = []
    for _ in range(150):
        a = drv.act()
        acts.append(a)
        env.step(a)
    acts = np.stack(acts)
    assert np.abs(acts).max() <= 1.0
    assert acts[..., 1].min() == -1.0 and acts[..., 1].max() == 1.0  # full brake and throttle
    assert len(np.unique(np.round(acts[..., 0], 2))) > 50  # continuous and quantized steering
