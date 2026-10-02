"""The circuit designer: a masked-conditional diffusion model over polar radius profiles.

Input: a noisy profile, a 0/1 mask of which angles are already known, and those known values.
Output: the denoised profile. Training uses random known arcs, so one model does everything
the game needs: dream a whole circuit (nothing known), extend the road ahead of the karts
(the lap so far is known), and close the loop (both ends known, the gap in between unknown).

Convolutions use circular padding: the lap is periodic, so the generated road always meets
itself at the start line. Two positional channels (sin, cos of the angle) let the network know
where the start/finish straight is.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast

import torch
import torch.nn.functional as F
from torch import nn

from dreamcircuit.model.unet import FourierFeatures, zero_init


@dataclass(frozen=True)
class TrackModelConfig:
    n: int = 128
    channels: tuple[int, ...] = (64, 128, 192)
    blocks: int = 2
    cond_dim: int = 128
    kernel: int = 5
    sigma_data: float = 1.0
    p_mean: float = -1.2
    p_std: float = 1.2
    sigma_min: float = 0.002
    sigma_max: float = 40.0
    rho: float = 7.0


class Norm(nn.Module):
    """Affine-free GroupNorm for (B, C, L); InstanceNorm view on export, as in the U-Net."""

    def __init__(self, channels: int, groups: int = 8):
        super().__init__()
        self.groups = groups
        self.export_mode = False

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if not self.export_mode:
            return F.group_norm(x, self.groups, eps=1e-5)
        g = x.reshape(x.shape[0], self.groups, -1)
        return F.instance_norm(g, eps=1e-5).reshape_as(x)


def cconv(c_in: int, c_out: int, k: int) -> nn.Conv1d:
    return nn.Conv1d(c_in, c_out, k, padding=k // 2, padding_mode="circular")


class Block(nn.Module):
    def __init__(self, c_in: int, c_out: int, cond: int, k: int):
        super().__init__()
        self.n1, self.n2 = Norm(c_in), Norm(c_out)
        self.p1, self.p2 = nn.Linear(cond, 2 * c_in), nn.Linear(cond, 2 * c_out)
        zero_init(self.p1)
        zero_init(self.p2)
        self.c1, self.c2 = cconv(c_in, c_out, k), cconv(c_out, c_out, k)
        zero_init(self.c2)
        self.skip = nn.Conv1d(c_in, c_out, 1) if c_in != c_out else nn.Identity()

    def forward(self, x: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        s1, b1 = self.p1(cond)[:, :, None].chunk(2, 1)
        h = self.c1(F.silu(self.n1(x) * (1 + s1) + b1))
        s2, b2 = self.p2(cond)[:, :, None].chunk(2, 1)
        h = self.c2(F.silu(self.n2(h) * (1 + s2) + b2))
        return self.skip(x) + h


class Attention(nn.Module):
    def __init__(self, c: int, heads: int = 4):
        super().__init__()
        self.heads = heads
        self.norm = Norm(c)
        self.qkv = nn.Conv1d(c, 3 * c, 1)
        self.out = nn.Conv1d(c, c, 1)
        zero_init(self.out)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, c, n = x.shape
        q, k, v = self.qkv(self.norm(x)).reshape(b, 3, self.heads, c // self.heads, n).unbind(1)
        a = torch.softmax(q.transpose(-1, -2) @ k / math.sqrt(c // self.heads), dim=-1)
        return x + self.out((v @ a.transpose(-1, -2)).reshape(b, c, n))


class TrackDenoiser(nn.Module):
    pos: torch.Tensor

    def __init__(self, cfg: TrackModelConfig | None = None):
        super().__init__()
        self.cfg = cfg = cfg or TrackModelConfig()
        ch, k = cfg.channels, cfg.kernel
        self.noise_emb = FourierFeatures(cfg.cond_dim, seed=3)
        self.cond_mlp = nn.Sequential(
            nn.Linear(cfg.cond_dim, cfg.cond_dim), nn.SiLU(), nn.Linear(cfg.cond_dim, cfg.cond_dim)
        )
        th = torch.arange(cfg.n) * (2 * math.pi / cfg.n)
        self.register_buffer("pos", torch.stack([th.sin(), th.cos()])[None])
        self.inp = cconv(5, ch[0], k)
        self.down = nn.ModuleList()
        self.pool = nn.ModuleList()
        c_prev = ch[0]
        for i, c in enumerate(ch):
            self.down.append(
                nn.ModuleList(
                    [Block(c_prev if j == 0 else c, c, cfg.cond_dim, k) for j in range(cfg.blocks)]
                )
            )
            if i < len(ch) - 1:
                self.pool.append(nn.Conv1d(c, c, 4, stride=2, padding=1, padding_mode="circular"))
            c_prev = c
        self.mid = nn.ModuleList(
            [
                Block(ch[-1], ch[-1], cfg.cond_dim, k),
                Attention(ch[-1]),
                Block(ch[-1], ch[-1], cfg.cond_dim, k),
            ]
        )
        self.up = nn.ModuleList()
        self.unpool = nn.ModuleList()
        for i in reversed(range(len(ch))):
            c_up = ch[-1] if i == len(ch) - 1 else ch[i + 1]
            self.up.append(
                nn.ModuleList(
                    [
                        Block((c_up + ch[i]) if j == 0 else ch[i], ch[i], cfg.cond_dim, k)
                        for j in range(cfg.blocks)
                    ]
                )
            )
            if i > 0:
                self.unpool.append(cconv(ch[i], ch[i], 3))
        self.out_norm = Norm(ch[0])
        self.out = cconv(ch[0], 1, k)
        zero_init(self.out)

    def set_export(self, on: bool = True) -> None:
        for m in self.modules():
            if isinstance(m, Norm):
                m.export_mode = on

    def network(
        self, x: torch.Tensor, c_noise: torch.Tensor, mask: torch.Tensor, known: torch.Tensor
    ) -> torch.Tensor:
        cond = self.cond_mlp(self.noise_emb(c_noise))
        pos = self.pos.expand(x.shape[0], -1, -1)
        h = self.inp(torch.cat([x, mask, known, pos], dim=1))
        skips = []
        for i, blocks in enumerate(self.down):
            for blk in cast(nn.ModuleList, blocks):
                h = blk(h, cond)
            skips.append(h)
            if i < len(self.pool):
                h = self.pool[i](h)
        h = self.mid[0](h, cond)
        h = self.mid[1](h)
        h = self.mid[2](h, cond)
        for j, blocks in enumerate(self.up):
            h = torch.cat([h, skips.pop()], dim=1)
            for blk in cast(nn.ModuleList, blocks):
                h = blk(h, cond)
            if j < len(self.unpool):
                h = self.unpool[j](F.interpolate(h, scale_factor=2.0, mode="nearest"))
        return self.out(F.silu(self.out_norm(h)))

    def denoise(
        self, x: torch.Tensor, sigma: torch.Tensor, mask: torch.Tensor, known: torch.Tensor
    ) -> torch.Tensor:
        """EDM-preconditioned D(x; sigma | known arc). x, mask, known: (B, 1, N)."""
        sd = self.cfg.sigma_data
        s = sigma[:, None, None]
        c_skip = sd**2 / (s**2 + sd**2)
        c_out = s * sd / torch.sqrt(s**2 + sd**2)
        c_in = 1 / torch.sqrt(s**2 + sd**2)
        f = self.network(c_in * x, torch.log(sigma) / 4, mask, known * mask)
        return c_skip * x + c_out * f

    def loss(self, x0: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        cfg = self.cfg
        b = x0.shape[0]
        sigma = torch.exp(torch.randn(b, device=x0.device) * cfg.p_std + cfg.p_mean)
        noisy = x0 + sigma[:, None, None] * torch.randn_like(x0)
        d = self.denoise(noisy, sigma, mask, x0)
        w = (sigma**2 + cfg.sigma_data**2) / (sigma * cfg.sigma_data) ** 2
        per = ((d - x0) ** 2) * (1.0 - 0.9 * mask)  # the known arc is nearly free
        return (w[:, None, None] * per).mean()

    def sigmas(self, steps: int) -> torch.Tensor:
        c = self.cfg
        ramp = torch.linspace(0, 1, steps)
        lo, hi = c.sigma_min ** (1 / c.rho), c.sigma_max ** (1 / c.rho)
        return torch.cat([(hi + ramp * (lo - hi)) ** c.rho, torch.zeros(1)])

    @torch.no_grad()
    def sample(
        self,
        mask: torch.Tensor,
        known: torch.Tensor,
        steps: int = 24,
        generator: torch.Generator | None = None,
    ) -> torch.Tensor:
        """Heun sampler (EDM Algorithm 1, no churn). Known samples are pasted back at the end."""
        sig = self.sigmas(steps).to(mask.device)
        x = torch.randn(mask.shape, generator=generator).to(mask.device) * sig[0]
        for i in range(steps):
            s, s_next = sig[i], sig[i + 1]
            d = (x - self.denoise(x, s.expand(x.shape[0]), mask, known)) / s
            x_next = x + (s_next - s) * d
            if s_next > 0:
                d2 = (
                    x_next - self.denoise(x_next, s_next.expand(x.shape[0]), mask, known)
                ) / s_next
                x_next = x + (s_next - s) * 0.5 * (d + d2)
            x = x_next
        return x * (1 - mask) + known * mask
