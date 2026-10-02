// Port of dreamcircuit.sim.drivers.expert_action for one car: pure pursuit on an offset racing
// line plus a friction-limited speed profile. Used to drive "reality" clips in the browser.

import { clip } from "./config";
import type { CarEnv } from "./env";
import { PSI, VX, X, Y, steerLimit } from "./vehicle";

export function expertAction(env: CarEnv, aggression = 0.8, offset = 0,
                             horizonM = 70): [number, number] {
  const tr = env.track;
  const p = env.cfg.vehicle;
  const s = env.state;
  const v = Math.max(s[VX], 0);

  const look = clip(5.0 + 0.55 * v, 5.0, 16.0);
  const j = (env.idx + Math.round(look / tr.ds)) % tr.n;
  const tx = tr.cx[j] + offset * tr.nx[j];
  const ty = tr.cy[j] + offset * tr.ny[j];
  const dx = tx - s[X];
  const dy = ty - s[Y];
  const c = Math.cos(s[PSI]);
  const sn = Math.sin(s[PSI]);
  const fwd = dx * c + dy * sn;
  const lat = -dx * sn + dy * c;
  const alpha = Math.atan2(lat, fwd);
  const dist = Math.max(Math.hypot(fwd, lat), 1.0);
  const delta = Math.atan((2.0 * p.wheelbase * Math.sin(alpha)) / dist);
  let steer = delta / steerLimit(s[VX], p);
  if (Math.abs(alpha) > Math.PI / 2) steer = Math.sign(alpha);

  const k = Math.floor(horizonM / tr.ds);
  const muG = p.mu * p.g;
  let vTarget = 0.98 * p.top_speed;
  for (let i = 0; i < k; i++) {
    const kappa = Math.max(Math.abs(tr.curvature[(env.idx + i) % tr.n]), 1e-4);
    const vCorner = Math.sqrt((aggression * 0.92 * muG) / kappa);
    const vAllow = Math.sqrt(vCorner ** 2 + 2.0 * aggression * 0.75 * muG * i * tr.ds);
    vTarget = Math.min(vTarget, vAllow);
  }
  if (env.onGrass) vTarget = Math.min(vTarget, 9.0);
  const pedal = clip(0.6 * (vTarget - v), -1, 1);
  return [clip(steer, -1, 1), pedal];
}
