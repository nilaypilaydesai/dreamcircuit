"""The circuit designer: the architect's circuits and rules, the steps representation, live
generation, the denoiser and its export."""

from __future__ import annotations

import importlib.util

import numpy as np
import pytest
import torch

from dreamcircuit.trackgen import architect as A
from dreamcircuit.trackgen.data import N_POINTS, encode
from dreamcircuit.trackgen.model import (
    TrackDenoiser,
    TrackModelConfig,
    from_steps,
    step_mask,
    to_steps,
)
from dreamcircuit.trackgen.train import (
    CHUNK,
    EXPECT,
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


@pytest.fixture(scope="module")
def laps() -> dict[str, np.ndarray]:
    """One architect circuit of each layout, as the 256 points the designer learns from."""
    out = {}
    for topology, seed in (("loop", 3), ("figure8", 4)):
        dense = A.generate(np.random.default_rng(seed), topology)
        assert dense is not None
        out[topology] = encode(dense)[0].astype(np.float64)
    return out


# ------------------------------------------------------------------------- architect, rules


@pytest.mark.parametrize("topology", A.TOPOLOGIES)
def test_architect_circuits_pass_their_own_rules(topology):
    dense = A.generate(np.random.default_rng(11), topology)
    assert dense is not None
    v = A.check(dense, expect=EXPECT[topology])
    assert v.ok, v.reason
    assert len(v.crossings) == EXPECT[topology]
    assert abs(A.turning_number(dense)) == (1 if topology == "loop" else 0)


def test_designer_points_round_trip_into_valid_circuits(laps):
    for topology, pts in laps.items():
        assert pts.shape == (N_POINTS, 2)
        assert A.check(reconstruct(pts), expect=EXPECT[topology]).ok


def test_rules_reject_kinks_and_tiny_laps():
    th = np.linspace(0, 2 * np.pi, N_POINTS, endpoint=False)
    ring = np.stack([110 * np.cos(th), 110 * np.sin(th)], axis=1)
    ring -= ring[0]
    assert A.check(reconstruct(ring), expect=0).reason in ("", "start not on a straight")
    assert A.check(reconstruct(ring * 0.4), expect=0).reason == "length"
    kinked = ring.copy()
    kinked[100] += (kinked[100] - kinked[99]) * 2.5  # one point thrown off the line
    assert A.check(reconstruct(kinked), expect=0).reason == "too tight"


# ------------------------------------------------------------------------- steps


def test_steps_round_trip_a_whole_lap_from_the_origin(laps):
    pts = laps["loop"]
    back = from_steps(to_steps(pts, 2.0), None, None, 2.0)
    np.testing.assert_allclose(back, pts - pts[0], atol=1e-9)


def test_dreamed_runs_keep_known_road_and_land_on_it(laps):
    pts = laps["figure8"]
    mask = np.zeros(N_POINTS)
    mask[(232 + np.arange(100)) % N_POINTS] = 1
    drifted = to_steps(pts, 2.0) * 1.05 + 0.02  # every dreamed step a little long and turned
    out = from_steps(drifted, pts, mask, 2.0)
    np.testing.assert_array_equal(out[mask > 0], pts[mask > 0])
    gaps = np.hypot(*(np.roll(out, -1, axis=0) - out).T)
    typical = np.median(gaps)
    for a in (75, 231):  # where the dreamed run leaves and rejoins the known road
        assert gaps[a] < typical * 1.25 and gaps[a - 1] < typical * 1.25


def test_a_step_is_known_only_when_both_of_its_points_are():
    mask = np.zeros(8)
    mask[[2, 3, 4]] = 1
    np.testing.assert_array_equal(step_mask(mask), [0, 0, 1, 1, 0, 0, 0, 0])


def test_smooth_arc_only_touches_the_arc_and_wraps():
    u = np.stack([np.where(np.arange(N_POINTS) % 2, 1.0, -1.0)] * 2)
    arc = np.arange(10, 20)
    s = smooth_arc(u, arc, 1.0)
    assert np.all(np.abs(s[:, arc]) < 0.5)
    rest = np.setdiff1d(np.arange(N_POINTS), arc)
    np.testing.assert_array_equal(s[:, rest], u[:, rest])
    z = np.zeros((2, N_POINTS))
    z[:, -1] = 1.0
    assert smooth_arc(z, np.array([0]), 1.0)[0, 0] > 0  # the point before the line is a neighbor


# ------------------------------------------------------------------------- live schedule, masks


def test_live_schedule_covers_the_lap_exactly_once():
    arcs = live_arcs()
    every = np.concatenate(arcs)
    assert len(every) == N_POINTS and set(every.tolist()) == set(range(N_POINTS))
    a, b = INITIAL_KNOWN
    assert len(arcs[0]) == b - a  # the grid and first stretch come first, before the countdown
    assert all(len(arc) <= CHUNK for arc in arcs[1:])


def test_random_masks_are_empty_or_one_contiguous_stretch():
    m = random_masks(200, N_POINTS, np.random.default_rng(0))
    for row in m:
        if row.sum() == 0:
            continue
        assert np.sum((row - np.roll(row, 1)) > 0) == 1  # circular: one stretch, one rise


# ------------------------------------------------------------------------- the denoiser


def test_denoiser_shapes_preconditioning_and_known_road():
    m = tiny_model()
    x = torch.randn(3, 2, TINY.n)
    mask = torch.zeros(3, 1, TINY.n)
    out = m.denoise(x, torch.tensor([0.5, 2.0, 10.0]), mask, torch.zeros_like(x))
    assert out.shape == x.shape and torch.isfinite(out).all()
    # at tiny noise levels the EDM skip connection dominates: D(x; sigma) is close to x
    near = m.denoise(x, torch.full((3,), 1e-3), mask, torch.zeros_like(x))
    assert torch.allclose(near, x, atol=5e-3)
    # known road comes back exactly, whatever the noise level
    mask[..., 40:90] = 1.0
    known = torch.randn(3, 2, TINY.n)
    out = m.denoise(x, torch.tensor([0.5, 2.0, 10.0]), mask, known)
    torch.testing.assert_close(out[..., 40:90], known[..., 40:90])


def test_sampler_keeps_known_road_and_is_deterministic():
    m = tiny_model()
    mask = torch.zeros(2, 1, TINY.n)
    mask[..., 5:30] = 1.0
    known = torch.randn(2, 2, TINY.n)
    a = m.sample(mask, known, steps=3, generator=torch.Generator().manual_seed(7))
    b = m.sample(mask, known, steps=3, generator=torch.Generator().manual_seed(7))
    assert a.shape == (2, 2, TINY.n) and torch.isfinite(a).all()
    torch.testing.assert_close(a[..., 5:30], known[..., 5:30])
    torch.testing.assert_close(a, b)


def test_loss_is_finite_and_trains_every_parameter():
    m = tiny_model().train()
    x0 = torch.randn(4, 2, TINY.n)
    pts_mask = random_masks(4, TINY.n, np.random.default_rng(1))
    mask = torch.from_numpy(step_mask(pts_mask))[:, None]
    style = torch.rand(4)
    loss = m.loss(x0, mask, style, torch.ones(4), torch.eye(3)[[0, 1, 2, 1]])
    assert torch.isfinite(loss)
    loss.backward()
    assert all(p.grad is not None for p in m.parameters() if p.requires_grad)


def test_live_generation_builds_the_lap_it_is_given(laps):
    # A stub designer whose best guess is always the steps of one real figure-eight: the
    # procedure (masks, steps, joins, checks, smoothing) is what is being tested.
    pts = laps["figure8"]
    target = torch.from_numpy(to_steps(pts, TINY.scale).T.astype(np.float32))[None]
    m = TrackDenoiser(TINY).eval()

    def stub(x, sigma, mask, known, *_):
        return target.expand_as(x) * (1 - mask) + known * mask

    m.denoise = stub  # type: ignore[method-assign]
    trace: list[dict] = []
    out, retried = live_generate(
        m, torch.device("cpu"), np.random.default_rng(0), "figure8", steps=4, trace=trace
    )
    assert len(trace) == len(live_arcs())
    assert int(trace[-1]["mask"].sum()) == N_POINTS
    assert out.shape == (N_POINTS, 2)
    assert A.check(reconstruct(out), expect=1).ok
    assert retried == 0


def test_self_conditioning_sees_its_previous_estimate():
    torch.manual_seed(0)
    cfg = TrackModelConfig(channels=(8, 16), blocks=1, cond_dim=16, self_cond=True)
    m = TrackDenoiser(cfg).train()
    x0 = torch.randn(4, 2, cfg.n)
    mask = torch.from_numpy(step_mask(random_masks(4, cfg.n, np.random.default_rng(2))))[:, None]
    loss = m.loss(x0, mask, torch.rand(4), torch.ones(4), torch.eye(3)[[0, 1, 2, 1]])
    loss.backward()
    assert torch.isfinite(loss)
    assert all(p.grad is not None for p in m.parameters() if p.requires_grad)
    m.eval()
    for p in m.parameters():  # wake the zero-initialized layers so the estimate matters
        if p.abs().sum() == 0:
            torch.nn.init.normal_(p, std=0.05)
    x, sigma = torch.randn(1, 2, cfg.n), torch.tensor([1.0])
    none = torch.zeros(1, 1, cfg.n)
    a = m.denoise(x, sigma, none, torch.zeros_like(x))
    b = m.denoise(x, sigma, none, torch.zeros_like(x), prev=torch.randn(1, 2, cfg.n))
    assert not torch.allclose(a, b)  # the previous estimate is an input
    known_mask = torch.zeros(1, 1, cfg.n)
    known_mask[..., 10:40] = 1.0
    known = torch.randn(1, 2, cfg.n)
    out = m.sample(known_mask, known, steps=3, generator=torch.Generator().manual_seed(1))
    torch.testing.assert_close(out[..., 10:40], known[..., 10:40])


@pytest.mark.skipif(importlib.util.find_spec("onnxruntime") is None, reason="needs onnxruntime")
def test_onnx_export_matches_pytorch(tmp_path):
    from dreamcircuit.export.onnx_export import export_track_model

    info = export_track_model(tiny_model(), tmp_path, name="tiny_tracks")
    assert (tmp_path / "tiny_tracks.onnx").exists() and (tmp_path / "tiny_tracks.json").exists()
    assert info["n"] == TINY.n and info["representation"] == "steps"
    assert info["max_abs_err"] < 1e-2  # fp16 weight storage
    torch.manual_seed(0)
    sc = TrackDenoiser(TrackModelConfig(channels=(8, 16), blocks=1, cond_dim=16, self_cond=True))
    info = export_track_model(sc.eval(), tmp_path, name="tiny_tracks_sc")
    assert info["self_cond"] and info["max_abs_err"] < 1e-2
