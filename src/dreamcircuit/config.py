"""Single source of truth for simulator constants.

Everything that both the Python simulator and the TypeScript port in ``web/`` must agree on
lives here. ``dreamcircuit export`` serializes these dataclasses to ``sim_config.json`` so the
browser never hard-codes a physics or rendering constant of its own.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class VehicleParams:
    """A Formula Student-class electric race car (rear-wheel drive), SI units."""

    mass: float = 300.0  # kg, car + driver
    iz: float = 160.0  # kg m^2, yaw inertia
    lf: float = 0.80  # m, CG to front axle
    lr: float = 0.75  # m, CG to rear axle
    mu: float = 1.6  # tyre/asphalt peak friction (slicks + light aero)
    mu_grass: float = 0.6
    tire_b_front: float = 8.0  # Pacejka-style stiffness factors; a stiffer rear axle gives the
    tire_b_rear: float = 12.0  # car a stable understeer balance (like real setup work)
    tire_c: float = 1.4  # Pacejka-style shape factor (>1 gives a mild post-peak drop)
    max_drive_force: float = 2200.0  # N at the rear contact patch
    traction_limit: float = 0.8  # traction control: drive force <= this share of rear grip
    abs_limit: float = 0.88  # ABS: brake force <= this share of each axle's grip
    max_power: float = 80_000.0  # W, the FSAE-EV accumulator power cap
    max_brake_force: float = 4000.0  # N, total
    brake_front_bias: float = 0.55
    top_speed: float = 30.0  # m/s, motor speed limit (108 km/h)
    drag: float = 0.75  # N / (m/s)^2, 0.5 * rho * CdA
    roll_res: float = 0.015
    roll_res_grass: float = 0.12
    max_steer: float = 0.42  # rad at the wheels
    steer_rate: float = 1.6  # rad/s steering actuator slew limit
    steer_speed_ref: float = 10.0  # m/s; steering authority is max_steer / (1 + v / ref)
    g: float = 9.81

    @property
    def wheelbase(self) -> float:
        return self.lf + self.lr


@dataclass(frozen=True)
class RenderConfig:
    """Egocentric top-down camera: the car sits fixed near the bottom, pointing up."""

    size: int = 64  # output frames are size x size RGB
    meters_per_px: float = 0.5
    car_col: float = 32.0  # continuous pixel coords of the car's CG
    car_row: float = 46.0
    supersample: int = 2  # SxS samples per output pixel (anti-aliasing)
    hud_rows: int = 4  # bottom rows reserved for the speed / steering HUD


@dataclass(frozen=True)
class TrackSpec:
    ds: float = 0.5  # centerline sample spacing, m
    half_width: float = 4.0  # m
    min_radius: float = 9.0  # m, tightest allowed centerline radius
    clearance: float = 10.0  # m of grass between non-adjacent stretches of track
    tex_res: float = 0.25  # m per texture pixel
    margin: float = 34.0  # m of grass around the track's bounding box
    kerb_curvature: float = 1.0 / 26.0  # corners tighter than this radius get kerbs
    cone_spacing: float = 5.0  # m between cones along each edge
    cone_offset: float = 1.4  # m outside the track edge


@dataclass(frozen=True)
class SimConfig:
    dt: float = 1.0 / 15.0  # control / frame period, s (the world model runs at 15 Hz)
    substeps: int = 8  # physics substeps per frame
    vehicle: VehicleParams = field(default_factory=VehicleParams)
    render: RenderConfig = field(default_factory=RenderConfig)
    track: TrackSpec = field(default_factory=TrackSpec)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["vehicle"]["wheelbase"] = self.vehicle.wheelbase
        return d


DEFAULT = SimConfig()
