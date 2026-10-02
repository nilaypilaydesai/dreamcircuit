"""The circuit architect: lays out kart circuits from real track elements.

A lap is a sequence of features (hairpins, tight corners, sweepers, kinks, chicanes, esses,
double apexes) joined by straights. Every corner eases in and out of its curvature (a clothoid
transition), so the road never kinks. Corner angles are drawn first and scaled so the lap's total
turning is exact: +-2 pi for a plain loop, 0 for a figure-eight, +-4 pi for a lap that loops over
itself. Once the headings are fixed, the lap's end point is linear in the straights' lengths, so
those are solved (least squares with a minimum length) to close the lap exactly.

Figure-eights and loop-overs cross themselves once. The crossing is accepted only if it is steep
and both stretches are straight around it, which is what the game needs to build a bridge: the
later stretch climbs a ramp, crosses on a deck, and comes back down.

All lengths are model meters (the game drives circuits at 1.5x scale).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from dreamcircuit.config import DEFAULT, TrackSpec

DS = 0.5  # m, dense centerline spacing
MAX_FROM_START = 235.0  # m: the whole lap stays this close to the start line (game texture)
LENGTH_RANGE = (520.0, 980.0)  # m (plain loops are capped at 920 m)
LOOP_MAX = 920.0
# A bridge: ramp up, deck over the crossing, ramp down. The later stretch is the bridge.
BRIDGE_HALF = 34.0  # m of straight road needed either side of the crossing on the bridge
UNDER_HALF = 16.0  # m of straight road needed either side of the crossing underneath
CROSS_EXEMPT = 30.0  # m either side of a crossing where the two stretches may be close
CROSS_MIN_ANGLE = math.radians(50.0)
START_STRAIGHT = 48.0  # m of straight road the start line sits on

TOPOLOGIES = ("loop", "figure8")
_TURNING = {"loop": 2 * math.pi, "figure8": 0.0}
_CROSSINGS = {"loop": 0, "figure8": 1}

# Feature kinds: (turning range in degrees, radius range in m), per corner.
FEATURES: dict[str, tuple[tuple[float, float], tuple[float, float]]] = {
    "hairpin": ((150.0, 190.0), (9.0, 14.0)),
    "tight": ((60.0, 120.0), (11.0, 20.0)),
    "medium": ((35.0, 100.0), (20.0, 40.0)),
    "sweeper": ((40.0, 130.0), (40.0, 85.0)),
    "kink": ((8.0, 25.0), (60.0, 150.0)),
    "chicane": ((25.0, 55.0), (9.0, 18.0)),
    "esses": ((25.0, 60.0), (16.0, 32.0)),
    "double": ((40.0, 80.0), (14.0, 28.0)),
}
_FEATURE_P = {
    "hairpin": 0.13,
    "tight": 0.2,
    "medium": 0.18,
    "sweeper": 0.14,
    "kink": 0.08,
    "chicane": 0.1,
    "esses": 0.09,
    "double": 0.08,
}


@dataclass
class Piece:
    """A straight (``turn == 0``; its length may be solved for) or a corner of fixed shape."""

    turn: float = 0.0  # signed turning, rad (+ = left)
    radius: float = 0.0
    length: float = 0.0  # straights: the intended length before closing the lap
    free: bool = False  # a straight whose length closes the lap


@dataclass
class Layout:
    pieces: list[Piece] = field(default_factory=list)
    topology: str = "loop"
    # piece-index ranges that must each close on themselves (a figure-eight's two lobes)
    groups: list[tuple[int, int]] = field(default_factory=list)


def _corner(turn: float, radius: float) -> Piece:
    return Piece(turn=turn, radius=radius)


def _straight(length: float, free: bool = False) -> Piece:
    return Piece(length=length, free=free)


def _feature(kind: str, sign: float, rng: np.random.Generator) -> list[Piece]:
    (a0, a1), (r0, r1) = FEATURES[kind]
    ang = lambda: math.radians(rng.uniform(a0, a1))  # noqa: E731
    rad = lambda: rng.uniform(r0, r1)  # noqa: E731
    if kind == "chicane":
        r = rad()
        return [_corner(sign * ang(), r), _straight(rng.uniform(4, 12)), _corner(-sign * ang(), r)]
    if kind == "esses":
        out: list[Piece] = []
        for k in range(int(rng.integers(3, 5))):
            if k:
                out.append(_straight(rng.uniform(3, 10)))
            out.append(_corner((sign if k % 2 == 0 else -sign) * ang(), rad()))
        return out
    if kind == "double":
        return [
            _corner(sign * ang(), rad()),
            _straight(rng.uniform(10, 25)),
            _corner(sign * ang(), rad()),
        ]
    return [_corner(sign * ang(), rad())]


def _target_turning(topology: str, u: float) -> float:
    """Where the cumulative turning should be after a fraction ``u`` of the lap's features."""
    if topology == "figure8":  # around the left lobe, back through the crossing, around the right
        return 2 * math.pi * (2 * u if u <= 0.5 else 2 - 2 * u)
    return _TURNING[topology] * u


