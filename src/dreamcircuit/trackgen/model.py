"""The circuit designer: a masked-conditional diffusion model over laps of road.

A lap is N (x, y) points evenly spaced along the road (start line at point 0, heading +x). The
network does not work on the points themselves but on the N steps between consecutive points
(point i to point i+1). Absolute coordinates span hundreds of meters, so a network that dreams
them misplaces the first new point after existing road by meters, which shows as a kink at
every join; a step is a few meters long, so continuing the road smoothly only asks the network
to keep a step similar to its neighbour, and position continuity holds by construction when
the steps are added up from the last known point (``from_steps``).
Input: the noisy steps, a 0/1 mask of which steps are already road, and those steps.
Output: the denoised steps. Training uses random known stretches, so one model does everything
the game needs: dream a whole circuit (nothing known), extend the road ahead of the karts
(the lap so far is known), and close the loop (both ends known, the gap in between unknown).
Any shape a road can take is expressible, including laps that cross themselves (bridges).

Two conditions steer it, each with a learned "don't care" so they are optional:
- style: how technical the road to be dreamed should be (0 calm, 1 wild), measured on the
  training circuits; the game sets it from how the player drives;
- layout: any, plain loop or figure-eight.

Convolutions use circular padding: the lap is periodic, so the generated road always meets
itself at the start line. Two positional channels (sin, cos of the point's place in the lap) let
the network know where the start/finish straight is.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from dreamcircuit.model.unet import FourierFeatures, zero_init

# loss emphasis where a new arc joins existing road: points within JOIN_REACH of known road
JOIN_WEIGHT = 9.0
SELF_COND_POS = 64.0  # steps of 2 m: positions fed back to a self-conditioning model, ~unit scale
JOIN_REACH = 12
JOIN_FADE = 3.0


@dataclass(frozen=True)
class TrackModelConfig:
    n: int = 256
    dims: int = 2  # x, y
    channels: tuple[int, ...] = (32, 64, 128, 192)
    blocks: int = 2
    cond_dim: int = 128
    kernel: int = 5
    scale: float = 2.0  # model meters per network unit of a step
    sigma_data: float = 1.0  # std of a step's components on the training laps, network units
    p_mean: float = -1.6  # log-normal noise levels, broad enough to train the fine detail too
    p_std: float = 1.6
    sigma_min: float = 0.002
    sigma_max: float = 40.0
    rho: float = 7.0
    # self-conditioning: the network also sees its previous estimate of the lap, as steps and
    # as the positions those steps add up to, so it can see the global shape it is drawing
    self_cond: bool = False


# --------------------------------------------------------------------- the representation


def step_mask(mask: np.ndarray) -> np.ndarray:
    """Points mask (..., N) -> steps mask: step i (point i to i+1) is known when both are."""
    return mask * np.roll(mask, -1, axis=-1)


def to_steps(points: np.ndarray, scale: float) -> np.ndarray:
    """Lap points (..., N, 2), meters -> the steps between them (..., N, 2), network units."""
    return (np.roll(points, -1, axis=-2) - points) / scale


def from_steps(
    u: np.ndarray, known: np.ndarray | None, mask: np.ndarray | None, scale: float
) -> np.ndarray:
    """Steps (N, 2), network units -> lap points (N, 2), meters.

    Known points stay exactly where they are. Each run of dreamed steps from one known point to
    the next is corrected evenly so that it lands on the known point at its end; with nothing
    known, the lap starts at the origin and the closing gap is spread over every step."""
    n = len(u)
    steps = u.astype(np.float64) * scale
    if known is None or mask is None or not mask.any():
        steps -= steps.sum(0) / n
        return np.concatenate([np.zeros((1, 2)), np.cumsum(steps[:-1], axis=0)])
    pts = np.where(mask[:, None] > 0, known, 0.0).astype(np.float64)
    known_step = step_mask(mask)
    for s in range(n):
        if mask[s] == 0 or known_step[s] > 0:
            continue  # runs of dreamed steps start at a known point whose step is dreamed
        run = [s]
        while mask[(run[-1] + 1) % n] == 0:
            run.append((run[-1] + 1) % n)
        end = (run[-1] + 1) % n
        seg = steps[run]
        seg += (known[end] - known[s] - seg.sum(0)) / len(run)
        p = known[s].astype(np.float64)
        for k, j in enumerate(run[1:]):
            p = p + seg[k]
            pts[j] = p
    return pts


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


LAYOUTS = ("any", "loop", "figure8")


def layout_onehot(layout: str | list[str], device: torch.device | str = "cpu") -> torch.Tensor:
    names = [layout] if isinstance(layout, str) else layout
    out = torch.zeros(len(names), len(LAYOUTS), device=device)
    for i, name in enumerate(names):
        out[i, LAYOUTS.index(name)] = 1.0
    return out


class TrackDenoiser(nn.Module):
    pos: torch.Tensor
    join_kernel: torch.Tensor

    def __init__(self, cfg: TrackModelConfig | None = None):
        super().__init__()
        self.cfg = cfg = cfg or TrackModelConfig()
        ch, k, d = cfg.channels, cfg.kernel, cfg.dims
        self.noise_emb = FourierFeatures(cfg.cond_dim, seed=3)
        self.style_emb = nn.Linear(2, cfg.cond_dim)  # (style * on, on)
        self.layout_emb = nn.Linear(len(LAYOUTS), cfg.cond_dim, bias=False)
        self.cond_mlp = nn.Sequential(
            nn.Linear(cfg.cond_dim, cfg.cond_dim), nn.SiLU(), nn.Linear(cfg.cond_dim, cfg.cond_dim)
        )
        th = torch.arange(cfg.n) * (2 * math.pi / cfg.n)
        self.register_buffer("pos", torch.stack([th.sin(), th.cos()])[None])
        gap = torch.arange(-JOIN_REACH, JOIN_REACH + 1).abs().float()
        join = torch.exp(-gap / JOIN_FADE)
        join[JOIN_REACH] = 0.0  # a point's own mask does not count
        self.register_buffer("join_kernel", (join * 2 / join.sum())[None, None], persistent=False)
        # noisy, mask, known, sin, cos (+ the previous estimate and its positions)
        self.inp = cconv(2 * d + 3 + (2 * d if cfg.self_cond else 0), ch[0], k)
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
        self.out = cconv(ch[0], d, k)
        zero_init(self.out)

    def set_export(self, on: bool = True) -> None:
        for m in self.modules():
            if isinstance(m, Norm):
                m.export_mode = on

    def network(
        self,
        x: torch.Tensor,
        c_noise: torch.Tensor,
        mask: torch.Tensor,
        known: torch.Tensor,
        style: torch.Tensor,
        style_on: torch.Tensor,
        layout: torch.Tensor,
        prev: torch.Tensor | None = None,
    ) -> torch.Tensor:
        sty = self.style_emb(torch.stack([style * style_on, style_on], dim=-1))
        cond = self.cond_mlp(self.noise_emb(c_noise) + sty + self.layout_emb(layout))
        pos = self.pos.expand(x.shape[0], -1, -1)
        parts = [x, mask, known, pos]
        if self.cfg.self_cond:
            prev = torch.zeros_like(x) if prev is None else prev
            # where the previous estimate puts each point, from the start line (about unit scale)
            where = (torch.cumsum(prev, dim=-1) - prev) / SELF_COND_POS
            parts += [prev, where]
        h = self.inp(torch.cat(parts, dim=1))
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
        self,
        x: torch.Tensor,
        sigma: torch.Tensor,
        mask: torch.Tensor,
        known: torch.Tensor,
        style: torch.Tensor | None = None,
        style_on: torch.Tensor | None = None,
        layout: torch.Tensor | None = None,
        prev: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """EDM-preconditioned D(x; sigma | known road, style, layout).

        x, known: (B, dims, N) in network units; mask: (B, 1, N); style, style_on: (B,);
        layout: (B, 3) one-hot over LAYOUTS. Missing conditions mean "don't care". ``prev`` is
        the previous estimate of the clean steps (self-conditioning models only; None: none)."""
        b = x.shape[0]
        if style is None or style_on is None:
            style = torch.zeros(b, device=x.device)
            style_on = torch.zeros(b, device=x.device)
        if layout is None:
            layout = layout_onehot(["any"] * b, x.device)
        sd = self.cfg.sigma_data
        s = sigma[:, None, None]
        c_skip = sd**2 / (s**2 + sd**2)
        c_out = s * sd / torch.sqrt(s**2 + sd**2)
        c_in = 1 / torch.sqrt(s**2 + sd**2)
        f = self.network(
            c_in * x, torch.log(sigma) / 4, mask, known * mask, style, style_on, layout, prev
        )
        # road that already exists is exactly itself: the network only ever dreams the rest
        return (c_skip * x + c_out * f) * (1 - mask) + known * mask

    def loss(
        self,
        x0: torch.Tensor,
        mask: torch.Tensor,
        style: torch.Tensor,
        style_on: torch.Tensor,
        layout: torch.Tensor,
    ) -> torch.Tensor:
        cfg = self.cfg
        b = x0.shape[0]
        sigma = torch.exp(torch.randn(b, device=x0.device) * cfg.p_std + cfg.p_mean)
        # only the road to be dreamed is noised: known road sits exactly where it is, in the
        # input as in the output, so a new arc is shaped around the real road it must join
        noisy = x0 + sigma[:, None, None] * torch.randn_like(x0) * (1 - mask)
        prev = None
        if cfg.self_cond:
            # half the time, show the network its own first estimate (no gradient through it)
            with torch.no_grad():
                first = self.denoise(noisy, sigma, mask, x0, style, style_on, layout)
            prev = first * (torch.rand(b, 1, 1, device=x0.device) < 0.5)
        d = self.denoise(noisy, sigma, mask, x0, style, style_on, layout, prev)
        w = (sigma**2 + cfg.sigma_data**2) / (sigma * cfg.sigma_data) ** 2
        # the few points where a new arc meets existing road decide whether the join is smooth,
        # but are a sliver of the loss: weight them up (about 10x next to the road, fading out)
        near = F.conv1d(F.pad(mask, (JOIN_REACH, JOIN_REACH), mode="circular"), self.join_kernel)
        per = ((d - x0) ** 2) * (1 - mask) * (1 + JOIN_WEIGHT * near.clamp(max=1.0))
        unknown = (1 - mask).sum((1, 2)).clamp(min=1.0) * x0.shape[1]
        return (w * per.sum((1, 2)) / unknown).mean()

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
        style: torch.Tensor | None = None,
        style_on: torch.Tensor | None = None,
        layout: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """Heun sampler (EDM Algorithm 1, no churn). The known road starts, and stays, exact."""
        sig = self.sigmas(steps).to(mask.device)
        x = torch.randn(known.shape, generator=generator).to(mask.device) * sig[0]
        x = x * (1 - mask) + known * mask
        cond = (style, style_on, layout)
        prev: torch.Tensor | None = None  # self-conditioning: the latest estimate

        def denoised(z: torch.Tensor, level: torch.Tensor) -> torch.Tensor:
            nonlocal prev
            out = self.denoise(z, level.expand(z.shape[0]), mask, known, *cond, prev)
            if self.cfg.self_cond:
                prev = out
            return out

        for i in range(steps):
            s, s_next = sig[i], sig[i + 1]
            d = (x - denoised(x, s)) / s
            x_next = x + (s_next - s) * d
            if s_next > 0:
                x0 = denoised(x_next, s_next)
                x_next = x + (s_next - s) * 0.5 * (d + (x_next - x0) / s_next)
            x = x_next
        return x * (1 - mask) + known * mask
