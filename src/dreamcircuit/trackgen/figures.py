"""README figures for the circuit designer, one variant per GitHub theme.

    docs/assets/trackgen_growth_{light,dark}.png    lap 1: the circuit dreamed arc by arc
    docs/assets/trackgen_gallery_{light,dark}.png   dreamed circuits next to generated ones

Written by ``dreamcircuit eval-tracks`` together with the numbers they illustrate.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import torch

from dreamcircuit.eval.report import THEMES, _save
from dreamcircuit.trackgen.model import TrackDenoiser
from dreamcircuit.trackgen.polar import N_ANGLES, from_polar
from dreamcircuit.trackgen.train import live_arcs, live_generate

GROWTH_STAGES = (0, 2, 4, 6)  # which built arcs to show (of 7)
PALETTES: dict[str, dict[str, Any]] = THEMES  # mixed str / list values, read per key


def _fonts() -> None:
    import matplotlib as mpl

    mpl.rcParams["font.family"] = "sans-serif"
    mpl.rcParams["font.sans-serif"] = ["Inter", "Helvetica Neue", "Helvetica", "Arial"]


def _blank(ax: Any, t: dict, lim: float) -> None:
    ax.set_facecolor(t["surface"])
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    ax.set_aspect("equal")
    ax.axis("off")


def _start_line(ax: Any, c: np.ndarray, t: dict, half: float = 9.0) -> None:
    d = c[1] - c[0]
    d /= np.linalg.norm(d) + 1e-9
    nx, ny = -d[1], d[0]
    ax.plot(
        [c[0, 0] - nx * half, c[0, 0] + nx * half],
        [c[0, 1] - ny * half, c[0, 1] + ny * half],
        color=t["ink"],
        lw=2.2,
        solid_capstyle="butt",
        zorder=5,
    )


def _runs(labels: np.ndarray) -> list[tuple[int, int, int]]:
    """Contiguous runs (start, end exclusive, label) of a label sequence."""
    out, s = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[s]:
            out.append((s, i, int(labels[s])))
            s = i
    return out


def _segment_index(c: np.ndarray, n: int = N_ANGLES) -> np.ndarray:
    """Polar segment (j -> j+1) each dense centerline point lies on."""
    th = np.mod(np.arctan2(c[:, 1], c[:, 0]), 2 * np.pi)
    return np.floor(th / (2 * np.pi / n)).astype(int) % n


def figure_growth(model: TrackDenoiser, device: torch.device, out: Path, seed: int = 2026) -> None:
    import matplotlib.pyplot as plt

    trace: list[dict] = []
    live_generate(model, device, np.random.default_rng(seed), trace=trace)
    n_arcs = len(live_arcs(model.cfg.n))
    final = from_polar(trace[-1]["known"])
    lim = float(np.abs(final).max()) * 1.15
    titles = [
        "Before the countdown:\nthe grid and first stretch",
        f"Lap 1: {GROWTH_STAGES[1] + 1} of {n_arcs} arcs",
        f"Lap 1: {GROWTH_STAGES[2] + 1} of {n_arcs} arcs",
        "The loop closes:\nlocked for laps 2 and 3",
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
            "Solid: road already built. Blue: the arc just added. "
            "Dashed: the designer's current guess for the rest of the lap",
            color=t["ink2"],
            fontsize=8.5,
        )
        for p, (stage, title) in enumerate(zip(GROWTH_STAGES, titles, strict=True)):
            snap = trace[stage]
            ax = fig.add_axes((0.02 + p * 0.245, 0.02, 0.23, 0.66))
            _blank(ax, t, lim)
            c = from_polar(snap["guess"])
            seg = _segment_index(c)
            mask = snap["mask"] > 0
            built = mask[seg] & mask[(seg + 1) % N_ANGLES]
            new = np.isin(seg, snap["arc"]) & built
            label = np.where(new, 2, np.where(built, 1, 0))
            for s, e, lab in _runs(label):
                xy = c[s : min(e + 1, len(c))]
                if lab == 0:
                    ax.plot(*xy.T, color=t["muted"], lw=1.1, ls=(0, (2.5, 2.5)))
                else:
                    color = t["series"][0] if lab == 2 else t["ink2"]
                    ax.plot(*xy.T, color=color, lw=3.0, solid_capstyle="round")
            _start_line(ax, c, t)
            ax.set_title(title, color=t["ink2"], fontsize=8.5, loc="left", pad=2)
        _save(fig, out / f"trackgen_growth_{mode}.png")


def figure_gallery(dreamed: list, real: list, out: Path, per_row: int = 6) -> None:
    """The first ``per_row`` dreamed circuits (not cherry-picked) above as many real ones."""
    import matplotlib.pyplot as plt

    rows = [
        ("Dreamed", [np.asarray(r) for r in dreamed[:per_row]]),
        ("Generated", [np.asarray(r) for r in real[:per_row]]),
    ]
    lines = [[from_polar(r) for r in rs] for _, rs in rows]
    lim = max(float(np.abs(c).max()) for row in lines for c in row) * 1.08
    _fonts()
    for mode, t in PALETTES.items():
        fig = plt.figure(figsize=(7.2, 3.3))
        fig.patch.set_facecolor(t["surface"])
        fig.text(
            0.03,
            0.93,
            "Dreamed circuits next to the generator's",
            color=t["ink"],
            fontsize=12,
            fontweight="bold",
        )
        fig.text(
            0.03,
            0.865,
            f"Top: the designer's first {per_row} samples, not cherry-picked. Bottom: "
            "procedural circuits it never trained on. Same scale throughout",
            color=t["ink2"],
            fontsize=8.5,
        )
        for r, ((name, _), cs) in enumerate(zip(rows, lines, strict=True)):
            fig.text(
                0.03,
                0.6 - r * 0.4,
                name,
                color=t["ink2"],
                fontsize=9,
                rotation=90,
                va="center",
            )
            for k, c in enumerate(cs):
                ax = fig.add_axes((0.06 + k * 0.155, 0.43 - r * 0.4, 0.15, 0.36))
                _blank(ax, t, lim)
                ax.plot(*np.vstack([c, c[:1]]).T, color=t["ink2"], lw=2.2, solid_capstyle="round")
                _start_line(ax, c, t, half=7.0)
        _save(fig, out / f"trackgen_gallery_{mode}.png")


def write_figures(
    model: TrackDenoiser, device: torch.device, result: dict, out: str | Path = "docs/assets"
) -> None:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    figure_growth(model, device, out)
    figure_gallery(result["dreamed"], result["real"], out)