def random_layout(rng: np.random.Generator, topology: str) -> Layout:
    """Features whose directions follow the topology's turning profile, scaled to be exact."""
    kinds = list(_FEATURE_P)
    probs = np.array([_FEATURE_P[k] for k in kinds])
    probs /= probs.sum()
    n = int(rng.integers(6, 10)) + (2 if topology == "loopover" else 0)
    pieces: list[Piece] = []
    net = 0.0
    for k in range(n):
        long = rng.random() < 0.18
        pieces.append(_straight(rng.uniform(70, 130) if long else rng.uniform(10, 65), free=True))
        kind = str(rng.choice(kinds, p=probs))
        feat = _feature(kind, 1.0, rng)
        turn = sum(p.turn for p in feat)
        want = _target_turning(topology, (k + 1) / n) + rng.normal(0, 0.35)
        sign = 1.0 if abs(net + turn - want) <= abs(net - turn - want) else -1.0
        if abs(turn) < math.radians(30) and rng.random() < 0.3:
            sign = -sign  # kinks and chicanes may go either way
        for p in feat:
            p.turn *= sign
        net += sign * turn
        pieces.extend(feat)
    target = _TURNING[topology]
    if rng.random() < 0.5:  # mirror: clockwise laps and right-handed lobes are just as good
        for p in pieces:
            p.turn = -p.turn
        target = -target
    if not _scale_turning(pieces, target):
        return Layout([], topology)
    return Layout(pieces, topology)


def figure8_layout(rng: np.random.Generator) -> Layout:
    """Two lobes, one turning left and one right, that start and end at a shared crossing.

    Each lobe leaves the crossing on a straight, turns pi + theta (theta = the crossing angle),
    and comes back on a straight, so the two straights through the crossing are each one
    straight line and cross at theta. Each lobe closes on itself (its own free straights)."""
    kinds = [k for k in _FEATURE_P if k != "kink"]
    probs = np.array([_FEATURE_P[k] for k in kinds])
    probs /= probs.sum()
    theta = math.radians(rng.uniform(65, 115))
    pieces: list[Piece] = []
    groups: list[tuple[int, int]] = []
    first = 1.0 if rng.random() < 0.5 else -1.0
    for lobe, sign in enumerate((first, -first)):
        g0 = len(pieces)
        pieces.append(_straight(rng.uniform(BRIDGE_HALF + 4, BRIDGE_HALF + 14)))
        feats: list[Piece] = []
        n = int(rng.integers(2, 5))
        home = int(rng.integers(1, n)) if lobe == 0 and n > 1 else -1  # the start line's straight
        for k in range(n):
            if k:
                length = rng.uniform(78, 95) if k == home else rng.uniform(6, 35)
                feats.append(_straight(length, free=k != home))
            feats.extend(_feature(str(rng.choice(kinds, p=probs)), sign, rng))
        feats.insert(0, _straight(rng.uniform(6, 25), free=True))
        feats.append(_straight(rng.uniform(6, 25), free=True))
        if not _scale_turning(feats, sign * (math.pi + theta), (0.5, 1.8)):
            return Layout([], "figure8")
        pieces.extend(feats)
        pieces.append(_straight(rng.uniform(BRIDGE_HALF + 4, BRIDGE_HALF + 14)))
        groups.append((g0, len(pieces)))
    return Layout(pieces, "figure8", groups)


def _scale_turning(
    pieces: list[Piece], target: float, limits: tuple[float, float] = (0.6, 1.6)
) -> bool:
    """Scale the corners that turn the majority way so the signed total equals ``target``."""
    pos = sum(p.turn for p in pieces if p.turn > 0)
    neg = -sum(p.turn for p in pieces if p.turn < 0)
    if target > 0 or (target == 0 and pos >= neg):
        if pos <= 0:
            return False
        f = (target + neg) / pos
        grow = [p for p in pieces if p.turn > 0]
    else:
        if neg <= 0:
            return False
        f = (-target + pos) / neg
        grow = [p for p in pieces if p.turn < 0]
    if not limits[0] <= f <= limits[1]:
        return False
    for p in grow:
        p.turn *= f
        if abs(p.turn) > math.radians(200):
            return False
    return True


