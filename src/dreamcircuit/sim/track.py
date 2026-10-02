"""Procedural race-circuit generation and rasterization.

A track is a closed centerline sampled every ``ds`` meters plus a top-down texture. Tracks are
star-shaped by construction (control points sorted by angle around an origin), smoothed with a
centripetal Catmull-Rom spline and a circular Gaussian, then rejection-sampled until they pass
two geometric checks: no corner tighter than ``min_radius`` and no two distant stretches of track
closer than ``clearance`` meters of grass.

Visual language follows Formula Student: blue cones on the left edge, yellow cones on the right,
red/white kerbs in tight corners and a checkered start line.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from dreamcircuit.config import TrackSpec

GRASS = np.array([62, 128, 70], dtype=np.float64)
ASPHALT = np.array([60, 62, 68], dtype=np.float64)
LINE = (232, 232, 232)
KERB_RED = (206, 44, 44)
KERB_WHITE = (236, 236, 236)
CONE_BLUE = (36, 108, 236)
CONE_YELLOW = (250, 204, 36)
CHECKER_DARK = (24, 24, 26)


@dataclass
class Track:
    center: np.ndarray  # (N, 2) centerline, uniformly spaced, closed (last != first)
    tangent: np.ndarray  # (N, 2) unit tangents (driving direction)
    normal: np.ndarray  # (N, 2) unit left normals
    curvature: np.ndarray  # (N,) signed curvature, 1/m; positive = left-hander
    ds: float
    half_width: float
    texture: np.ndarray  # (H, W, 3) uint8
    tex_origin: tuple[float, float]  # world (x_min, y_max) of the texture's top-left corner
    tex_res: float  # meters per texture pixel
    seed: int

    @property
    def n(self) -> int:
        return len(self.center)

    @property
    def length(self) -> float:
        return self.n * self.ds

    def world_to_tex(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Continuous texture coords (col, row); pixel centers sit at integer + 0.5."""
        col = (x - self.tex_origin[0]) / self.tex_res
        row = (self.tex_origin[1] - y) / self.tex_res
        return col, row

    def to_json_dict(self) -> dict:
        return {
            "seed": self.seed,
            "ds": self.ds,
            "half_width": self.half_width,
            "tex_origin": list(self.tex_origin),
            "tex_res": self.tex_res,
            # Full precision: the TS port localizes against these and must match bit-for-bit.
            "center": self.center.ravel().tolist(),
            "normal": self.normal.ravel().tolist(),
            "curvature": self.curvature.tolist(),
        }

    def save(self, stem: Path) -> None:
        """Write ``<stem>.json`` (geometry) and ``<stem>.png`` (texture) for the web app."""
        stem.parent.mkdir(parents=True, exist_ok=True)
        stem.with_suffix(".json").write_text(json.dumps(self.to_json_dict()))
        Image.fromarray(self.texture).save(stem.with_suffix(".png"), optimize=True)


# --------------------------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------------------------


def _catmull_rom_closed(pts: np.ndarray, n_per_seg: int = 48, alpha: float = 0.5) -> np.ndarray:
    """Centripetal Catmull-Rom spline through ``pts`` as a closed loop (no cusps/self-loops)."""
    k = len(pts)
    t = np.linspace(0.0, 1.0, n_per_seg, endpoint=False)[:, None]
    out = []
    for i in range(k):
        p0, p1, p2, p3 = pts[(i - 1) % k], pts[i], pts[(i + 1) % k], pts[(i + 2) % k]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** alpha
        t2 = t1 + np.linalg.norm(p2 - p1) ** alpha
        t3 = t2 + np.linalg.norm(p3 - p2) ** alpha
        tt = t1 + t * (t2 - t1)
        a1 = (t1 - tt) / (t1 - t0) * p0 + (tt - t0) / (t1 - t0) * p1
        a2 = (t2 - tt) / (t2 - t1) * p1 + (tt - t1) / (t2 - t1) * p2
        a3 = (t3 - tt) / (t3 - t2) * p2 + (tt - t2) / (t3 - t2) * p3
        b1 = (t2 - tt) / (t2 - t0) * a1 + (tt - t0) / (t2 - t0) * a2
        b2 = (t3 - tt) / (t3 - t1) * a2 + (tt - t1) / (t3 - t1) * a3
        out.append((t2 - tt) / (t2 - t1) * b1 + (tt - t1) / (t2 - t1) * b2)
    return np.concatenate(out, axis=0)


