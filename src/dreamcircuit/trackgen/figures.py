"""README figures for the circuit designer, one variant per GitHub theme.

    docs/assets/trackgen_growth_{light,dark}.png    lap 1: a figure-eight dreamed arc by arc
    docs/assets/trackgen_gallery_{light,dark}.png   dreamed circuits next to the architect's
    docs/assets/trackgen_style_{light,dark}.png     the same start, dreamed calm and wild

Written by ``dreamcircuit eval-tracks`` together with the numbers they illustrate.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import torch

from dreamcircuit.eval.report import THEMES, _save
from dreamcircuit.trackgen import architect as A
from dreamcircuit.trackgen.model import TrackDenoiser
from dreamcircuit.trackgen.train import (
    EXPECT,
    constant_style,
    live_arcs,
    live_generate,
    reconstruct,
)

GROWTH_STAGES = (0, 2, 4, 6)  # which built arcs to show (of 7)
PALETTES: dict[str, dict[str, Any]] = THEMES  # mixed str / list values, read per key


def _fonts() -> None:
    import matplotlib as mpl

    mpl.rcParams["font.family"] = "sans-serif"
    mpl.rcParams["font.sans-serif"] = ["Inter", "Helvetica Neue", "Helvetica", "Arial"]


def _blank(ax: Any, t: dict, half: float) -> None:
    ax.set_facecolor(t["surface"])
    ax.set_xlim(-half, half)
    ax.set_ylim(-half, half)
    ax.set_aspect("equal")
    ax.axis("off")


def _half(lines: list[np.ndarray], pad: float = 1.08) -> float:
    """Half-width of one square window (same scale everywhere) that fits every centered line."""
    return max(float(np.abs(c).max()) for c in lines) * pad


def _centered(c: np.ndarray) -> np.ndarray:
    return c - (c.max(axis=0) + c.min(axis=0)) / 2


def _start_line(ax: Any, c: np.ndarray, t: dict, half: float = 9.0) -> None:
    d = c[1] - c[0]
    d = d / (np.linalg.norm(d) + 1e-9)
    nx, ny = -d[1], d[0]
    ax.plot(
        [c[0, 0] - nx * half, c[0, 0] + nx * half],
        [c[0, 1] - ny * half, c[0, 1] + ny * half],
        color=t["ink"],
        lw=2.2,
        solid_capstyle="butt",
        zorder=8,
    )


def _draw_lap(ax: Any, dense: np.ndarray, t: dict, color: str, lw: float = 2.2) -> None:
    """A closed lap; at a crossing the later stretch (the bridge) is drawn over a gap."""
    ax.plot(*np.vstack([dense, dense[:1]]).T, color=color, lw=lw, solid_capstyle="round")
    for c in A.crossings(dense):
        k = int(14 / A.DS)
        seg = dense[np.arange(c.j - k, c.j + k + 1) % len(dense)]
        ax.plot(*seg.T, color=t["surface"], lw=lw + 3.5, solid_capstyle="butt", zorder=6)
        ax.plot(*seg.T, color=t["series"][0], lw=lw, solid_capstyle="butt", zorder=7)


def _runs(labels: np.ndarray) -> list[tuple[int, int, int]]:
    out, s = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[s]:
            out.append((s, i, int(labels[s])))
            s = i
    return out


def figure_growth(model: TrackDenoiser, device: torch.device, out: Path, seed: int = 2026) -> None:
    import matplotlib.pyplot as plt

    rng = np.random.default_rng(seed)
    trace: list[dict] = []
    pts = np.zeros((model.cfg.n, 2))
    for _ in range(6):  # the first figure-eight whose final lap is valid (seeded, so stable)
        trace = []
        pts, _r = live_generate(model, device, rng, "figure8", trace=trace)
        if A.check(reconstruct(pts), expect=1).ok:
            break
    n = model.cfg.n
    n_arcs = len(live_arcs(n))
    full = reconstruct(pts)
    shift = (full.max(axis=0) + full.min(axis=0)) / 2
    half = _half([full - shift])
    titles = [
        "Before the countdown:\nthe grid and first stretch",
        f"Lap 1: {GROWTH_STAGES[1] + 1} of {n_arcs} arcs",
        f"Lap 1: {GROWTH_STAGES[2] + 1} of {n_arcs} arcs",
        "The loop closes over a bridge:\nlocked for laps 2 and 3",
    ]
    _fonts()
    for mode, t in PALETTES.items():
        fig = plt.figure(figsize=(7.2, 2.9))
        fig.patch.set_facecolor(t["surface"])
        fig.text(
            0.03,
            0.93,
            "Lap 1: the designer builds the road ahead of the karts, then locks it",
            color=t["ink"],
            fontsize=12,
            fontweight="bold",
        )
        fig.text(
            0.03,
            0.86,
            "Solid: road already built. Blue: the arc just added, and the bridge. "
            "Dashed: the designer's guess for the rest of the lap",
            color=t["ink2"],
            fontsize=8.5,
        )
        for p, (stage, title) in enumerate(zip(GROWTH_STAGES, titles, strict=True)):
            snap = trace[min(stage, len(trace) - 1)]
            ax = fig.add_axes((0.02 + p * 0.245, 0.02, 0.23, 0.66))
            _blank(ax, t, half)
            dense = reconstruct(snap["guess"] - shift)
            m = len(dense)
            pt_of = np.round(np.arange(m) * (n / m)).astype(int) % n  # dense sample -> lap point
            built = snap["mask"][pt_of] > 0
            new = np.isin(pt_of, snap["arc"])
            label = np.where(new & built, 2, np.where(built, 1, 0))
            if p == len(GROWTH_STAGES) - 1:
                _draw_lap(ax, dense, t, t["ink2"], lw=3.0)
            else:
                for s, e, lab in _runs(label):
                    xy = dense[s : min(e + 1, m)]
                    if lab == 0:
                        ax.plot(*xy.T, color=t["muted"], lw=1.1, ls=(0, (2.5, 2.5)))
                    else:
                        color = t["series"][0] if lab == 2 else t["ink2"]
                        ax.plot(*xy.T, color=color, lw=3.0, solid_capstyle="round")
            _start_line(ax, dense, t)
            ax.set_title(title, color=t["ink2"], fontsize=8.5, loc="left", pad=2)
        _save(fig, out / f"trackgen_growth_{mode}.png")


def _row_figure(
    rows: list[tuple[str, list[np.ndarray]]],
    title: str,
    subtitle: str,
    path_stem: Path,
    colors: tuple[str, str] = ("ink2", "ink2"),
) -> None:
    import matplotlib.pyplot as plt

    half = _half([c for _, cs in rows for c in cs])
    per_row = max(len(cs) for _, cs in rows)
    w = 0.92 / per_row
    _fonts()
    for mode, t in PALETTES.items():
        fig = plt.figure(figsize=(7.2, 3.3))
        fig.patch.set_facecolor(t["surface"])
        fig.text(0.03, 0.93, title, color=t["ink"], fontsize=12, fontweight="bold")
        fig.text(0.03, 0.865, subtitle, color=t["ink2"], fontsize=8.5)
        for r, (name, cs) in enumerate(rows):
            fig.text(
                0.03, 0.6 - r * 0.4, name, color=t["ink2"], fontsize=9, rotation=90, va="center"
            )
            for k, c in enumerate(cs):
                ax = fig.add_axes((0.06 + k * w, 0.43 - r * 0.4, w * 0.96, 0.36))
                _blank(ax, t, half)
                key = colors[r]
                _draw_lap(ax, c, t, t[key] if key in t else t["series"][int(key)])
        _save(fig, Path(f"{path_stem}_{mode}.png"))


def figure_gallery(dreamed: dict, real: dict, out: Path, per_kind: int = 3) -> None:
    """The first dreamed loops and figure-eights (not cherry-picked) above the architect's."""

    def pick(src: dict) -> list[np.ndarray]:
        return [
            _centered(reconstruct(np.asarray(p)))
            for kind in ("loop", "figure8")
            for p in src[kind][:per_kind]
        ]

    _row_figure(
        [("Dreamed", pick(dreamed)), ("Architect", pick(real))],
        "Dreamed circuits next to the architect's",
        f"Top: the designer's first {per_kind} loops and {per_kind} figure-eights, not "
        "cherry-picked. Bottom: circuits it never trained on. Blue: a bridge",
        out / "trackgen_gallery",
    )