def _corner_kappa(p: Piece) -> np.ndarray:
    """Curvature samples of a corner: linear ease in, constant, linear ease out."""
    k = 1.0 / p.radius
    arc = abs(p.turn) * p.radius
    trans = min(10.0, 0.45 * arc)  # m of transition each side
    hold = arc - trans  # the transitions carry half their length's worth of turning
    n_t = max(round(trans / DS), 1)
    n_h = max(round(hold / DS), 0)
    ramp = (np.arange(n_t) + 0.5) / n_t * k
    kap = np.concatenate([ramp, np.full(n_h, k), ramp[::-1]])
    # exact turning after discretization
    kap *= abs(p.turn) / (kap.sum() * DS)
    return np.sign(p.turn) * kap


def build(layout: Layout, min_straight: float = 6.0) -> np.ndarray | None:
    """Dense closed centerline (M, 2) at DS spacing, starting anywhere, or None."""
    pieces = layout.pieces
    if not pieces:
        return None
    # Headings and fixed contributions, piece by piece.
    heading = 0.0
    dirs: list[np.ndarray | None] = []
    corner_k: list[np.ndarray | None] = []
    corner_disp: dict[int, np.ndarray] = {}
    for i, p in enumerate(pieces):
        if p.turn == 0.0:
            dirs.append(np.array([math.cos(heading), math.sin(heading)]))
            corner_k.append(None)
            continue
        kap = _corner_kappa(p)
        phi = heading + np.cumsum(kap) * DS - kap * DS / 2
        corner_disp[i] = np.array([np.cos(phi).sum(), np.sin(phi).sum()]) * DS
        heading += float(kap.sum() * DS)
        corner_k.append(kap)
        dirs.append(None)
    # Close each group (the whole lap, or each lobe of a figure-eight) with its own straights.
    lengths_by_piece: dict[int, float] = {}
    for g0, g1 in layout.groups or [(0, len(pieces))]:
        straights = [i for i in range(g0, g1) if pieces[i].turn == 0.0]
        u = np.stack([dirs[i] for i in straights], axis=1)  # (2, S)
        l0 = np.array([pieces[i].length for i in straights])
        free = np.array([pieces[i].free for i in straights])
        fixed_g = np.zeros(2)
        for i in range(g0, g1):
            if corner_k[i] is not None:
                fixed_g += corner_disp[i]
        sol = _close(u, l0, free, -fixed_g, min_straight)
        if sol is None or sol.max() > 200.0:
            return None
        lengths_by_piece.update(zip(straights, sol, strict=True))
    lengths = np.array([lengths_by_piece[i] for i in range(len(pieces)) if pieces[i].turn == 0.0])
    # Integrate the lap at DS spacing.
    kap_all = []
    li = 0
    for i, p in enumerate(pieces):
        if p.turn == 0.0:
            n = max(round(lengths[li] / DS), 1)
            kap_all.append(np.zeros(n))
            li += 1
        else:
            corner = corner_k[i]
            assert corner is not None
            kap_all.append(corner)
    kappa = np.concatenate(kap_all)
    phi = np.cumsum(kappa) * DS - kappa * DS / 2
    pts = np.cumsum(np.stack([np.cos(phi), np.sin(phi)], axis=1) * DS, axis=0)
    pts = np.vstack([np.zeros((1, 2)), pts[:-1]])
    gap = float(
        np.hypot(*(pts[-1] + np.array([math.cos(phi[-1]), math.sin(phi[-1])]) * DS - pts[0]))
    )
    if gap > 3.0:  # rounding of straight lengths to DS; anything larger is a failed solve
        return None
    # spread the small residual along the lap so it closes exactly
    resid = pts[0] - (pts[-1] + np.array([math.cos(phi[-1]), math.sin(phi[-1])]) * DS)
    pts += np.linspace(0, 1, len(pts))[:, None] * resid
    return pts


