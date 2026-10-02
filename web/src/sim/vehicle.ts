// Line-by-line port of dreamcircuit/sim/vehicle.py (single car). See that file for the physics.
// Parity with Python is enforced by tests/sim.parity.test.ts against golden trajectories.

import { type VehicleParams, clip, pyMod } from "./config";

export const STATE_DIM = 7;
export const [X, Y, PSI, VX, VY, R, DELTA] = [0, 1, 2, 3, 4, 5, 6];

export function steerLimit(vx: number, p: VehicleParams): number {
  return p.max_steer / (1.0 + Math.max(vx, 0.0) / p.steer_speed_ref);
}

export function stepVehicle(state: Float64Array, steerCmdRaw: number, pedalRaw: number,
                            onGrass: boolean, p: VehicleParams, dt: number,
                            substeps: number): Float64Array {
  let [x, y, psi, vx, vy, r, delta] = state;
  const steerCmd = clip(steerCmdRaw, -1.0, 1.0);
  const pedal = clip(pedalRaw, -1.0, 1.0);
  const throttle = Math.max(pedal, 0.0);
  const brake = Math.max(-pedal, 0.0);

  const mu = onGrass ? p.mu_grass : p.mu;
  const crr = onGrass ? p.roll_res_grass : p.roll_res;
  const wheelbase = p.lf + p.lr;
  const fzF = (p.mass * p.g * p.lr) / wheelbase;
  const fzR = (p.mass * p.g * p.lf) / wheelbase;
  const capF = mu * fzF;
  const capR = mu * fzR;

  const deltaTarget = steerCmd * steerLimit(vx, p);
  const h = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    delta = delta + clip(deltaTarget - delta, -p.steer_rate * h, p.steer_rate * h);

    const driveCap = Math.min(p.max_drive_force, p.max_power / Math.max(vx, 1.0));
    const avx = Math.abs(vx) + 1e-6;
    const alphaF = delta - Math.atan2(vy + p.lf * r, avx);
    const alphaR = -Math.atan2(vy - p.lr * r, avx);

    const fyRDemand = capR * Math.sin(p.tire_c * Math.atan(p.tire_b_rear * alphaR));
    const latBudget = Math.sqrt(Math.max(capR ** 2 - fyRDemand ** 2, 0.0));
    const drive = Math.min(throttle * driveCap * clip(p.top_speed - vx, 0.0, 1.0),
                           p.traction_limit * Math.max(latBudget, 0.35 * capR));
    const rollSign = Math.tanh(vx / 0.3);
    const brakeF = Math.min(brake * p.max_brake_force * p.brake_front_bias, p.abs_limit * capF);
    const brakeR = Math.min(brake * p.max_brake_force * (1.0 - p.brake_front_bias),
                            p.abs_limit * capR);
    const fxF = -brakeF * rollSign;
    const fxR = drive - brakeR * rollSign;

    const dyF = Math.sqrt(Math.max(capF ** 2 - fxF ** 2, 0.0));
    const dyR = Math.sqrt(Math.max(capR ** 2 - fxR ** 2, 0.0));
    const fyF = dyF * Math.sin(p.tire_c * Math.atan(p.tire_b_front * alphaF));
    const fyR = dyR * Math.sin(p.tire_c * Math.atan(p.tire_b_rear * alphaR));

    const resist = p.drag * vx * Math.abs(vx) + crr * p.mass * p.g * rollSign;
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);

    const vxDyn = vx + h * ((fxR + fxF * cd - fyF * sd - resist) / p.mass + vy * r);
    const vyDyn = vy + h * ((fyR + fyF * cd + fxF * sd) / p.mass - vx * r);
    const rDyn = r + h * ((p.lf * (fyF * cd + fxF * sd) - p.lr * fyR) / p.iz);

    const vxKin = vx + (h * (fxR + fxF - resist)) / p.mass;
    const td = Math.tan(delta);
    const vyKin = (vxKin * p.lr * td) / wheelbase;
    const rKin = (vxKin * td) / wheelbase;

    const w = clip((Math.hypot(vx, vy) - 1.0) / 2.0, 0.0, 1.0);
    vx = w * vxDyn + (1.0 - w) * vxKin;
    vy = w * vyDyn + (1.0 - w) * vyKin;
    r = w * rDyn + (1.0 - w) * rKin;

    const c = Math.cos(psi);
    const s = Math.sin(psi);
    x = x + h * (vx * c - vy * s);
    y = y + h * (vx * s + vy * c);
    psi = psi + h * r;
  }
  psi = pyMod(psi + Math.PI, 2 * Math.PI) - Math.PI;
  return Float64Array.of(x, y, psi, vx, vy, r, delta);
}
