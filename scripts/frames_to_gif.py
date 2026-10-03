"""Cut the README's animated GIF from the trailer the cinema tool filmed: the frames it saved at
game resolution (f_0000.png, f_0003.png, ...) and its shot list (manifest.json).

    python scripts/frames_to_gif.py runs/trailer docs/assets/game_hero.gif

A stretch of each of the trailer's best shots, with hard cuts between them. Frames are upscaled
with nearest-neighbour sampling, so the pixel art stays crisp, and each stretch gets one palette
of its own (built from a mosaic of its frames): no flicker within a shot, and every world keeps
its hues."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

# (shot, first frame, end frame), counted from the shot's first clean (not cross-fading) frame
SEGMENTS = [
    ("a_launch", 0, 45),
    ("b_jump", 30, 90),
    ("c_bridge", 0, 30),
    ("g_garage", 21, 75),
    ("i_rocket", 0, 36),
    ("i_boomerang", 9, 51),
    ("i_bomb", 18, 60),
    ("i_shock", 0, 30),
    ("w_reef", 0, 27),
    ("m_tunnel", 9, 42),
    ("x_lava", 0, 36),
    ("x_boxes", 24, 72),
    ("x_rescue", 12, 96),
    ("p_podium", 45, 81),
]


def build(src: Path, out: Path, scale: int = 2) -> None:
    m = json.loads((src / "manifest.json").read_text())
    start = {s["name"]: s["start"] for s in m["shots"]}
    every = m["every"]
    frames: list[Image.Image] = []
    for shot, a, b in SEGMENTS:
        seg = []
        for k in range(a, b, every):
            i = (start[shot] + k) // every * every
            im = Image.open(src / f"f_{i:04d}.png").convert("RGB")
            seg.append(im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST))
        pick = seg[:: max(1, len(seg) // 6)]
        w, h = pick[0].size
        mosaic = Image.new("RGB", (w, h * len(pick)))
        for j, f in enumerate(pick):
            mosaic.paste(f, (0, j * h))
        pal = mosaic.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        frames += [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in seg]
    out.parent.mkdir(parents=True, exist_ok=True)
    ms = round(1000 * every / m["fps"])  # real time
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=ms,
        loop=0,
        optimize=False,
        disposal=1,
    )
    seconds, mb = len(frames) * ms / 1000, out.stat().st_size / 1e6
    print(f"{out}: {len(frames)} frames, {seconds:.1f} s, {mb:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--scale", type=int, default=2)
    a = ap.parse_args()
    build(a.src, a.out, a.scale)
