"""Dataset generation and window sampling, end to end on a tiny dataset."""

from __future__ import annotations

import json

import numpy as np
import pytest

from dreamcircuit.data.dataset import EpisodeStore, WindowSampler, to_tensor, to_uint8
from dreamcircuit.data.generate import GenSpec, generate_dataset
from dreamcircuit.sim.env import FEATURES, RaceEnv
from dreamcircuit.sim.track import generate_track


@pytest.fixture(scope="module")
def tiny(tmp_path_factory):
    root = tmp_path_factory.mktemp("tiny")
    meta = generate_dataset(
        GenSpec(root, "train", n_tracks=2, cars_per_track=2, steps=12), workers=2
    )
    return root, meta


def test_generated_arrays_have_consistent_shapes(tiny):
    root, meta = tiny
    st = EpisodeStore(root)
    assert st.frames.shape == (4, 13, 64, 64, 3) and st.frames.dtype == np.uint8
    assert st.actions.shape == (4, 12, 2)
    assert st.states.shape == (4, 13, 7)
    assert st.features.shape == (4, 13, len(FEATURES))
    assert meta["n_frames"] == 4 * 13
    assert json.loads((root / "meta.json").read_text())["track_seeds"] == meta["track_seeds"]


def test_frames_are_reproducible_from_states(tiny):
    """Every stored frame is exactly what the renderer draws for the stored state."""
    root, meta = tiny
    st = EpisodeStore(root)
    env = RaceEnv(generate_track(meta["track_seeds"][0]), 2)
    for t in (0, 6, 12):
        env.set_state(np.asarray(st.states[:2, t], dtype=np.float64))
        diff = np.abs(env.render().astype(int) - st.frames[:2, t].astype(int))
        assert diff.max() <= 1  # states are stored as float32


def test_window_sampler_alignment(tiny):
    root, _ = tiny
    st = EpisodeStore(root)
    frames, actions = WindowSampler(st, context=4, batch_size=8, seed=0).sample_numpy()
    assert frames.shape == (8, 5, 64, 64, 3) and actions.shape == (8, 4, 2)
    assert np.abs(actions).max() <= 1.0


def test_tensor_round_trip():
    x = np.random.default_rng(0).integers(0, 256, (3, 64, 64, 3), dtype=np.uint8)
    assert np.array_equal(to_uint8(to_tensor(x, "cpu")), x)
