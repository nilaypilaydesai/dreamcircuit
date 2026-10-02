"""Circuits as polar radius profiles, and the rules that make a circuit drivable.

Every procedural circuit winds once around its origin (control points are sorted by angle), so
it can be written as a radius function r(theta) sampled at ``N`` evenly spaced angles, with the
start/finish line at theta = 0 and the lap running counter-clockwise. That representation makes
any generated signal a closed loop by construction, and it makes "the road so far" a contiguous
arc of known samples: exactly the shape of an inpainting problem for a diffusion model.

The browser game (web/src/game/track.ts) implements the same reconstruction and validity checks.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from dreamcircuit.config import TrackSpec
from dreamcircuit.sim.track import _catmull_rom_closed, _frames, _min_clearance, _resample_closed

N_ANGLES = 128
R_MEAN, R_STD = 77.0, 23.5  # standardization of radii (meters), from the 60k training set


def angles(n: int = N_ANGLES) -> np.ndarray:
    return np.arange(n) * (2 * np.pi / n)


def to_polar(center: np.ndarray, n: int = N_ANGLES) -> np.ndarray | None:
    """Radius profile (n,) of a closed centerline whose first point is the start line.

    Returns ``None`` if the loop is not star-shaped about the origin (the polar angle must
    advance monotonically along the lap). Clockwise loops are mirrored to counter-clockwise."""
    phi = np.unwrap(np.arctan2(center[:, 1], center[:, 0]))
    if phi[-1] < phi[0]:  # clockwise: mirror across the x axis
        center = center * np.array([1.0, -1.0])
        phi = np.unwrap(np.arctan2(center[:, 1], center[:, 0]))
    if np.any(np.diff(phi) <= 0) or abs((phi[-1] - phi[0]) - 2 * np.pi) > 0.3:
        return None
    r = np.hypot(center[:, 0], center[:, 1])
    phi_c = np.concatenate([phi, [phi[0] + 2 * np.pi]])
    r_c = np.concatenate([r, [r[0]]])
    target = phi[0] + angles(n)
    return np.interp(target, phi_c, r_c)


def polar_points(r: np.ndarray) -> np.ndarray:
    th = angles(len(r))
    return np.stack([r * np.cos(th), r * np.sin(th)], axis=1)


def from_polar(r: np.ndarray, ds: float = 0.5) -> np.ndarray:
    """Dense closed centerline (M, 2), uniformly spaced, starting at the start line."""
    dense = _catmull_rom_closed(polar_points(r), n_per_seg=24)
    return _resample_closed(dense, ds)


@dataclass(frozen=True)
class Validity:
    length: float
    min_radius: float
    clearance: float
    ok: bool
    reason: str


def check(
    center: np.ndarray,
    spec: TrackSpec,
    min_radius: float | None = None,
    length_range: tuple[float, float] = (400.0, 1600.0),
) -> Validity:
    """The same constraints the procedural generator enforces, plus a length range."""
    min_radius = spec.min_radius * 0.92 if min_radius is None else min_radius
    _, _, curv = _frames(center, spec.ds)
    length = len(center) * spec.ds
    rmin = 1.0 / max(float(np.abs(curv).max()), 1e-9)
    clear = _min_clearance(center, spec.ds)
    need = 2 * spec.half_width + spec.clearance * 0.9
    reason = ""
    if not length_range[0] <= length <= length_range[1]:
        reason = "length"
    elif rmin < min_radius:
        reason = "too tight"
    elif clear < need:
        reason = "too close to itself"
    return Validity(length, rmin, clear, reason == "", reason)


def standardize(r: np.ndarray) -> np.ndarray:
    return (r - R_MEAN) / R_STD


def destandardize(u: np.ndarray) -> np.ndarray:
    return u * R_STD + R_MEAN
