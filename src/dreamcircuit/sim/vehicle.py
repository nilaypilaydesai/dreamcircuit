"""Vectorized single-track vehicle model of a rear-wheel-drive electric race car.

State layout (``n`` cars x 7, float64), body frame velocities:

    [x, y, psi, vx, vy, r, delta]
      x, y   world position of the CG (m)        psi    heading (rad, CCW from +x)
      vx, vy longitudinal / lateral speed (m/s)  r      yaw rate (rad/s)
      delta  front wheel steering angle (rad)

Above ~3 m/s the car follows a dynamic bicycle model with Pacejka-style lateral tyre forces and
a friction ellipse per axle (braking steals front grip, power steals rear grip, so the car can
understeer, oversteer and spin). Below ~1 m/s, where slip angles are ill-defined, it blends into
a kinematic bicycle model. The powertrain is torque-limited at low speed and power-limited
(80 kW) at high speed, with a motor speed limit; traction control and ABS cap each axle's
longitudinal force below its grip so some lateral grip always remains.

The TypeScript port in ``web/src/sim/vehicle.ts`` mirrors this function line by line and is
checked against golden trajectories from this file.
"""

from __future__ import annotations

import numpy as np

from dreamcircuit.config import VehicleParams

STATE_DIM = 7
X, Y, PSI, VX, VY, R, DELTA = range(STATE_DIM)


def steer_limit(vx: np.ndarray, p: VehicleParams) -> np.ndarray:
    """Speed-sensitive steering authority (rad), like a quickened rack with speed reduction."""
    return p.max_steer / (1.0 + np.maximum(vx, 0.0) / p.steer_speed_ref)


def step_vehicle(
    state: np.ndarray,
    action: np.ndarray,
    on_grass: np.ndarray,
    p: VehicleParams,
    dt: float,
    substeps: int,
) -> np.ndarray:
    """Advance ``state`` (n, 7) by one frame of ``dt`` seconds under ``action`` (n, 2).

    ``action[:, 0]`` is the steering command in [-1, 1] (positive = left) and ``action[:, 1]``
    the pedal in [-1, 1] (positive = throttle, negative = brake). Returns a new array.
    """
    x, y, psi, vx, vy, r, delta = (state[:, i].copy() for i in range(STATE_DIM))
    steer_cmd = np.clip(action[:, 0], -1.0, 1.0)
    pedal = np.clip(action[:, 1], -1.0, 1.0)
    throttle = np.maximum(pedal, 0.0)
    brake = np.maximum(-pedal, 0.0)

    mu = np.where(on_grass, p.mu_grass, p.mu)
    crr = np.where(on_grass, p.roll_res_grass, p.roll_res)
    wheelbase = p.lf + p.lr
    fz_f = p.mass * p.g * p.lr / wheelbase
    fz_r = p.mass * p.g * p.lf / wheelbase
    cap_f, cap_r = mu * fz_f, mu * fz_r

    delta_target = steer_cmd * steer_limit(vx, p)
    h = dt / substeps
    for _ in range(substeps):
        delta = delta + np.clip(delta_target - delta, -p.steer_rate * h, p.steer_rate * h)

        # Longitudinal forces at the contact patches.
        drive_cap = np.minimum(p.max_drive_force, p.max_power / np.maximum(vx, 1.0))
        # Slip angles (|vx| keeps the lateral force opposing sideways motion even when sliding
        # backwards after a spin).
        avx = np.abs(vx) + 1e-6
        alpha_f = delta - np.arctan2(vy + p.lf * r, avx)
        alpha_r = -np.arctan2(vy - p.lr * r, avx)

        # Stability-aware traction control and ABS keep grip in reserve for cornering: drive
        # torque is cut back when the rear axle is already working hard laterally.
        fy_r_demand = cap_r * np.sin(p.tire_c * np.arctan(p.tire_b_rear * alpha_r))
        lat_budget = np.sqrt(np.maximum(cap_r**2 - fy_r_demand**2, 0.0))
        drive = np.minimum(
            throttle * drive_cap * np.clip(p.top_speed - vx, 0.0, 1.0),
            p.traction_limit * np.maximum(lat_budget, 0.35 * cap_r),
        )
        roll_sign = np.tanh(vx / 0.3)
        brake_f = np.minimum(brake * p.max_brake_force * p.brake_front_bias, p.abs_limit * cap_f)
        brake_r = np.minimum(
            brake * p.max_brake_force * (1.0 - p.brake_front_bias), p.abs_limit * cap_r
        )
        fx_f = -brake_f * roll_sign
        fx_r = drive - brake_r * roll_sign

        # Lateral forces with the grip left over inside each axle's friction ellipse.
        dy_f = np.sqrt(np.maximum(cap_f**2 - fx_f**2, 0.0))
        dy_r = np.sqrt(np.maximum(cap_r**2 - fx_r**2, 0.0))
        fy_f = dy_f * np.sin(p.tire_c * np.arctan(p.tire_b_front * alpha_f))
        fy_r = dy_r * np.sin(p.tire_c * np.arctan(p.tire_b_rear * alpha_r))

        resist = p.drag * vx * np.abs(vx) + crr * p.mass * p.g * roll_sign
        cd, sd = np.cos(delta), np.sin(delta)

        # Dynamic bicycle model.
        vx_dyn = vx + h * ((fx_r + fx_f * cd - fy_f * sd - resist) / p.mass + vy * r)
        vy_dyn = vy + h * ((fy_r + fy_f * cd + fx_f * sd) / p.mass - vx * r)
        r_dyn = r + h * ((p.lf * (fy_f * cd + fx_f * sd) - p.lr * fy_r) / p.iz)

        # Kinematic bicycle model (exact at low speed, no tyre slip).
        vx_kin = vx + h * (fx_r + fx_f - resist) / p.mass
        td = np.tan(delta)
        vy_kin = vx_kin * p.lr * td / wheelbase
        r_kin = vx_kin * td / wheelbase

        w = np.clip((np.hypot(vx, vy) - 1.0) / 2.0, 0.0, 1.0)
        vx = w * vx_dyn + (1.0 - w) * vx_kin
        vy = w * vy_dyn + (1.0 - w) * vy_kin
        r = w * r_dyn + (1.0 - w) * r_kin

        c, s = np.cos(psi), np.sin(psi)
        x = x + h * (vx * c - vy * s)
        y = y + h * (vx * s + vy * c)
        psi = psi + h * r

    psi = (psi + np.pi) % (2 * np.pi) - np.pi
    return np.stack([x, y, psi, vx, vy, r, delta], axis=1)
