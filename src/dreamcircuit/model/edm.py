"""EDM diffusion (Karras et al., 2022) wrapped around the U-Net, plus the few-step sampler.

The denoiser ``D(x; sigma)`` is parameterized with EDM preconditioning:

    D(x; sigma) = c_skip(sigma) * x + c_out(sigma) * F(c_in(sigma) * x, c_noise(sigma), ...)

which keeps network inputs and targets at unit variance at every noise level. DIAMOND showed
this formulation stays stable under long autoregressive rollouts with as few as 1-3 Euler steps,
which is what makes real-time play in a browser possible.

Context frames get Gaussian noise augmentation during training (GameNGen): the model is told the
augmentation level and learns to repair slightly-wrong context, which is exactly the situation
it faces when it consumes its own imperfect predictions during a rollout.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn

from dreamcircuit.model.unet import UNet, UNetConfig


@dataclass(frozen=True)
class EDMConfig:
    sigma_data: float = 0.5
    p_mean: float = -0.4  # log-normal training noise distribution (DIAMOND)
    p_std: float = 1.2
    sigma_min: float = 2e-3
    sigma_max: float = 5.0
    rho: float = 7.0
    aug_max: float = 0.3  # max std of context-frame noise augmentation (frames in [-1, 1])
    aug_prob: float = 0.7  # fraction of training samples with augmented context


def karras_sigmas(steps: int, e: EDMConfig) -> torch.Tensor:
    """Karras et al. noise schedule: ``steps`` levels from sigma_max to sigma_min, then 0.
    The browser's sampler (web/src/dream/engine.ts) implements the same formula."""
    if steps == 1:
        s = torch.tensor([e.sigma_max])
    else:
        ramp = torch.linspace(0, 1, steps)
        lo, hi = e.sigma_min ** (1 / e.rho), e.sigma_max ** (1 / e.rho)
        s = (hi + ramp * (lo - hi)) ** e.rho
    return torch.cat([s, torch.zeros(1)])


