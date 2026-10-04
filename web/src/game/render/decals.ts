// Things that lie flat on the road, painted into the ground while the Mode-7 renderer draws it, so
// they sit in perspective under the karts that drive over them. Oil slicks: a dark, glossy
// puddle with a wobbly edge, a rainbow film that swirls slowly, and the sky shining in it. Where
// the road is not the ground (a deck, a climb, a jump ramp, the tunnel's tube) the same
// puddle is laid on it as faces instead.

import { hex, mix } from "../core/gfx";
import { RAMP_LEN, type Features } from "../race/features";
import type { Slick } from "../race/items";
import { HALF_WIDTH, SPACING, type Track } from "../world/track";
import { type P3, type Painter, face, toCamera } from "./poly";
import { normalAt, tubeBetween, tubePlace } from "./tube";

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

/** Whether the slick lies, even in part, on raised road (a deck, a climb, a jump ramp), where
 * the ground it would be painted into is hidden under the road. */
export function slickRaised(track: Track, f: Features, sl: Slick): boolean {
  if (sl.elev > 0.02) return true;
  const reach = R * 1.2, i = track.nearest(sl.x, sl.y, sl.idx), n = Math.ceil(reach / SPACING);
  for (let k = -n; k <= n; k++) if ((track.elev[track.wrap(i + k)] ?? 0) > 0.02) return true;
  if (Math.abs(track.offset(sl.x, sl.y, i)) > HALF_WIDTH + reach) return false;
  const s = track.s[i];
  return f.ramps.some((r) => s + reach > r.s0 && s - reach < r.s0 + RAMP_LEN);
}

/** The slick laid on the road as one decal: on raised road (``tube`` false) or round the tube. */
export function slickDecal(p: Painter, track: Track, f: Features, sl: Slick, t: number, heading: number, tube: boolean): void {
  const i0 = track.nearest(sl.x, sl.y, sl.idx);
  let at: (x: number, y: number) => P3, normal: P3;
  if (tube) {
    at = (x, y) => {
      const q = tubePlace(track, x, y, i0);
      return tubeBetween(track, q.i, q.w, q.u, 0.04).p;
    };
    normal = normalAt(track, i0, track.offset(sl.x, sl.y, i0));
  } else {
    at = (x, y) => {
      const i = track.nearest(x, y, i0, 8);
      const ramp = f.rampAt(track.s[i] + track.along(x, y, i), track.offset(x, y, i)).height;
      return [x, y, track.heightAt(x, y, i) + ramp + 0.03];
    };
    const [tx, ty] = track.tangent(i0), g = (at(sl.x + tx, sl.y + ty)[2] - at(sl.x - tx, sl.y - ty)[2]) / 2;
    normal = [-g * tx, -g * ty, 1]; // (tilted with the climb)
  }
  slickFaces(p, sl, t, heading, at, normal, !tube);
}

/** The puddle slickPaint paints, as faces: its rim, its body, the film's ring and the shine, laid
 * by ``at`` (a point of the flat road to where it lies, a little over the surface), facing
 * ``normal``. All one decal at one depth: on raised road just short of its near edge, so it is
 * drawn over every piece of road it lies on (each is sorted by its own far edge); round the tube
 * (whose panels are its backdrop) at its far edge, like a pad, so a kart on it is drawn over it. */
function slickFaces(p: Painter, sl: { x: number; y: number }, t: number, heading: number,
                    at: (x: number, y: number) => P3, normal: P3, raised: boolean): void {
  const N = 14, from = p.faces.length;
  const ang = (k: number) => -Math.PI + (2 * Math.PI * k) / N;
  const edge = (a: number) => R * (0.84 + 0.1 * Math.sin(3 * a + sl.x) + 0.06 * Math.sin(5 * a + sl.y));
  const P = (a: number, d: number): P3 => at(sl.x + Math.cos(a) * d, sl.y + Math.sin(a) * d);
  const mid = at(sl.x, sl.y), rim: P3[] = [];
  for (let k = 0; k < N; k++) rim.push(P(ang(k), edge(ang(k))));
  for (let k = 0; k < N; k++) face(p, [mid, rim[k], rim[(k + 1) % N]], RIM, normal);
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    face(p, [mid, P(a0, 0.88 * edge(a0)), P(a1, 0.88 * edge(a1))], PUDDLE, normal);
  }
  // the film's ring, swirling slowly, and its colors running round it
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1), am = (a0 + a1) / 2;
    const ring = (a: number, d: number) => P(a, (0.55 + 0.06 * Math.sin(2 * a + t * 1.4) + d) * edge(a));
    face(p, [ring(a0, -0.07), ring(a1, -0.07), ring(a1, 0.07), ring(a0, 0.07)],
         FILM[Math.floor(((am / (2 * Math.PI) + 0.5) * 10 + t * 1.5) % FILM.length)], normal);
  }
  // the sky shining on the far side of it
  const fx = Math.cos(heading), fy = Math.sin(heading), cx = sl.x + fx * 0.42 * R, cy = sl.y + fy * 0.42 * R;
  const Q = (al: number, ac: number): P3 => at(cx + (fx * al - fy * ac) * R, cy + (fy * al + fx * ac) * R);
  face(p, [Q(-0.09, -0.45), Q(0.09, -0.45), Q(0.09, 0.45), Q(-0.09, 0.45)], SHINE, normal);
  const mine = p.faces.slice(from);
  if (!mine.length) return;
  let z = -Infinity;
  if (raised) {
    let near = Infinity;
    for (const q of rim) near = Math.min(near, toCamera(p.cam, q[0], q[1], q[2])[0]);
    z = Math.max(0, near) - 0.35;
  } else {
    for (const fc of mine) z = Math.max(z, fc.z);
  }
  for (const fc of mine) fc.z = z;
}
