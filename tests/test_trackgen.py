"""The circuit designer: polar circuits, drivability checks, arc smoothing, the denoiser, export."""

from __future__ import annotations

import importlib.util

import numpy as np
import pytest
import torch

from dreamcircuit.config import DEFAULT
from dreamcircuit.sim.track import sample_valid_centerline
from dreamcircuit.trackgen.model import TrackDenoiser, TrackModelConfig
from dreamcircuit.trackgen.polar import (
    N_ANGLES,
    check,
    destandardize,
    from_polar,
    polar_points,
    standardize,
    to_polar,
)
from dreamcircuit.trackgen.train import (
    CHUNK,
    INITIAL_KNOWN,
    live_arcs,
    live_generate,
    random_masks,
    reconstruct,
    smooth_arc,
)

TINY = TrackModelConfig(channels=(8, 16), blocks=1, cond_dim=16)


def tiny_model(seed: int = 0) -> TrackDenoiser:
    torch.manual_seed(seed)
    m = TrackDenoiser(TINY).eval()
    for p in m.parameters():  # the zero-initialized output layer would make checks trivial
        if p.abs().sum() == 0:
            torch.nn.init.normal_(p, std=0.05)
    return m


def circle(r: float = 77.0, n: int = N_ANGLES) -> np.ndarray:
    return np.full(n, r)


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_procedural_circuits_survive_the_polar_round_trip(seed):
    center = sample_valid_centerline(np.random.default_rng(seed), DEFAULT.track)
    r = to_polar(center)
    assert r is not None and r.shape == (N_ANGLES,)
    rebuilt = from_polar(r)
    length = len(center) * DEFAULT.track.ds
    assert len(rebuilt) * 0.5 == pytest.approx(length, rel=0.05)
    again = to_polar(rebuilt)
    assert again is not None
    assert np.abs(again - r).max() < 1.0  # meters


def test_clockwise_loops_are_mirrored_to_counter_clockwise():
    th = np.linspace(0, 2 * np.pi, 400, endpoint=False)
    clockwise = np.stack([50 * np.cos(-th), 50 * np.sin(-th)], axis=1)
    r = to_polar(clockwise)
    assert r is not None
    np.testing.assert_allclose(r, 50.0, atol=1e-6)


def test_loops_that_turn_back_on_their_angle_are_rejected():
    pts = polar_points(circle(60.0, 64))
    pts[[10, 11]] = pts[[11, 10]]  # the polar angle steps backwards once
    assert to_polar(pts) is None


def test_drivability_rules():
    assert check(reconstruct(circle(77.0)), DEFAULT.track).ok
    assert check(reconstruct(circle(25.0)), DEFAULT.track).reason == "length"
    hairpin = circle(77.0)
    hairpin[40] = 35.0
    v = check(reconstruct(hairpin), DEFAULT.track)
    assert not v.ok and v.reason in ("too tight", "too close to itself")


def test_standardization_round_trips():
    r = np.linspace(40, 120, 7)
    np.testing.assert_allclose(destandardize(standardize(r)), r)


def test_smooth_arc_only_touches_the_arc():
    u = np.where(np.arange(N_ANGLES) % 2, 1.0, -1.0)
    arc = np.arange(10, 20)
    s = smooth_arc(u, arc, 1.0)
    assert np.all(np.abs(s[arc]) < 0.5)
    rest = np.setdiff1d(np.arange(N_ANGLES), arc)
    np.testing.assert_array_equal(s[rest], u[rest])


def test_smooth_arc_wraps_around_the_start_line():
    u = np.zeros(N_ANGLES)
    u[-1] = 1.0
    s = smooth_arc(u, np.array([0]), 1.0)
    assert s[0] > 0  # the sample just before the line is a neighbor of sample 0


def test_live_schedule_covers_the_lap_exactly_once():
    arcs = live_arcs()
    every = np.concatenate(arcs)
    assert len(every) == N_ANGLES
    assert set(every.tolist()) == set(range(N_ANGLES))
    a, b = INITIAL_KNOWN
    assert len(arcs[0]) == b - a  # the grid and first stretch come first, before the countdown
    assert all(len(arc) <= CHUNK for arc in arcs[1:])