class WorldModel(nn.Module):
    def __init__(self, unet_cfg: UNetConfig | None = None, edm: EDMConfig | None = None):
        super().__init__()
        self.unet_cfg = unet_cfg or UNetConfig()
        self.edm = edm or EDMConfig()
        self.unet = UNet(self.unet_cfg)

    @property
    def context_frames(self) -> int:
        return self.unet_cfg.in_frames

    # ---------------------------------------------------------------------------------------
    def precondition(self, sigma: torch.Tensor) -> tuple[torch.Tensor, ...]:
        sd = self.edm.sigma_data
        s = sigma[:, None, None, None]
        c_skip = sd**2 / (s**2 + sd**2)
        c_out = s * sd / torch.sqrt(s**2 + sd**2)
        c_in = 1.0 / torch.sqrt(s**2 + sd**2)
        c_noise = torch.log(sigma) / 4.0
        return c_skip, c_out, c_in, c_noise

    def denoise(
        self,
        x: torch.Tensor,
        sigma: torch.Tensor,
        context: torch.Tensor,
        actions: torch.Tensor,
        aug_sigma: torch.Tensor,
        mid_bias: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """D(x; sigma | context, actions). x: (B,3,H,W) in [-1,1] units; context: (B,L,3,H,W)."""
        c_skip, c_out, c_in, c_noise = self.precondition(sigma)
        f = self.unet(
            c_in * x,
            c_noise,
            context.flatten(1, 2),
            aug_sigma / self.edm.aug_max,
            actions,
            mid_bias,
        )
        return c_skip * x + c_out * f

    def loss(
        self, target: torch.Tensor, context: torch.Tensor, actions: torch.Tensor
    ) -> torch.Tensor:
        """Denoising score-matching loss in EDM's F-space (uniform weighting over sigma)."""
        b = target.shape[0]
        dev = target.device
        e = self.edm
        sigma = torch.exp(torch.randn(b, device=dev) * e.p_std + e.p_mean)
        aug = torch.rand(b, device=dev) * e.aug_max
        aug = torch.where(torch.rand(b, device=dev) < e.aug_prob, aug, torch.zeros_like(aug))
        context = context + aug[:, None, None, None, None] * torch.randn_like(context)

        x_noisy = target + sigma[:, None, None, None] * torch.randn_like(target)
        c_skip, c_out, c_in, c_noise = self.precondition(sigma)
        f_target = (target - c_skip * x_noisy) / c_out
        f_pred = self.unet(c_in * x_noisy, c_noise, context.flatten(1, 2), aug / e.aug_max, actions)
        return ((f_pred - f_target) ** 2).mean()

    # ---------------------------------------------------------------------------------------
    def sigmas(self, steps: int, device: torch.device | str = "cpu") -> torch.Tensor:
        """Karras schedule from sigma_max down to sigma_min, with a trailing 0."""
        return karras_sigmas(steps, self.edm).to(device)

    @torch.no_grad()
    def sample_trajectory(
        self,
        context: torch.Tensor,
        actions: torch.Tensor,
        steps: int = 3,
        aug_sigma: float = 0.0,
        noise: torch.Tensor | None = None,
        mid_bias: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, list[torch.Tensor]]:
        """Euler sampler. Returns the next frame (B,3,H,W) in [-1,1] and the x0 estimate after
        every denoising step (what the browser's "watch it imagine" strip shows)."""
        b, _, c, h, w = context.shape
        dev = context.device
        sig = self.sigmas(steps, dev)
        x = (noise if noise is not None else torch.randn(b, c, h, w, device=dev)) * sig[0]
        aug = torch.full((b,), aug_sigma, device=dev)
        traj: list[torch.Tensor] = []
        for i in range(steps):
            s = sig[i].expand(b)
            x0 = self.denoise(x, s, context, actions, aug, mid_bias)
            traj.append(x0)
            x = x0 if sig[i + 1] == 0 else x + (x - x0) / sig[i] * (sig[i + 1] - sig[i])
        return x.clamp(-1, 1), traj

    @torch.no_grad()
    def sample(
        self,
        context: torch.Tensor,
        actions: torch.Tensor,
        steps: int = 3,
        aug_sigma: float = 0.0,
        noise: torch.Tensor | None = None,
        mid_bias: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """Generate the next frame (B,3,H,W) in [-1,1]."""
        return self.sample_trajectory(context, actions, steps, aug_sigma, noise, mid_bias)[0]

    @torch.no_grad()
    def rollout(
        self,
        frames: torch.Tensor,
        past_actions: torch.Tensor,
        future_actions: torch.Tensor,
        steps: int = 3,
        aug_sigma: float = 0.0,
        mid_bias: torch.Tensor | None = None,
    ) -> torch.Tensor:
        """Autoregressively dream ``T`` frames.

        frames: (B, L, 3, H, W) real context; past_actions: (B, L-1, A) actions between them;
        future_actions: (B, T, A). Returns dreamed frames (B, T, 3, H, W).
        """
        ctx, acts = frames, past_actions
        out = []
        for t in range(future_actions.shape[1]):
            a = torch.cat([acts, future_actions[:, t : t + 1]], dim=1)
            nxt = self.sample(ctx, a, steps=steps, aug_sigma=aug_sigma, mid_bias=mid_bias)
            out.append(nxt)
            ctx = torch.cat([ctx[:, 1:], nxt[:, None]], dim=1)
            acts = a[:, 1:]
        return torch.stack(out, dim=1)


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())


def estimate_macs(model: WorldModel, size: int = 64) -> float:
    """Multiply-accumulates of one denoiser call (conv + linear + attention), via hooks."""
    macs = 0.0

    def conv_hook(mod: nn.Conv2d, inp: tuple, out: torch.Tensor) -> None:
        nonlocal macs
        k = mod.kernel_size[0] * mod.kernel_size[1]
        macs += out.numel() * mod.in_channels * k / mod.groups

    def attn_hook(mod: nn.Module, inp: tuple, out: torch.Tensor) -> None:
        nonlocal macs
        b, c, h, w = inp[0].shape
        macs += 2 * b * (h * w) ** 2 * c

    hooks = []
    for m in model.modules():
        if isinstance(m, nn.Conv2d):
            hooks.append(m.register_forward_hook(conv_hook))
        elif m.__class__.__name__ == "SelfAttention":
            hooks.append(m.register_forward_hook(attn_hook))
    l = model.context_frames
    with torch.no_grad():
        model.denoise(
            torch.zeros(1, 3, size, size),
            torch.ones(1),
            torch.zeros(1, l, 3, size, size),
            torch.zeros(1, l, model.unet_cfg.action_dim),
            torch.zeros(1),
        )
    for h in hooks:
        h.remove()
    return macs