def figure_style(
    model: TrackDenoiser, device: torch.device, out: Path, per_row: int = 5, seed: int = 7
) -> None:
    """Live circuits dreamed with the same seeds, asked for calm road and for wild road. Only
    seeds where both came out drivable are drawn (the subtitle says so); how often each style
    passes is measured separately, in the evaluation."""
    calm: list[np.ndarray] = []
    wild: list[np.ndarray] = []
    for k in range(60):
        pair = []
        for target in (0.1, 0.9):
            rng = np.random.default_rng(seed + k)
            pts, _r = live_generate(model, device, rng, "loop", style=constant_style(target))
            dense = reconstruct(pts)
            pair.append(dense if A.check(dense, expect=EXPECT["loop"]).ok else None)
        if pair[0] is not None and pair[1] is not None:
            calm.append(_centered(pair[0]))
            wild.append(_centered(pair[1]))
        if len(calm) == per_row:
            break
    _row_figure(
        [("Calm", calm), ("Wild", wild)],
        "The same dreams, asked for calm road and for wild road",
        "One random seed per column, both drivable. In the game, how you drive sets the style",
        out / "trackgen_style",
        colors=("ink2", "1"),
    )


def write_figures(
    model: TrackDenoiser, device: torch.device, result: dict, out: str | Path = "docs/assets"
) -> None:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    threads = torch.get_num_threads()
    if device.type == "cpu":
        torch.set_num_threads(1)
    try:
        figure_growth(model, device, out)
        figure_gallery(result["dreamed"], result["real"], out)
        figure_style(model, device, out)
    finally:
        torch.set_num_threads(threads)
