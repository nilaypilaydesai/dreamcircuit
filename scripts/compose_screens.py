"""Compose game screens (384x216 PNGs saved from the game canvas, or frames of the trailer) into one
of the README's figures, upscaled with nearest-neighbour sampling so the pixel art stays crisp. A
short last row is centred.

    python scripts/compose_screens.py docs/assets/game_screens.png --cols 2 \\
        runs/trailer/screen_title.png runs/trailer/screen_setup.png ...
    python scripts/compose_screens.py docs/assets/game_worlds.png --cols 3 \\
        runs/trailer/f_1224.png runs/trailer/f_0327.png ...
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def compose(out: Path, files: list[Path], cols: int, scale: int = 2, gap: int = 8) -> None:
    ims = [Image.open(f).convert("RGB") for f in files]
    w, h, g = ims[0].width * scale, ims[0].height * scale, gap * scale
    rows = [ims[i : i + cols] for i in range(0, len(ims), cols)]
    width = cols * w + (cols - 1) * g
    sheet = Image.new("RGB", (width, len(rows) * h + (len(rows) - 1) * g), (13, 17, 23))
    for r, row in enumerate(rows):
        x0 = (width - (len(row) * w + (len(row) - 1) * g)) // 2
        for c, im in enumerate(row):
            big = im.resize((w, h), Image.Resampling.NEAREST)
            sheet.paste(big, (x0 + c * (w + g), r * (h + g)))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, optimize=True)
    print(f"{out}: {sheet.width}x{sheet.height}, {out.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    raw = argparse.RawDescriptionHelpFormatter
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=raw)
    ap.add_argument("out", type=Path)
    ap.add_argument("files", type=Path, nargs="+")
    ap.add_argument("--cols", type=int, default=2)
    a = ap.parse_args()
    compose(a.out, a.files, a.cols)