def test_random_masks_are_empty_or_one_contiguous_arc():
    m = random_masks(200, N_ANGLES, np.random.default_rng(0))
    for row in m:
        if row.sum() == 0:
            continue
        rises = np.sum((row - np.roll(row, 1)) > 0)  # circular: one arc has exactly one rise
        assert rises == 1


def test_denoiser_shapes_and_preconditioning():
    m = tiny_model()
    x = torch.randn(3, 1, TINY.n)
    mask = torch.zeros(3, 1, TINY.n)
    out = m.denoise(x, torch.tensor([0.5, 2.0, 10.0]), mask, torch.zeros_like(x))
    assert out.shape == x.shape and torch.isfinite(out).all()
    # At tiny noise levels the EDM skip connection dominates: D(x; sigma) is close to x.
    near = m.denoise(x, torch.full((3,), 1e-3), mask, torch.zeros_like(x))
    assert torch.allclose(near, x, atol=5e-3)


def test_sampler_keeps_the_known_arc_exactly():
    m = tiny_model()
    mask = torch.zeros(2, 1, TINY.n)
    mask[..., 5:30] = 1.0
    known = torch.randn(2, 1, TINY.n)
    g = torch.Generator().manual_seed(0)
    out = m.sample(mask, known, steps=3, generator=g)
    assert out.shape == (2, 1, TINY.n) and torch.isfinite(out).all()
    torch.testing.assert_close(out[..., 5:30], known[..., 5:30])


def test_sampler_is_deterministic_given_a_generator():
    m = tiny_model()
    z = torch.zeros(1, 1, TINY.n)
    a = m.sample(z, z, steps=3, generator=torch.Generator().manual_seed(7))
    b = m.sample(z, z, steps=3, generator=torch.Generator().manual_seed(7))
    torch.testing.assert_close(a, b)


def test_loss_is_finite_and_trains_every_parameter():
    m = tiny_model().train()
    x0 = torch.randn(4, 1, TINY.n)
    mask = torch.from_numpy(random_masks(4, TINY.n, np.random.default_rng(1)))[:, None]
    loss = m.loss(x0, mask)
    assert torch.isfinite(loss)
    loss.backward()
    assert all(p.grad is not None for p in m.parameters() if p.requires_grad)


def test_live_generation_builds_every_angle():
    # A stub designer whose best guess is always the mean radius: every arc it dreams is part
    # of one round, valid circuit, so the procedure itself is what is being tested.
    m = TrackDenoiser(TINY).eval()
    m.denoise = lambda x, sigma, mask, known: torch.zeros_like(x)  # type: ignore[method-assign]
    trace: list[dict] = []
    radii, retried = live_generate(
        m, torch.device("cpu"), np.random.default_rng(0), steps=4, trace=trace
    )
    assert len(trace) == len(live_arcs())
    assert [int(t["mask"].sum()) for t in trace][-1] == N_ANGLES
    assert radii.shape == (N_ANGLES,)
    np.testing.assert_allclose(radii, destandardize(np.zeros(N_ANGLES)), atol=1e-4)
    assert retried == 0


def test_wild_samples_fail_fast_on_length():
    v = check(reconstruct(circle(3000.0)), DEFAULT.track)  # an ~28 km loop
    assert not v.ok and v.reason == "length"


@pytest.mark.skipif(importlib.util.find_spec("onnxruntime") is None, reason="needs onnxruntime")
def test_onnx_export_matches_pytorch(tmp_path):
    from dreamcircuit.export.onnx_export import export_track_model

    info = export_track_model(tiny_model(), tmp_path, name="tiny_tracks")
    assert (tmp_path / "tiny_tracks.onnx").exists() and (tmp_path / "tiny_tracks.json").exists()
    assert info["n"] == TINY.n
    assert info["max_abs_err"] < 1e-2  # fp16 weight storage
