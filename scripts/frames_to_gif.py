"""Assemble the README's animated GIF from frames the cinema tool saved (gif_000.png, ...).

    python scripts/frames_to_gif.py runs/hero docs/assets/game_hero.gif --fps 15 --scale 2

Frames are upscaled with nearest-neighbour sampling, so the pixel art stays crisp, and each
gets its own adaptive palette, so every hue survives."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def build(src: Path, out: Path, fps: float, scale: int, colors: int = 192) -> None:
    files = sorted(src.glob("gif_*.png"))
    if not files:
        raise SystemExit(f"no gif_*.png frames in {src}")
    frames = [Image.open(f).convert("RGB") for f in files]
    frames = [f.resize((f.width * scale, f.height * scale), Image.NEAREST) for f in frames]
    # each frame gets its own palette: pixel art has few colours per frame, so they come out
    # exact, where one shared palette loses hues that appear in only part of the clip
    quantized = [
        f.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        for f in frames
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        out,
        save_all=True,
        append_images=quantized[1:],
        duration=round(1000 / fps),
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"{out}: {len(frames)} frames, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--fps", type=float, default=15)
    ap.add_argument("--scale", type=int, default=2)
    a = ap.parse_args()
    build(a.src, a.out, a.fps, a.scale)
