"""Egocentric top-down renderer.

The camera is rigidly attached to the car: the car is drawn at a fixed pixel position pointing
up, and the world rotates and slides underneath it. That makes next-frame prediction a genuinely
hard problem for the world model: every pixel moves every frame, and new road must be invented at
the top edge as the car drives forward.

Each output pixel averages ``supersample**2`` bilinear texture taps. The bottom ``hud_rows`` hold
a speed bar (white, rows 60-61) and a steering-angle marker (amber, rows 62-63) on a solid
background. Exposing these two state variables in the frame lets the world model, and the physics
audit, read the dream's own speedometer exactly.
"""

from __future__ import annotations

import numpy as np

from dreamcircuit.config import RenderConfig, VehicleParams
from dreamcircuit.sim.track import Track

CAR_BODY = (255, 122, 24)  # papaya orange
CAR_CARBON = (28, 28, 32)
CAR_WING = (240, 240, 244)
SPEED_BAR = np.array([238.0, 238.0, 238.0])
STEER_MARK = np.array([255.0, 190.0, 40.0])
HUD_BG = np.array([18.0, 18.0, 22.0])


def car_sprite(cfg: RenderConfig, ss: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Anti-aliased top view of a small open-wheel car: (size, size, 3) color and (size, size, 1)
    alpha, both float64. Shapes are defined in car-frame meters (forward f, left l) from the CG."""
    n = cfg.size * ss
    sub = (np.arange(n) + 0.5) / ss
    f = ((cfg.car_row - sub) * cfg.meters_per_px)[:, None] * np.ones((1, n))
    l = np.ones((n, 1)) * ((cfg.car_col - sub) * cfg.meters_per_px)[None, :]

    def box(f0: float, f1: float, half_w: float) -> np.ndarray:
        return (f >= f0) & (f <= f1) & (np.abs(l) <= half_w)

    color = np.zeros((n, n, 3))
    alpha = np.zeros((n, n))
    layers = [
        (box(0.55, 1.05, 0.78) & (np.abs(l) >= 0.52), CAR_CARBON),  # front wheels
        (box(-1.0, -0.5, 0.80) & (np.abs(l) >= 0.52), CAR_CARBON),  # rear wheels
        (box(-1.30, 1.50, 0.34), CAR_BODY),  # monocoque
        (box(-0.95, 0.25, 0.56), CAR_BODY),  # sidepods
        (box(1.50, 1.78, 0.80), CAR_WING),  # front wing
        (box(-1.68, -1.34, 0.62), CAR_CARBON),  # rear wing
        ((f + 0.15) ** 2 + l**2 <= 0.2**2, CAR_CARBON),  # cockpit
    ]
    for mask, rgb in layers:
        color[mask] = rgb
        alpha[mask] = 1.0
    color = color.reshape(cfg.size, ss, cfg.size, ss, 3).mean(axis=(1, 3))
    alpha = alpha.reshape(cfg.size, ss, cfg.size, ss).mean(axis=(1, 3))
    # color holds alpha-premultiplied values after averaging; un-premultiply where visible.
    with np.errstate(invalid="ignore", divide="ignore"):
        color = np.where(alpha[..., None] > 0, color / alpha[..., None], 0.0)
    return color, alpha[..., None]


def draw_hud(
    img: np.ndarray, speed_frac: np.ndarray, steer_frac: np.ndarray, cfg: RenderConfig
) -> None:
    """In-place HUD over float frames (n, H, W, 3). Bars use fractional pixel coverage so that
    speed and steering are continuous (and recoverable to sub-pixel precision) in the image."""
    s, rows = cfg.size, cfg.hud_rows
    img[:, s - rows :] = HUD_BG
    cols = np.arange(s, dtype=np.float64)[None, :]
    bar_len = (s - 4) * np.clip(speed_frac, 0.0, 1.0)[:, None]
    cov = np.clip(bar_len - (cols - 2.0), 0.0, 1.0) * (cols >= 2) * (cols < s - 2)
    for row in (s - 4, s - 3):
        img[:, row] = img[:, row] * (1 - cov[..., None]) + SPEED_BAR * cov[..., None]
    mark = s / 2 - (s / 2 - 4) * np.clip(steer_frac, -1.0, 1.0)[:, None]
    cov = np.clip(np.minimum(cols + 1.0, mark + 1.0) - np.maximum(cols, mark - 1.0), 0.0, 1.0)
    for row in (s - 2, s - 1):
        img[:, row] = img[:, row] * (1 - cov[..., None]) + STEER_MARK * cov[..., None]


def read_hud(frames: np.ndarray, cfg: RenderConfig) -> tuple[np.ndarray, np.ndarray]:
    """Invert :func:`draw_hud` approximately: recover (speed_frac, steer_frac) from uint8 or float
    frames (..., H, W, 3). Used by the physics audit to read a dreamed speedometer."""
    s = cfg.size
    f = frames.astype(np.float64)
    bar = f[..., s - 4 : s - 2, 2 : s - 2, :].mean(axis=(-3, -1))  # (..., W-4)
    cov = np.clip((bar - HUD_BG.mean()) / (SPEED_BAR.mean() - HUD_BG.mean()), 0.0, 1.0)
    speed_frac = cov.sum(axis=-1) / (s - 4)
    red = f[..., s - 2 :, :, 0].mean(axis=-2)  # (..., W)
    amber = np.clip((red - HUD_BG[0]) / (STEER_MARK[0] - HUD_BG[0]), 0.0, 1.0)
    cols = np.arange(s) + 0.5
    pos = (amber * cols).sum(axis=-1) / np.maximum(amber.sum(axis=-1), 1e-6)
    steer_frac = (s / 2 - pos) / (s / 2 - 4)
    return speed_frac, steer_frac


class EgoRenderer:
    """Renders a batch of cars on one track to (n, size, size, 3) uint8 frames."""

    def __init__(self, track: Track, cfg: RenderConfig, vehicle: VehicleParams):
        self.cfg, self.vehicle, self.track = cfg, vehicle, track
        self.tex = track.texture.astype(np.float32).reshape(-1, 3)
        self.tex_h, self.tex_w = track.texture.shape[:2]
        n = cfg.size * cfg.supersample
        sub = (np.arange(n) + 0.5) / cfg.supersample
        self.fwd = ((cfg.car_row - sub) * cfg.meters_per_px).astype(np.float32)[None, :, None]
        self.left = ((cfg.car_col - sub) * cfg.meters_per_px).astype(np.float32)[None, None, :]
        rgb, a = car_sprite(cfg)
        self.sprite_rgb, self.sprite_alpha = rgb.astype(np.float32), a.astype(np.float32)

    def sample_world(self, x: np.ndarray, y: np.ndarray, psi: np.ndarray) -> np.ndarray:
        """Bilinear, supersampled view of the track texture: (n, size, size, 3) float32."""
        c = np.cos(psi).astype(np.float32)[:, None, None]
        s = np.sin(psi).astype(np.float32)[:, None, None]
        ox, oy = self.track.tex_origin
        wx = (x - ox).astype(np.float32)[:, None, None] + self.fwd * c - self.left * s
        wy = (oy - y).astype(np.float32)[:, None, None] - (self.fwd * s + self.left * c)
        col = wx / self.track.tex_res - 0.5
        row = wy / self.track.tex_res - 0.5
        c0 = np.floor(col)
        r0 = np.floor(row)
        fc = (col - c0)[..., None]
        fr = (row - r0)[..., None]
        c0i = np.clip(c0.astype(np.int32), 0, self.tex_w - 1)
        r0i = np.clip(r0.astype(np.int32), 0, self.tex_h - 1)
        c1i = np.clip(c0i + 1, 0, self.tex_w - 1)
        r1i = np.clip(r0i + 1, 0, self.tex_h - 1)
        t = self.tex
        top = t[r0i * self.tex_w + c0i] * (1 - fc) + t[r0i * self.tex_w + c1i] * fc
        bot = t[r1i * self.tex_w + c0i] * (1 - fc) + t[r1i * self.tex_w + c1i] * fc
        img = top * (1 - fr) + bot * fr
        k, ss = self.cfg.size, self.cfg.supersample
        return img.reshape(len(x), k, ss, k, ss, 3).mean(axis=(2, 4))

    def render(self, state: np.ndarray) -> np.ndarray:
        """Frames for vehicle states (n, 7) -> (n, size, size, 3) uint8."""
        from dreamcircuit.sim.vehicle import DELTA, PSI, VX, X, Y

        img = self.sample_world(state[:, X], state[:, Y], state[:, PSI]).astype(np.float64)
        img = img * (1 - self.sprite_alpha) + self.sprite_rgb * self.sprite_alpha
        speed_frac = np.maximum(state[:, VX], 0.0) / self.vehicle.top_speed
        steer_frac = state[:, DELTA] / self.vehicle.max_steer
        draw_hud(img, speed_frac, steer_frac, self.cfg)
        return np.floor(np.clip(img, 0, 255) + 0.5).astype(np.uint8)
