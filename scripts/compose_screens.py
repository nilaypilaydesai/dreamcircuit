"""Compose four game screens (384x216 PNGs saved from the game canvas) into the README's 2x2
figure, upscaled with nearest-neighbour sampling so the pixel art stays crisp.

    python scripts/compose_screens.py runs/hero docs/assets/game_screens.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

NAMES = ("screen_title", "screen_setup", "screen_race", "screen_results")


def compose(src: Path, out: Path, scale: int = 2, gap: int = 8) -> None:
    ims = [Image.open(src / f"{n}.png").convert("RGB") for n in NAMES]
    w, h = ims[0].width * scale, ims[0].height * scale
    sheet = Image.new("RGB", (2 * w + gap, 2 * h + gap), (11, 4, 32))
    for i, im in enumerate(ims):
        sheet.paste(im.resize((w, h), Image.NEAREST), ((i % 2) * (w + gap), (i // 2) * (h + gap)))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, optimize=True)
    print(f"{out}: {sheet.width}x{sheet.height}, {out.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    a = ap.parse_args()
    compose(a.src, a.out)
