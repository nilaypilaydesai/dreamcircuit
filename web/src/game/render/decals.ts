// Things that lie flat on the road, painted into the ground while the Mode-7 renderer draws it, so
// they sit in perspective under the karts that drive over them. Oil slicks: a dark, glossy
// puddle with a wobbly edge, a rainbow film that swirls slowly, and the sky shining in it.

import { hex, mix } from "../core/gfx";

const R = 2.3; // m: a slick's size, about a third of the road across (it spins out karts within 2.1 m)
const PUDDLE = hex("#15131d"), RIM = hex("#2e2a3b"), SHINE = hex("#8d8fa8");
const FILM = ["#ff5fa2", "#ffd23f", "#5dff7a", "#63c8ff", "#c79bff"].map(hex);

/** A ground painter for these slicks at time ``t``, seen from a camera facing ``heading``
 * (the shine is the sky, on the far side of the puddle), or undefined when there are none. */
export function slickPaint(slicks: readonly { x: number; y: number }[], t: number, heading: number):
  ((x: number, y: number, c: number) => number) | undefined {
  if (!slicks.length) return undefined;
  const fx = Math.cos(heading), fy = Math.sin(heading);
  return (x, y, c) => {
    for (const sl of slicks) {
      const dx = x - sl.x, dy = y - sl.y;
      if (dx > R || dx < -R || dy > R || dy < -R) continue;
      const a = Math.atan2(dy, dx);
      const d = Math.hypot(dx, dy) / (R * (0.84 + 0.1 * Math.sin(3 * a + sl.x) + 0.06 * Math.sin(5 * a + sl.y)));
      if (d > 1) continue;
      if (d > 0.88) return mix(c, RIM, 0.85);
      if (Math.abs(d - 0.55 - 0.06 * Math.sin(2 * a + t * 1.4)) < 0.07) {
        return FILM[Math.floor(((a / (2 * Math.PI) + 0.5) * 10 + t * 1.5) % FILM.length)];
      }
      const along = (dx * fx + dy * fy) / R, across = (-dx * fy + dy * fx) / R;
      if (Math.abs(along - 0.42) < 0.09 && Math.abs(across) < 0.45) return SHINE;
      return PUDDLE;
    }
    return c;
  };
}
