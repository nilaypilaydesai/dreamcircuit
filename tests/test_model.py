"""World model, EDM sampler, export transforms and the pixel policy (tiny configs, CPU)."""

from __future__ import annotations

import importlib.util

import pytest
import torch
import torch.nn.functional as F

from dreamcircuit.model.edm import EDMConfig, WorldModel, count_params, estimate_macs
from dreamcircuit.model.policy import PixelPolicy, policy_loss
from dreamcircuit.model.unet import GroupNorm, UNetConfig

TINY = UNetConfig(
    channels=(8, 16, 16, 16), blocks_per_level=1, attn_levels=(), cond_dim=32, heads=2, groups=2
)


def tiny_model(seed: int = 0, randomize_zero_init: bool = True) -> WorldModel:
    torch.manual_seed(seed)
    m = WorldModel(TINY, EDMConfig()).eval()
    if randomize_zero_init:  # zero-initialized output layers would make many checks trivial
        for p in m.parameters():
            if p.abs().sum() == 0:
                torch.nn.init.normal_(p, std=0.05)
    return m


def batch(b: int = 2, seed: int = 0) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    g = torch.Generator().manual_seed(seed)
    frames = torch.rand(b, 5, 3, 64, 64, generator=g) * 2 - 1
    actions = torch.rand(b, 4, 2, generator=g) * 2 - 1
    return frames[:, :4], frames[:, 4], actions


def test_denoiser_shapes():
    m = tiny_model()
    ctx, target, act = batch()
    out = m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2))
    assert out.shape == target.shape


def test_edm_preconditioning_is_identity_at_zero_noise():
    m = tiny_model()
    ctx, target, act = batch()
    out = m.denoise(target, torch.full((2,), 1e-6), ctx, act, torch.zeros(2))
    assert torch.allclose(out, target, atol=1e-5)  # c_skip -> 1, c_out -> 0


def test_karras_schedule():
    m = tiny_model()
    s = m.sigmas(4)
    assert len(s) == 5 and s[-1] == 0
    assert torch.isclose(s[0], torch.tensor(m.edm.sigma_max))
    assert torch.isclose(s[-2], torch.tensor(m.edm.sigma_min))
    assert (s[:-1][1:] < s[:-1][:-1]).all()
    assert torch.equal(m.sigmas(1), torch.tensor([m.edm.sigma_max, 0.0]))


def test_one_step_sampling_equals_one_denoiser_call():
    m = tiny_model()
    ctx, _, act = batch()
    noise = torch.randn(2, 3, 64, 64, generator=torch.Generator().manual_seed(3))
    x = m.sample(ctx, act, steps=1, noise=noise)
    ref = m.denoise(
        noise * m.edm.sigma_max, torch.full((2,), m.edm.sigma_max), ctx, act, torch.zeros(2)
    ).clamp(-1, 1)
    assert torch.allclose(x, ref, atol=1e-6)


def test_sampling_is_deterministic_and_bounded():
    m = tiny_model()
    ctx, _, act = batch()
    noise = torch.randn(2, 3, 64, 64)
    a = m.sample(ctx, act, steps=3, noise=noise)
    b = m.sample(ctx, act, steps=3, noise=noise)
    assert torch.equal(a, b)
    assert a.min() >= -1 and a.max() <= 1


def test_rollout_shape_and_action_window():
    m = tiny_model()
    ctx, _, act = batch()
    out = m.rollout(ctx, act[:, :3], torch.zeros(2, 5, 2), steps=1)
    assert out.shape == (2, 5, 3, 64, 64)


def test_actions_change_the_prediction():
    m = tiny_model()
    ctx, target, act = batch()
    a = m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2))
    b = m.denoise(target, torch.ones(2), ctx, -act, torch.zeros(2))
    assert (a - b).abs().mean() > 1e-4


def test_mid_bias_hook_is_live():
    m = tiny_model()
    ctx, target, act = batch()
    a = m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2))
    b = m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2), torch.ones(2, 16))
    assert (a - b).abs().mean() > 1e-5


def test_training_loss_decreases_on_a_fixed_batch():
    torch.manual_seed(0)
    m = WorldModel(TINY, EDMConfig())
    ctx, target, act = batch(4)
    opt = torch.optim.Adam(m.parameters(), lr=3e-3)
    losses = []
    for _ in range(150):
        torch.manual_seed(1)  # same noise draws every step: a pure optimization check
        loss = m.loss(target, ctx, act)
        opt.zero_grad()
        loss.backward()
        opt.step()
        losses.append(loss.item())
    assert losses[-1] < 0.5 * losses[0]


@pytest.mark.parametrize("mode", ["instance", "reduce"])
def test_export_groupnorm_matches_training_groupnorm(mode):
    x = torch.randn(2, 16, 8, 8)
    gn = GroupNorm(4, 16)
    ref = gn(x)
    gn.export_mode = mode
    assert torch.allclose(gn(x), ref, atol=1e-5)
    assert torch.allclose(ref, F.group_norm(x, 4, eps=1e-5))


def test_input_channel_padding_is_exact():
    m = tiny_model()
    ctx, target, act = batch()
    ref = m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2))
    m.unet.pad_input_channels(4)
    assert m.unet.conv_in.in_channels == 16
    assert torch.allclose(
        m.denoise(target, torch.ones(2), ctx, act, torch.zeros(2)), ref, atol=1e-6
    )


def test_cost_accounting():
    m = tiny_model()
    assert count_params(m) > 0
    assert 0 < estimate_macs(m) < 1e9


@pytest.mark.skipif(importlib.util.find_spec("onnxruntime") is None, reason="needs onnxruntime")
def test_onnx_export_matches_pytorch(tmp_path):
    from dreamcircuit.export.onnx_export import export_world_model

    info = export_world_model(tiny_model(), tmp_path, name="tiny")
    assert info["max_abs_err_fp32"] < 1e-4
    assert info["max_abs_err_fp16_storage"] < 5e-2
    assert (tmp_path / "tiny.onnx").exists() and (tmp_path / "tiny.json").exists()


def test_policy_outputs_bounded_actions():
    p = PixelPolicy()
    x = torch.rand(3, 12, 64, 64) * 2 - 1
    y = p(x)
    assert y.shape == (3, 2) and y.abs().max() <= 1
    loss = policy_loss(y, torch.zeros(3, 2))
    loss.backward()
    assert all(q.grad is not None for q in p.parameters())