def _close(
    u: np.ndarray, l0: np.ndarray, free: np.ndarray, b: np.ndarray, lmin: float
) -> np.ndarray | None:
    """Straight lengths l >= lmin closest to l0 with u @ l == b (free ones move; others fixed)."""
    lengths = l0.copy()
    movable = free.copy()
    for _ in range(len(l0) + 1):
        idx = np.flatnonzero(movable)
        if len(idx) < 2:
            return None
        a = u[:, idx]
        rhs = b - u[:, ~movable] @ lengths[~movable]
        gram = a @ a.T
        if abs(np.linalg.det(gram)) < 1e-6:
            return None
        sol = l0[idx] + a.T @ np.linalg.solve(gram, rhs - a @ l0[idx])
        if sol.min() >= lmin:
            lengths[idx] = sol
            return lengths
        worst = idx[int(np.argmin(sol))]
        lengths[worst] = lmin
        movable[worst] = False
    return None


# ------------------------------------------------------------------------------- inspection


def curvature(pts: np.ndarray, ds: float = DS) -> np.ndarray:
    nxt, prv = np.roll(pts, -1, axis=0), np.roll(pts, 1, axis=0)
    d1 = (nxt - prv) / (2 * ds)
    d2 = (nxt - 2 * pts + prv) / ds**2
    sp = np.hypot(d1[:, 0], d1[:, 1])
    return (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / np.maximum(sp, 1e-9) ** 3


@dataclass(frozen=True)
class Crossing:
    i: int  # dense index on the first (earlier) stretch
    j: int  # dense index on the second (later) stretch: the bridge
    angle: float  # rad, 0..pi/2 is the acute angle between the stretches


def crossings(pts: np.ndarray, step: int = 4) -> list[Crossing]:
    """Self-intersections of the closed polyline (sub-sampled every ``step`` points)."""
    p = pts[::step]
    n = len(p)
    a, b = p, np.roll(p, -1, axis=0)
    out: list[Crossing] = []
    # vectorized segment-segment intersection, i < j, skipping neighbours
    d = b - a
    for i in range(n):
        js = np.arange(i + 2, n)
        if i == 0:
            js = js[js < n - 1]
        if len(js) == 0:
            continue
        r, s = d[i], d[js]
        q = a[js] - a[i]
        den = r[0] * s[:, 1] - r[1] * s[:, 0]
        ok = np.abs(den) > 1e-12
        t = np.where(ok, (q[:, 0] * s[:, 1] - q[:, 1] * s[:, 0]) / np.where(ok, den, 1), -1)
        w = np.where(ok, (q[:, 0] * r[1] - q[:, 1] * r[0]) / np.where(ok, den, 1), -1)
        hit = ok & (t >= 0) & (t < 1) & (w >= 0) & (w < 1)
        for jj in js[hit]:
            cosang = abs(float(r @ d[jj])) / (np.linalg.norm(r) * np.linalg.norm(d[jj]) + 1e-12)
            out.append(Crossing(i * step, int(jj) * step, math.acos(min(1.0, cosang))))
    return out


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str
    length: float
    crossings: tuple[Crossing, ...] = ()


def _arc_dist(i: int, j: int, n: int) -> int:
    d = abs(i - j)
    return min(d, n - d)


def check(
    pts: np.ndarray,
    spec: TrackSpec = DEFAULT.track,
    expect: int | None = None,
    start_free: bool = True,
) -> Verdict:
    """The architect's rules, on a dense closed centerline at DS spacing.

    ``expect`` is the number of crossings required (None: 0 or 1). ``start_free`` also requires
    the start line (index 0) to sit on straight road away from any crossing."""
    n = len(pts)
    length = n * DS
    if not LENGTH_RANGE[0] <= length <= (LENGTH_RANGE[1] if expect else LOOP_MAX):
        return Verdict(False, "length", length)
    if float(np.hypot(*(pts - pts[0]).T).max()) > MAX_FROM_START:
        return Verdict(False, "too big", length)
    kap = curvature(pts)
    if float(np.abs(kap).max()) > 1.0 / (spec.min_radius * 0.92):
        return Verdict(False, "too tight", length)
    cs = crossings(pts)
    want = expect if expect is not None else None
    if (want is not None and len(cs) != want) or len(cs) > 1:
        return Verdict(False, "crossings", length, tuple(cs))
    near_cross = np.zeros(n, dtype=bool)
    for c in cs:
        if c.angle < CROSS_MIN_ANGLE:
            return Verdict(False, "shallow crossing", length, tuple(cs))
        under, over = c.i, c.j  # the later stretch is the bridge
        for centre, half, lim in ((over, BRIDGE_HALF, 1 / 90), (under, UNDER_HALF, 1 / 50)):
            k = int(half / DS)
            idx = np.arange(centre - k, centre + k + 1) % n
            if float(np.abs(kap[idx]).max()) > lim:
                return Verdict(False, "bent crossing", length, tuple(cs))
        for centre in (over, under):
            k = int(max(CROSS_EXEMPT, BRIDGE_HALF) / DS)
            near_cross[np.arange(centre - k, centre + k + 1) % n] = True
        if min(_arc_dist(0, over, n), _arc_dist(0, under, n)) * DS < 80.0:
            return Verdict(False, "crossing at the start", length, tuple(cs))
    # clearance between stretches far apart along the lap, except at the crossing itself
    step = 4
    sub = np.arange(0, n, step)
    p = pts[sub]
    gap = np.abs(sub[:, None] - sub[None, :])
    gap = np.minimum(gap, n - gap) * DS
    dist = np.hypot(p[:, None, 0] - p[None, :, 0], p[:, None, 1] - p[None, :, 1])
    far = gap > 45.0
    exempt = near_cross[sub][:, None] & near_cross[sub][None, :]
    need = 2 * spec.half_width + spec.clearance * 0.9
    bad = far & ~exempt & (dist < need)
    if bad.any():
        return Verdict(False, "too close to itself", length, tuple(cs))
    if start_free:
        k = int(START_STRAIGHT / DS)
        idx = np.arange(-k, k // 2) % n
        if float(np.abs(kap[idx]).max()) > 1 / 120:
            return Verdict(False, "start not on a straight", length, tuple(cs))
    return Verdict(True, "", length, tuple(cs))


def place_start(pts: np.ndarray) -> np.ndarray | None:
    """Rotate the lap so index 0 is on its longest straight (grid behind it), heading +x."""
    n = len(pts)
    kap = np.abs(curvature(pts))
    straight = kap < 1 / 150
    for c in crossings(pts):  # never start (or grid) near a crossing: it is the bridge's place
        for centre in (c.i, c.j):
            k = int(90.0 / DS)
            straight[np.arange(centre - k, centre + k + 1) % n] = False
    if straight.all() or not straight.any():
        return None
    # longest run of straight samples, circularly
    s2 = np.concatenate([straight, straight])
    best, best_end, run = 0, 0, 0
    for i, v in enumerate(s2):
        run = run + 1 if v else 0
        if run > best and run <= n:
            best, best_end = run, i
    if best * DS < START_STRAIGHT + 28.0:
        return None
    # the line goes where the grid (48 m) fits behind it, at least 62% of the way along
    behind = max(int((START_STRAIGHT + 2.0) / DS), int(best * 0.62))
    start = (best_end - best + 1 + min(behind, best - int(24 / DS))) % n
    out = np.roll(pts, -start, axis=0) - pts[start]
    t = out[1] - out[-1]
    ang = math.atan2(t[1], t[0])
    co, si = math.cos(-ang), math.sin(-ang)
    return out @ np.array([[co, si], [-si, co]])


def resample(pts: np.ndarray, n: int) -> np.ndarray:
    """``n`` points evenly spaced by arc length around the closed loop, from index 0."""
    closed = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    st = np.arange(n) * (s[-1] / n)
    return np.stack([np.interp(st, s, closed[:, 0]), np.interp(st, s, closed[:, 1])], axis=1)


def generate(rng: np.random.Generator, topology: str, max_tries: int = 400) -> np.ndarray | None:
    """One valid dense centerline of the given topology (start at index 0, heading +x)."""
    for _ in range(max_tries):
        lay = figure8_layout(rng) if topology == "figure8" else random_layout(rng, topology)
        pts = build(lay)
        if pts is None or not LENGTH_RANGE[0] <= len(pts) * DS <= LENGTH_RANGE[1]:
            continue
        pts = place_start(pts)
        if pts is None:
            continue
        v = check(pts, expect=_CROSSINGS[topology])
        if v.ok:
            return pts
    return None


def turning_number(pts: np.ndarray) -> int:
    """Total turning of the closed loop, in whole turns (+1 a CCW loop, 0 a figure-eight)."""
    t = np.roll(pts, -1, axis=0) - pts
    ang = np.arctan2(t[:, 1], t[:, 0])
    d = (np.diff(np.concatenate([ang, ang[:1]])) + math.pi) % (2 * math.pi) - math.pi
    return round(float(d.sum()) / (2 * math.pi))
