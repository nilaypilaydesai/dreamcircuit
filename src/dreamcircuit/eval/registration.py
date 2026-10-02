"""Ego-motion from pixels by differentiable image registration.

For an egocentric top-down camera, consecutive frames are related by a rigid motion of the car.
If the car moved ``d = (df, dl)`` meters (forward, left) and turned ``dpsi`` radians, a ground point
seen at car-frame coordinates ``q`` in frame t+1 sat at ``R(dpsi) q + d`` in frame t:

    F_{t+1}(q) = F_t(R(dpsi) q + d)

We solve for (df, dl, dpsi) per frame pair: a coarse search over forward motion and rotation
seeds the estimate, then Adam refines all three through ``grid_sample`` on blurred frames. The
car sprite and the HUD are masked out, so the estimate uses only the world.

This turns any frame sequence, real or dreamed, into speed and yaw-rate signals, which is what
lets the audit ask whether a dream obeys the vehicle's physics.
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from dreamcircuit.config import DEFAULT, RenderConfig


def _base_grid(cfg: RenderConfig, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    """Car-frame (forward, left) meters of every pixel center: two (H, W) tensors."""
    idx = torch.arange(cfg.size, device=device, dtype=torch.float32) + 0.5
    f = (cfg.car_row - idx)[:, None].expand(cfg.size, cfg.size) * cfg.meters_per_px
    l = (cfg.car_col - idx)[None, :].expand(cfg.size, cfg.size) * cfg.meters_per_px
    return f, l


def world_mask(cfg: RenderConfig, device: torch.device) -> torch.Tensor:
    """1 where a pixel shows the world, 0 on the car sprite and the HUD rows."""
    m = torch.ones(cfg.size, cfg.size, device=device)
    m[cfg.size - cfg.hud_rows - 1 :] = 0
    r0, c0 = int(cfg.car_row), int(cfg.car_col)
    m[r0 - 6 : r0 + 6, c0 - 4 : c0 + 4] = 0
    return m


def warp(
    src: torch.Tensor, params: torch.Tensor, cfg: RenderConfig = DEFAULT.render
) -> tuple[torch.Tensor, torch.Tensor]:
    """Resample frame-t images ``src`` (B, C, H, W) into frame t+1's view for motion
    ``params`` (B, 3) = (df, dl, dpsi). Returns (warped, valid) where valid marks pixels whose
    source lies inside frame t."""
    b = src.shape[0]
    f, l = _base_grid(cfg, src.device)
    df, dl, dpsi = params[:, 0, None, None], params[:, 1, None, None], params[:, 2, None, None]
    c, s = torch.cos(dpsi), torch.sin(dpsi)
    fs = c * f - s * l + df
    ls = s * f + c * l + dl
    row = cfg.car_row - fs / cfg.meters_per_px  # continuous pixel coordinates in frame t
    col = cfg.car_col - ls / cfg.meters_per_px
    gx = col / cfg.size * 2 - 1
    gy = row / cfg.size * 2 - 1
    grid = torch.stack([gx, gy], dim=-1).expand(b, -1, -1, -1)
    out = F.grid_sample(src, grid, mode="bilinear", padding_mode="border", align_corners=False)
    inside = (gx.abs() < 0.97) & (gy.abs() < 0.97) & (row < cfg.size - cfg.hud_rows - 1)
    return out, inside.float()


def _blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma <= 0:
        return x
    r = math.ceil(2.5 * sigma)
    k = torch.exp(-0.5 * (torch.arange(-r, r + 1, device=x.device, dtype=x.dtype) / sigma) ** 2)
    k = k / k.sum()
    c = x.shape[1]
    x = F.conv2d(
        F.pad(x, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c
    )
    return F.conv2d(
        F.pad(x, (0, 0, r, r), mode="replicate"), k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c
    )


def _loss(a: torch.Tensor, b: torch.Tensor, p: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    w, valid = warp(a, p)
    m = valid * mask
    return (((w - b) ** 2).mean(1) * m).sum((-2, -1)) / m.sum((-2, -1)).clamp_min(1.0)


@torch.no_grad()
def _coarse(a: torch.Tensor, b: torch.Tensor, mask: torch.Tensor, max_df: float) -> torch.Tensor:
    """Joint grid search over forward motion and rotation (they are confounded: a turn also
    shifts pixels sideways and up), then a 1-D search over lateral slip."""
    n = a.shape[0]
    dev = a.device
    dfs = torch.linspace(-1.0, max_df, 22, device=dev)
    dpsis = torch.linspace(-0.15, 0.15, 13, device=dev)
    best_loss = torch.full((n,), float("inf"), device=dev)
    best = torch.zeros(n, 3, device=dev)
    for df in dfs:
        for dpsi in dpsis:
            p = torch.zeros(n, 3, device=dev)
            p[:, 0], p[:, 2] = df, dpsi
            loss = _loss(a, b, p, mask)
            better = loss < best_loss
            best_loss = torch.where(better, loss, best_loss)
            best[better] = p[better]
    for dl in torch.linspace(-0.6, 0.6, 9, device=dev):
        p = best.clone()
        p[:, 1] = dl
        loss = _loss(a, b, p, mask)
        better = loss < best_loss
        best_loss = torch.where(better, loss, best_loss)
        best[better] = p[better]
    return best


def estimate_motion(
    frames_t: torch.Tensor, frames_t1: torch.Tensor, iters: int = 60, max_df: float = 2.6
) -> torch.Tensor:
    """Per-pair rigid ego-motion (B, 3) = (df [m], dl [m], dpsi [rad]) between float frames in
    [-1, 1] of shape (B, 3, H, W). Runs batched on the frames' device."""
    cfg = DEFAULT.render
    frames_t, frames_t1 = frames_t.detach(), frames_t1.detach()
    with torch.enable_grad():  # safe to call from inside torch.no_grad() evaluation code
        mask = world_mask(cfg, frames_t.device)
        a_c, b_c = _blur(frames_t, 1.2), _blur(frames_t1, 1.2)
        p0 = _coarse(a_c, b_c, mask, max_df)
        # Separate step sizes: 1 rad of rotation moves pixels far more than 1 m of translation.
        # (Scaling the gradient would do nothing: Adam is invariant to per-parameter scale.)
        trans = p0[:, :2].clone().requires_grad_(True)
        rot = p0[:, 2:].clone().requires_grad_(True)
        opt = torch.optim.Adam([{"params": [trans], "lr": 0.02}, {"params": [rot], "lr": 0.002}])
        a_f, b_f = _blur(frames_t, 0.6), _blur(frames_t1, 0.6)
        for i in range(iters):
            a, b = (a_c, b_c) if i < iters // 2 else (a_f, b_f)
            loss = _loss(a, b, torch.cat([trans, rot], dim=1), mask).sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
        p = torch.cat([trans, rot], dim=1)
    return p.detach()


def true_motion(states_t: torch.Tensor, states_t1: torch.Tensor) -> torch.Tensor:
    """Ground-truth (df, dl, dpsi) from simulator states (..., 7)."""
    dx = states_t1[..., 0] - states_t[..., 0]
    dy = states_t1[..., 1] - states_t[..., 1]
    c, s = torch.cos(states_t[..., 2]), torch.sin(states_t[..., 2])
    dpsi = torch.remainder(states_t1[..., 2] - states_t[..., 2] + math.pi, 2 * math.pi) - math.pi
    return torch.stack([dx * c + dy * s, -dx * s + dy * c, dpsi], dim=-1)