def _resample_closed(poly: np.ndarray, ds: float) -> np.ndarray:
    closed = np.vstack([poly, poly[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    n = max(round(float(s[-1]) / ds), 8)
    st = np.arange(n) * (s[-1] / n)
    return np.stack([np.interp(st, s, closed[:, 0]), np.interp(st, s, closed[:, 1])], axis=1)


def _smooth_closed(poly: np.ndarray, sigma_samples: float) -> np.ndarray:
    """Circular Gaussian smoothing via FFT (exact wrap-around, no edge effects)."""
    n = len(poly)
    idx = np.arange(n)
    d = np.minimum(idx, n - idx).astype(np.float64)
    kernel = np.exp(-0.5 * (d / sigma_samples) ** 2)
    kernel /= kernel.sum()
    kf = np.fft.rfft(kernel)
    return np.stack([np.fft.irfft(np.fft.rfft(poly[:, j]) * kf, n) for j in range(2)], axis=1)


def _frames(center: np.ndarray, ds: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    nxt, prv = np.roll(center, -1, axis=0), np.roll(center, 1, axis=0)
    d1 = (nxt - prv) / (2 * ds)
    d2 = (nxt - 2 * center + prv) / ds**2
    speed = np.hypot(d1[:, 0], d1[:, 1])
    tangent = d1 / speed[:, None]
    normal = np.stack([-tangent[:, 1], tangent[:, 0]], axis=1)
    curvature = (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / speed**3
    return tangent, normal, curvature


def _min_clearance(center: np.ndarray, ds: float, skip_arc: float = 45.0) -> float:
    """Smallest distance between centerline points that are > ``skip_arc`` m apart along track."""
    step = 4
    p = center[::step]
    n = len(p)
    idx = np.arange(n)
    gap = np.abs(idx[:, None] - idx[None, :])
    gap = np.minimum(gap, n - gap) * ds * step
    dist = np.hypot(p[:, None, 0] - p[None, :, 0], p[:, None, 1] - p[None, :, 1])
    far = gap > skip_arc
    return float(dist[far].min()) if far.any() else np.inf


def _random_centerline(rng: np.random.Generator, spec: TrackSpec) -> np.ndarray:
    k = int(rng.integers(8, 16))
    base = np.linspace(0.0, 2 * np.pi, k, endpoint=False)
    ang = base + rng.uniform(-0.32, 0.32, k) * (2 * np.pi / k)
    rad = rng.uniform(30.0, 115.0, k)
    pts = np.stack([rad * np.cos(ang), rad * np.sin(ang)], axis=1)
    pts *= rng.uniform(0.75, 1.25, 2)
    th = rng.uniform(0, 2 * np.pi)
    rot = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    pts = pts @ rot.T
    dense = _catmull_rom_closed(pts)
    center = _resample_closed(dense, spec.ds)
    center = _smooth_closed(center, sigma_samples=5.5 / spec.ds)
    return _resample_closed(center, spec.ds)


def sample_valid_centerline(
    rng: np.random.Generator, spec: TrackSpec, max_tries: int = 500
) -> np.ndarray:
    """Rejection-sample one valid circuit centerline (geometry only, no texture).

    The returned loop starts on the straightest 30 m of the lap and runs clockwise or
    counter-clockwise with equal probability. Consumes ``rng`` exactly as ``generate_track``
    always has, so seeds keep producing the same circuits."""
    for _ in range(max_tries):
        center = _random_centerline(rng, spec)
        _, _, curv = _frames(center, spec.ds)
        length = len(center) * spec.ds
        if not 450.0 <= length <= 1500.0:
            continue
        if np.abs(curv).max() > 1.0 / spec.min_radius:
            continue
        if _min_clearance(center, spec.ds) < 2 * spec.half_width + spec.clearance:
            continue
        if rng.random() < 0.5:  # drive clockwise half the time -> balanced left/right corners
            center = center[::-1].copy()
        # Put the start/finish line on the straightest stretch of the lap.
        _, _, curv = _frames(center, spec.ds)
        window = int(30.0 / spec.ds)
        straightness = np.convolve(
            np.abs(np.concatenate([curv, curv[:window]])), np.ones(window), mode="valid"
        )[: len(curv)]
        start = (int(np.argmin(straightness)) + window // 2) % len(center)
        return np.roll(center, -start, axis=0)
    raise RuntimeError("could not sample a valid circuit")


def generate_track(seed: int, spec: TrackSpec | None = None, max_tries: int = 500) -> Track:
    """Deterministically generate a valid circuit from ``seed``."""
    spec = spec or TrackSpec()
    rng = np.random.default_rng(seed)
    try:
        center = sample_valid_centerline(rng, spec, max_tries)
    except RuntimeError as err:
        raise RuntimeError(f"could not generate a valid track for seed {seed}") from err
    tangent, normal, curv = _frames(center, spec.ds)
    texture, origin = rasterize(center, normal, curv, spec, rng)
    return Track(
        center,
        tangent,
        normal,
        curv,
        spec.ds,
        spec.half_width,
        texture,
        origin,
        spec.tex_res,
        seed,
    )


# --------------------------------------------------------------------------------------------
# Rasterization
# --------------------------------------------------------------------------------------------


def _value_noise(rng: np.random.Generator, shape: tuple[int, int], cell_px: float) -> np.ndarray:
    """Smooth zero-mean noise in [-1, 1] with features of roughly ``cell_px`` pixels."""
    gh, gw = max(int(shape[0] / cell_px) + 2, 2), max(int(shape[1] / cell_px) + 2, 2)
    coarse = rng.uniform(-1.0, 1.0, (gh, gw)).astype(np.float32)
    img = Image.fromarray(coarse, mode="F").resize((shape[1], shape[0]), Image.Resampling.BICUBIC)
    return np.clip(np.asarray(img, dtype=np.float64), -1.0, 1.0)


def rasterize(
    center: np.ndarray,
    normal: np.ndarray,
    curvature: np.ndarray,
    spec: TrackSpec,
    rng: np.random.Generator,
) -> tuple[np.ndarray, tuple[float, float]]:
    """Paint the circuit at 2x resolution, then box-downsample for anti-aliasing."""
    ss = 2
    res = spec.tex_res / ss
    x_min, y_min = center.min(axis=0) - spec.margin
    x_max, y_max = center.max(axis=0) + spec.margin
    w = int(np.ceil((x_max - x_min) / spec.tex_res)) * ss
    h = int(np.ceil((y_max - y_min) / spec.tex_res)) * ss

    def px(p: np.ndarray) -> list[tuple[float, float]]:
        return list(
            zip(((p[:, 0] - x_min) / res).tolist(), ((y_max - p[:, 1]) / res).tolist(), strict=True)
        )

    hw = spec.half_width
    left, right = center + hw * normal, center - hw * normal
    signed_area = 0.5 * np.sum(
        center[:, 0] * np.roll(center[:, 1], -1) - np.roll(center[:, 0], -1) * center[:, 1]
    )
    outer, inner = (right, left) if signed_area > 0 else (left, right)

    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(px(outer), fill=255)
    md.polygon(px(inner), fill=0)
    road = np.asarray(mask, dtype=np.float64)[..., None] / 255.0

    # Two octaves of mottling give the network motion cues on otherwise flat surfaces.
    m_px = 1.0 / res
    grass_noise = 0.06 * _value_noise(rng, (h, w), 3.0 * m_px) + 0.05 * _value_noise(
        rng, (h, w), 14.0 * m_px
    )
    road_noise = 0.035 * _value_noise(rng, (h, w), 2.5 * m_px) + 0.03 * _value_noise(
        rng, (h, w), 10.0 * m_px
    )
    grass = GRASS * (1.0 + grass_noise[..., None])
    asphalt = ASPHALT * (1.0 + road_noise[..., None])
    base = grass * (1.0 - road) + asphalt * road
    img = Image.fromarray(np.clip(base + 0.5, 0, 255).astype(np.uint8), mode="RGB")
    d = ImageDraw.Draw(img)

    # Kerbs: red/white stripes just inside both edges wherever the corner is tight.
    n = len(center)
    tight = np.abs(curvature) > spec.kerb_curvature
    grow = int(4.0 / spec.ds)
    tight = (
        np.convolve(
            np.concatenate([tight[-grow:], tight, tight[:grow]]).astype(float),
            np.ones(2 * grow + 1),
            mode="valid",
        )
        > 0
    )
    stripe = int(1.5 / spec.ds)
    kerb_w = 1.0
    for i0 in range(0, n, stripe):
        if not tight[i0]:
            continue
        idx = np.arange(i0, i0 + stripe + 1) % n
        color = KERB_RED if (i0 // stripe) % 2 == 0 else KERB_WHITE
        for sign in (1.0, -1.0):
            edge = center[idx] + sign * hw * normal[idx]
            inside = center[idx] + sign * (hw - kerb_w) * normal[idx]
            d.polygon(px(np.vstack([edge, inside[::-1]])), fill=color)

    # Painted edge lines.
    line_px = max(round(0.35 / res), 1)
    for edge in (left, right):
        pts = px(np.vstack([edge, edge[:1]]))
        d.line(pts, fill=LINE, width=line_px, joint="curve")

    # Checkered start/finish line across the track at index 0.
    rows, cols, cell_len = 2, 8, 1.0
    tan0, nrm0 = np.array([normal[0, 1], -normal[0, 0]]), normal[0]
    for r in range(rows):
        a0 = -cell_len * rows / 2 + r * cell_len
        for c in range(cols):
            b0 = -hw + c * (2 * hw / cols)
            b1 = b0 + 2 * hw / cols
            quad = np.array(
                [
                    center[0] + a0 * tan0 + b0 * nrm0,
                    center[0] + (a0 + cell_len) * tan0 + b0 * nrm0,
                    center[0] + (a0 + cell_len) * tan0 + b1 * nrm0,
                    center[0] + a0 * tan0 + b1 * nrm0,
                ]
            )
            d.polygon(px(quad), fill=CHECKER_DARK if (r + c) % 2 else LINE)

    # Formula Student cones: blue on the left, yellow on the right.
    cone_r = 0.45 / res
    step = int(spec.cone_spacing / spec.ds)
    off = hw + spec.cone_offset
    for i in range(0, n - step // 2, step):
        for sign, color in ((1.0, CONE_BLUE), (-1.0, CONE_YELLOW)):
            cx, cy = px((center[i] + sign * off * normal[i])[None])[0]
            d.ellipse([cx - cone_r, cy - cone_r, cx + cone_r, cy + cone_r], fill=color)

    tex = np.asarray(img.reduce(ss), dtype=np.uint8).copy()
    return tex, (float(x_min), float(y_max))
