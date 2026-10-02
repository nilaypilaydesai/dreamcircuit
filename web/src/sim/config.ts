// Mirrors dreamcircuit/config.py. Loaded at runtime from assets/sim_config.json, which Python
// writes, so no physics or rendering constant is ever duplicated by hand on this side.

export interface VehicleParams {
  mass: number;
  iz: number;
  lf: number;
  lr: number;
  mu: number;
  mu_grass: number;
  tire_b_front: number;
  tire_b_rear: number;
  tire_c: number;
  max_drive_force: number;
  traction_limit: number;
  abs_limit: number;
  max_power: number;
  max_brake_force: number;
  brake_front_bias: number;
  top_speed: number;
  drag: number;
  roll_res: number;
  roll_res_grass: number;
  max_steer: number;
  steer_rate: number;
  steer_speed_ref: number;
  g: number;
  wheelbase: number;
}

export interface RenderConfig {
  size: number;
  meters_per_px: number;
  car_col: number;
  car_row: number;
  supersample: number;
  hud_rows: number;
}

export interface SimConfig {
  dt: number;
  substeps: number;
  vehicle: VehicleParams;
  render: RenderConfig;
  track: { half_width: number; ds: number };
}

export interface SpriteData {
  size: number;
  pixels: [index: number, r: number, g: number, b: number, alpha: number][];
}

/** numpy-compatible floating remainder (result takes the sign of the divisor). */
export function pyMod(a: number, m: number): number {
  let r = a % m;
  if (r !== 0 && r < 0 !== m < 0) r += m;
  return r;
}

export const clip = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
