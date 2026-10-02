"""Action-conditioned U-Net used as the EDM denoiser of the world model.

Inputs are the (pre-scaled) noisy next frame concatenated channel-wise with the L previous
frames. A conditioning vector built from the diffusion noise level, the context-noise
augmentation level and the last L actions modulates every residual block through adaptive
group normalization (scale and shift), as in DIAMOND / GameNGen.

Every op here (Conv, GroupNorm-as-primitives, SiLU, nearest upsampling, MatMul/Softmax attention)
exports cleanly to ONNX and runs on ONNX Runtime Web's WebGPU backend.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import torch
import torch.nn.functional as F
from torch import nn


@dataclass(frozen=True)
class UNetConfig:
    in_frames: int = 4  # L context frames
    action_dim: int = 2
    channels: tuple[int, ...] = (32, 64, 128, 256)
    blocks_per_level: int = 2
    attn_levels: tuple[int, ...] = (3,)  # attention at the 8x8 level
    cond_dim: int = 256
    heads: int = 4
    groups: int = 8
    extra: dict = field(default_factory=dict)


class GroupNorm(nn.Module):
    """Affine-free GroupNorm. ``F.group_norm`` while training; on export it becomes a single
    ONNX InstanceNormalization over a (B, groups, -1) view, which every runtime implements as one
    fused kernel (``mode="reduce"`` spells it out with primitive reductions instead)."""

    def __init__(self, groups: int, channels: int, eps: float = 1e-5):
        super().__init__()
        self.groups, self.channels, self.eps = groups, channels, eps
        self.export_mode: str | None = None  # None (train) | "instance" | "reduce"

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.export_mode is None:
            return F.group_norm(x, self.groups, eps=self.eps)
        g = x.reshape(x.shape[0], self.groups, -1)
        if self.export_mode == "instance":
            return F.instance_norm(g, eps=self.eps).reshape_as(x)
        mean = g.mean(dim=-1, keepdim=True)
        var = ((g - mean) ** 2).mean(dim=-1, keepdim=True)
        return ((g - mean) / torch.sqrt(var + self.eps)).reshape_as(x)


def zero_init(m: nn.Linear | nn.Conv1d | nn.Conv2d) -> None:
    """Zero a layer so its block starts as the identity (stable deep diffusion training)."""
    nn.init.zeros_(m.weight)
    if m.bias is not None:
        nn.init.zeros_(m.bias)


class FourierFeatures(nn.Module):
    weight: torch.Tensor

    def __init__(self, dim: int, seed: int):
        super().__init__()
        gen = torch.Generator().manual_seed(seed)
        self.register_buffer("weight", torch.randn(1, dim // 2, generator=gen))

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (B,) -> (B, dim)
        f = 2 * math.pi * x[:, None] * self.weight
        return torch.cat([f.cos(), f.sin()], dim=-1)


class AdaGroupNorm(nn.Module):
    def __init__(self, channels: int, cond_dim: int, groups: int):
        super().__init__()
        self.norm = GroupNorm(min(groups, channels // 4), channels)
        self.proj = nn.Linear(cond_dim, 2 * channels)
        zero_init(self.proj)

    def forward(self, x: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        scale, shift = self.proj(cond)[:, :, None, None].chunk(2, dim=1)
        return self.norm(x) * (1 + scale) + shift


class ResBlock(nn.Module):
    def __init__(self, c_in: int, c_out: int, cond_dim: int, groups: int):
        super().__init__()
        self.norm1 = AdaGroupNorm(c_in, cond_dim, groups)
        self.conv1 = nn.Conv2d(c_in, c_out, 3, padding=1)
        self.norm2 = AdaGroupNorm(c_out, cond_dim, groups)
        self.conv2 = nn.Conv2d(c_out, c_out, 3, padding=1)
        zero_init(self.conv2)
        self.skip = nn.Conv2d(c_in, c_out, 1) if c_in != c_out else nn.Identity()

    def forward(self, x: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        h = self.conv1(F.silu(self.norm1(x, cond)))
        h = self.conv2(F.silu(self.norm2(h, cond)))
        return self.skip(x) + h


class SelfAttention(nn.Module):
    def __init__(self, channels: int, heads: int, groups: int):
        super().__init__()
        self.heads = heads
        self.norm = GroupNorm(min(groups, channels // 4), channels)
        self.qkv = nn.Conv2d(channels, 3 * channels, 1)
        self.out = nn.Conv2d(channels, channels, 1)
        zero_init(self.out)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, c, h, w = x.shape
        d = c // self.heads
        q, k, v = self.qkv(self.norm(x)).reshape(b, 3, self.heads, d, h * w).unbind(1)
        attn = torch.softmax(q.transpose(-1, -2) @ k / math.sqrt(d), dim=-1)  # (b, H, hw, hw)
        y = (v @ attn.transpose(-1, -2)).reshape(b, c, h, w)
        return x + self.out(y)


class Level(nn.Module):
    def __init__(self, c_in: int, c: int, n_blocks: int, cfg: UNetConfig, attn: bool):
        super().__init__()
        self.blocks = nn.ModuleList(
            [ResBlock(c_in if i == 0 else c, c, cfg.cond_dim, cfg.groups) for i in range(n_blocks)]
        )
        self.attn = SelfAttention(c, cfg.heads, cfg.groups) if attn else None

    def forward(self, x: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        for blk in self.blocks:
            x = blk(x, cond)
        return self.attn(x) if self.attn is not None else x


class UNet(nn.Module):
    def __init__(self, cfg: UNetConfig):
        super().__init__()
        self.cfg = cfg
        ch, d = cfg.channels, cfg.cond_dim
        self.noise_emb = FourierFeatures(d, seed=0)
        self.aug_emb = FourierFeatures(d, seed=1)
        self.act_emb = nn.Sequential(
            nn.Linear(cfg.in_frames * cfg.action_dim, d), nn.SiLU(), nn.Linear(d, d)
        )
        self.cond_mlp = nn.Sequential(nn.Linear(3 * d, d), nn.SiLU(), nn.Linear(d, d))

        self.conv_in = nn.Conv2d(3 * (cfg.in_frames + 1), ch[0], 3, padding=1)
        self.down = nn.ModuleList()
        self.downsample = nn.ModuleList()
        c_prev = ch[0]
        for i, c in enumerate(ch):
            self.down.append(Level(c_prev, c, cfg.blocks_per_level, cfg, i in cfg.attn_levels))
            if i < len(ch) - 1:
                self.downsample.append(nn.Conv2d(c, c, 3, stride=2, padding=1))
            c_prev = c
        self.mid1 = ResBlock(ch[-1], ch[-1], d, cfg.groups)
        self.mid_attn = SelfAttention(ch[-1], cfg.heads, cfg.groups)
        self.mid2 = ResBlock(ch[-1], ch[-1], d, cfg.groups)
        self.up = nn.ModuleList()
        self.upsample = nn.ModuleList()
        for i in reversed(range(len(ch))):
            c_up = ch[-1] if i == len(ch) - 1 else ch[i + 1]
            self.up.append(
                Level(c_up + ch[i], ch[i], cfg.blocks_per_level, cfg, i in cfg.attn_levels)
            )
            if i > 0:
                self.upsample.append(nn.Conv2d(ch[i], ch[i], 3, padding=1))
        self.norm_out = GroupNorm(min(cfg.groups, ch[0] // 4), ch[0])
        self.conv_out = nn.Conv2d(ch[0], 3, 3, padding=1)
        zero_init(self.conv_out)

    def pad_input_channels(self, multiple: int = 4) -> None:
        """Zero-pad ``conv_in``'s input channels up to a multiple of ``multiple`` (exactly the same
        function). Export-time workaround: ONNX Runtime Web 1.30's WebGPU Conv returns wrong
        results when C_in is divisible by 3 but not by 4, and our first conv sees 3 * 5 = 15."""
        c = self.conv_in.in_channels
        pad = (-c) % multiple
        if pad == 0:
            return
        new = nn.Conv2d(c + pad, self.conv_in.out_channels, 3, padding=1)
        with torch.no_grad():
            new.weight.zero_()
            new.weight[:, :c] = self.conv_in.weight
            if new.bias is not None and self.conv_in.bias is not None:
                new.bias.copy_(self.conv_in.bias)
        self.conv_in = new.to(self.conv_in.weight.device)
        self._in_pad = pad

    def set_export_norm(self, mode: str | None = "instance") -> None:
        for m in self.modules():
            if isinstance(m, GroupNorm):
                m.export_mode = mode

    def condition(
        self, c_noise: torch.Tensor, c_aug: torch.Tensor, actions: torch.Tensor
    ) -> torch.Tensor:
        e = torch.cat(
            [self.noise_emb(c_noise), self.aug_emb(c_aug), self.act_emb(actions.flatten(1))], dim=-1
        )
        return self.cond_mlp(e)

    def forward(
        self,
        x: torch.Tensor,
        c_noise: torch.Tensor,
        context: torch.Tensor,
        c_aug: torch.Tensor,
        actions: torch.Tensor,
        mid_bias: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """x: (B,3,H,W) scaled noisy frame; context: (B,3L,H,W); actions: (B,L,A).
        ``mid_bias`` (B, C_mid) is added to the bottleneck: the hook used for activation
        steering ("editing the dream's mind")."""
        cond = self.condition(c_noise, c_aug, actions)
        inp = torch.cat([x, context], dim=1)
        pad = getattr(self, "_in_pad", 0)
        if pad:
            inp = torch.cat([inp, inp[:, :pad] * 0.0], dim=1)
        h = self.conv_in(inp)
        skips = []
        for i, level in enumerate(self.down):
            h = level(h, cond)
            skips.append(h)
            if i < len(self.downsample):
                h = self.downsample[i](h)
        h = self.mid1(h, cond)
        h = self.mid_attn(h)
        self._mid_activation = h  # probes read the same space that steering writes to
        if mid_bias is not None:
            h = h + mid_bias[:, :, None, None]
        h = self.mid2(h, cond)
        for j, level in enumerate(self.up):
            h = level(torch.cat([h, skips.pop()], dim=1), cond)
            if j < len(self.upsample):
                h = self.upsample[j](F.interpolate(h, scale_factor=2.0, mode="nearest"))
        return self.conv_out(F.silu(self.norm_out(h)))
