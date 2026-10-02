# Design notes

How Dream Circuit is built, why each decision was made, and what did not work. The README has
the results; this file has the reasoning.

## 1. Goals

- **A racing game whose tracks do not exist until you race them.** A diffusion model designs the
  circuit live, ahead of the karts, during lap 1, then locks it for laps 2 and 3. It should feel
  like a real retro kart racer, not like a demo with a racing skin.
- **A world model you can play.** Not a video, a game: your keys go in, the next frame comes out
  of a neural network, 15 times a second, in a browser tab with no server.
- **Worlds we can check exactly.** Big generative models are judged by how plausible their
  output looks. Training on our own procedural generator and simulator means every dreamed
  circuit can be checked against the generator's rules, and every dreamed frame has a ground
  truth, so sharper questions can be asked: does the dream keep the laws of motion, and does the
  network *know* the car's state?
- **Small enough to understand completely.** One laptop, a few hours of training, every
  component written from scratch and tested.

## 2. The circuit designer (`trackgen/`, `web/src/game/world/trackgen.ts`)

### Representation

Every procedural circuit is built from control points at sorted angles around an origin, so it
winds exactly once around it and can be written as a radius function r(theta), sampled at 128
evenly spaced angles, with the start line at theta = 0 and the lap running counter-clockwise
(clockwise circuits are mirrored). The representation was chosen for what it makes free:

- **Closure.** Any 128-vector is a closed loop. A model that output x/y points would have to
  learn to end where it started.
- **Inpainting.** "The road built so far" is a contiguous arc of known samples. Extending the
  road and closing the loop are both "fill in the unknown samples given the known ones", which
  diffusion models do well.
- **No self-intersection by construction.** A star-shaped loop cannot cross itself. What *can*
  go wrong is local: a corner that is too tight, or two stretches that pass too close. Both are
  checked.

The cost is expressiveness: no figure-eights, no hairpins that double back past the center
angle. For a kart racer that is the right trade.

### Data and model

`trackgen-data` samples 60,000 circuits from the simulator's own generator (geometry only, 3
minutes on 10 cores); 59,969 are star-shaped about their origin, and 5% are held out. Radii are
standardized (mean 77 m, standard deviation 23.5 m).

The denoiser is a 1-D U-Net (32/64/128 channels, two residual blocks per level, self-attention
at the bottleneck, 2.2M parameters). Every convolution uses **circular padding**: the lap is
periodic, so there is no edge for the network to see, and the road always meets itself.
Inputs are five channels: the noisy profile, a 0/1 mask of known angles, the known values
(masked), and sin/cos of the angle, so the network knows where the start straight is. The noise
level conditions every block through adaptive normalization, with EDM preconditioning
(`sigma_data = 1` on the standardized radii).

Training draws a random known arc for each example: none at all 20% of the time (dream a whole
circuit), otherwise one contiguous arc of 6 to 121 samples starting anywhere. The loss on known
samples is down-weighted to 10%: they are given, so the network should spend its capacity on
the rest. Half of the examples are mirrored (the same circuit driven the other way). AdamW, a
cosine schedule over 8,000 steps at batch 256, EMA 0.999: 20 minutes on the M4 Pro's GPU.

### Live generation

The game runs the procedure that `live_generate()` in Python mirrors exactly:

1. **Before the countdown:** the grid and the first stretch, angles -12 to 23. Twelve angles
   *behind* the line exist so that the start grid has road under it.
2. **During lap 1:** whenever the race leader is within 34 angles (27% of a lap) of the end of
   the road, the next 16 angles are dreamed, conditioned on everything known.
3. **The closing arc** is conditioned on both ends at once, the road so far and the grid, so it
   joins them smoothly.

Each arc is sampled with 24 Heun steps (47 network calls, EDM Algorithm 1 without churn). The
new samples are then smoothed with a small circular Gaussian (sigma = 1 sample, new arc only;
existing road never moves) and checked **in context**: the arc plus the designer's guess for the
still-unknown rest must form a valid circuit (corner radius at least 92% of the generator's 9 m,
at least 90% of its clearance between stretches, length 400 to 1600 m). Checking the arc
together with the guess for the rest catches an arc that would make closing the loop
impossible while it can still be resampled. A failing arc is resampled up to 3 times; after
that a sigma = 2 smoothing of the last sample is kept, so the race always goes on.

The game turns the known samples into road one Catmull-Rom segment at a time. Segment j (from
polar point j to j + 1) needs points j - 1 to j + 2, so it is committed, in driving order, as
soon as those four are known. Committed road is appended to the dense centerline (a point every
0.6 m, at 1.5x scale for kart-friendly widths) and never changes. When the last segment closes
the loop, the circuit is **locked**: lap counting switches to the closed loop, the far
landscape, start gantry and grandstand are placed, and laps 2 and 3 run on the same road.

### What did not work, and what did

- The first model, sampled with 12 Heun steps, built valid circuits 92% of the time. Most
  failures were one corner slightly too tight: high-frequency wiggles in r(theta) that a spline
  turns into a kink. Twice the sampler steps plus the light arc smoothing fixed most of them;
  whole-circuit validity rose to 98.4% (96.5% with the steps alone).
- A longer continuation run from the 8k checkpoint, with a fresh learning-rate schedule, scored
  *lower* partway through, while its learning rate was still high. It was stopped; the 8k model
  ships.

### In the browser

The designer is small (4.5 MB as fp16-stored ONNX), so it runs on ONNX Runtime Web's WASM
backend, on the main thread: the proxy-worker mode did not initialize under the dev server, and
it is not needed. The sampler awaits an animation frame before each network call, so dreaming an
arc costs every frame a few milliseconds instead of stalling one frame for a tenth of a second.
In a hidden tab there are no animation frames and timers are throttled, so there it runs flat
out (nothing is being drawn anyway). The first arc runs flat out too, during the "dreaming"
screen, in about 0.25 s.

Two safety nets cover slow devices. Race speed is capped by the distance left to the frontier,
so no kart can drive past road that does not exist yet. And the dream mist at the frontier hides
the unbuilt edge: the ground there shimmers into fog, and the road appears out of it.

## 3. The game (`web/src/game/`)

**Loop.** A fixed 60 Hz update with an accumulator, rendered once per animation frame into a
384x216 `Uint32Array` framebuffer that is blitted with `putImageData` and scaled up with
nearest-neighbor CSS, so every pixel stays square.

**Mode-7 ground.** Each scanline below the horizon is a line across the ground plane at distance
`z = h f / (y - horizon)` (camera 2.9 m up, focal length 250 px). The world is one 2048x2048
texture at 0.25 m per texel, painted when road is committed (grass noise, asphalt, kerbs on
corners tighter than 40 m, edge lines, the start checkers and grid slots) and mip-mapped, so each
row samples the level that matches its footprint. Distance fog blends into each world's horizon
color, and the frontier mist is a per-pixel term that pulses near the end of the dreamed road.

**Sprites.** Karts are tiny voxel models (body, wheels, driver, helmet in each livery's colors)
rendered from 16 directions at load time. The renderer picks the view from the angle between the
camera and the kart and leans the sprite with steering. Scenery (trees, rocks, cacti, crystals,
palms, lamps, chevron boards, the start gantry, grandstands) is painted with simple primitives.
Billboards are depth-sorted, scaled with distance and fogged, with drop shadows and drift
sparks. Nothing is a bitmap file.

**Scenery placement.** A spatial hash of the committed road decides what may stand where: trees
and rocks scatter near new road as it is committed (never on it), chevron boards go on the
outside of tight corners, and the distant landscape is placed once the circuit locks.

**Karts and rivals.** Arcade handling: acceleration toward a class top speed (Rookie 24, Pro 28,
Legend 32 m/s), slower surfaces off the asphalt (kerb, shoulder, grass), yaw rate limited by
grip over speed, and drifting: hold drift while steering to slide with a stronger turn, charge blue (0.7 s)
and orange (1.6 s) sparks, and release for a mini-turbo. Rivals follow a racing line that cuts
the inside of corners with pure pursuit, brake for a friction-limited speed profile with
braking-distance lookahead, make room for karts ahead of them, drift tight corners (one decision
per corner, held through it, released on exit), and rubber-band: far behind the player they find
6%, far ahead they lift 7%. A headless test drives a rival around a twisty circuit and requires
three clean laps, under 2% of the time on grass, and at least three drifts.

**Race.** A state machine: dreaming, countdown, racing, done. Positions sort by race distance;
laps count crossings of the start line by the sign change of the arc length past it, so backing
over the line un-counts a lap. The results screen estimates finishing times for anyone still on
track when the player finishes.

**Testing a game that does not paint.** The browser pane used for verification is hidden, and a
hidden page gets no animation frames. A dev-only hook (`window.__dc`, stripped from production
builds) advances the simulation a fixed number of steps with given keys held (or an AI pilot),
processes queued menu input and renders once, so whole races can be driven, measured and
captured deterministically.

## 4. The world

### Vehicle dynamics (`sim/vehicle.py`)

A single-track ("bicycle") model, vectorized over cars with NumPy, integrated with 8 semi-implicit
Euler substeps per 1/15 s frame:

- **Tyres.** Pacejka-style lateral force `D sin(C atan(B alpha))` per axle, with `C = 1.4` for a
  mild post-peak drop. Each axle has a friction ellipse: longitudinal force (braking at the front,
  drive and braking at the rear) eats into the lateral capacity `sqrt((mu Fz)^2 - Fx^2)`.
- **Powertrain.** Drive force is the smallest of the motor's 2.2 kN limit, the 80 kW power cap
  (the FSAE-EV accumulator limit) divided by speed, and traction control (about 1.9 kN on
  asphalt). In practice traction binds: the power cap would only bite above 36 m/s, beyond the
  30 m/s motor speed limit. Drag `0.5 rho CdA v^2` and rolling resistance, which is 8x higher on
  grass.
- **Low speed.** Slip angles are undefined at standstill, so below 1 m/s the model blends into a
  kinematic bicycle model (fully dynamic above 3 m/s). Without this, steering a stationary car
  makes it crawl sideways.

**What went wrong first, and why it matters.** The first version spun on straight lines at full
throttle. With the rear tyres at their traction limit, the friction ellipse left them zero lateral
grip, so the car was directionally unstable. Traction control, capping drive force at 80% of rear
grip, fixed that, but the car still spun on corner exits. The second cause was structural: with
cornering stiffness proportional to axle load, the car is exactly **neutral-steer**, and any
drive force tips it into oversteer. Its critical speed came out at about 24 m/s, inside the
operating range. Real race cars are set up to understeer, so the rear axle got a stiffer tyre
(B = 12 vs. 8) plus a stability-aware traction control that cuts torque when the rear is already
working hard laterally. That is the same idea as the yaw controllers FSAE electric teams run.
After that, a cautious driver laps without leaving the asphalt, and an over-aggressive one slides
off the way a real car would. Both are what the dataset needs.

### Circuits (`sim/track.py`)

Control points at sorted angles around an origin (so the loop is star-shaped and cannot
self-intersect), a centripetal Catmull-Rom spline (no cusps), a circular Gaussian smoothing
via FFT, uniform arc-length resampling every 0.5 m. Rejection sampling enforces two constraints:
no centerline radius below 9 m, and at least 10 m of grass between any two stretches of track
more than 45 m apart along the lap. The start line goes on the straightest 30 m of the lap.
Driving direction is flipped half the time so left and right corners are balanced.

Textures are painted at 2x with Pillow and box-downsampled for anti-aliasing: two octaves of
value noise on grass and asphalt (texture is what lets both the network and the registration
instrument perceive motion), red/white kerbs on corners tighter than 26 m, painted edge lines, a
checkered start line, and Formula Student cones: **blue on the left, yellow on the right**. The
world model learned this convention on its own. Dreamed cones are never on the wrong side.

### Renderer (`sim/render.py`)

The camera is rigidly attached to the car: the car is fixed near the bottom of the frame and the
world rotates and slides underneath it. This makes prediction hard on purpose: every pixel moves
every frame, and new road has to be invented at the top edge. Each output pixel averages 2x2
bilinear texture taps.

The bottom four rows are a HUD: a speed bar and a steering-angle marker, both drawn with
fractional pixel coverage so they are continuous in the image. That choice has two payoffs. It
makes the car's state observable, so the model does not have to infer speed from motion alone.
And it gives the physics audit a speedometer *inside the dream* to cross-examine: `read_hud`
decodes a frame's speed to 0.001 m/s.

### Drivers (`sim/drivers.py`)

The expert is privileged: pure pursuit on an offset racing line plus a friction-limited speed
profile with braking-distance lookahead. A dataset of perfect laps would teach the model nothing
about recovering from mistakes, so `MixedDriver` switches every few seconds between six
behaviors: tidy (aggression 0.5-0.88), keyboard-style (quantized to -1/0/1, which matches how
people play in the browser), over-driven (0.95-1.25, slides off), wandering (OU-noise steering),
emergency braking and coasting. A fifth of the episodes start from standstill. The result is
about 12% of frames on the grass, plus spins, slides and launches.

## 5. Data (`data/`)

360 training circuits x 8 cars x 161 frames = 463,680 frames, and 40 test circuits with
**disjoint seeds** x 4 cars x 241 frames. Workers each own one circuit and write straight into
shared `.npy` memmaps (frames, actions, states, privileged features), with no
gather-and-concatenate step. It takes 100 s on 10 cores. Training samples random 5-frame windows
from the memmap. A background thread prefetches them, and sorted reads keep the page cache happy.

## 6. The world model (`model/`)

**Why diffusion.** A deterministic next-frame regressor averages the futures it cannot
distinguish, so newly revealed road turns to grey mush. A diffusion model samples one plausible
future instead. Following DIAMOND, EDM (Karras et al., 2022) is used rather than DDPM: its
preconditioning keeps inputs and targets at unit variance for every noise level, and it stays
stable under long autoregressive rollouts with very few sampling steps.

**Architecture.** A 4-level U-Net at 64/32/16/8 px with 32/64/128/192 channels, two residual
blocks per level, and self-attention only at the 8x8 bottleneck. The noisy next frame (scaled by
`c_in`) is concatenated channel-wise with the 4 context frames. A conditioning vector from
Fourier features of `c_noise`, the context-noise level and an MLP over the last 4 actions feeds
adaptive GroupNorm (scale and shift) in every block. Output layers are zero-initialized so every
block starts as the identity. In total: 9.7M parameters and 1.84 GMACs per denoiser call.

**Context noise augmentation.** During training, 70% of samples get Gaussian noise of a random
standard deviation (up to 0.3) added to the context frames, and the model is told the level. At
play time the context holds the model's own slightly imperfect predictions; a model trained only
on clean context compounds its errors, while this one has learned to repair them (GameNGen).

**Sizing it for the hardware.** Measured on the M4 Pro's 16-core GPU (PyTorch MPS):

| Option | Effect |
|---|---|
| bf16 / fp16 autocast | no speedup on MPS (221 vs 224 ms/step) |
| `channels_last` | 54% slower |
| `torch.compile` | fails on MPS (Inductor Metal codegen error) |
| GroupNorm cost | 4% of the step: not the bottleneck |
| 1 vs. 2 blocks per level | 160 vs. 221 ms/step |

That leaves raw convolution throughput, about 2 TFLOP/s. The final model trains at 4.5 steps/s
at batch 32, so 60k steps take about 3.7 hours. The model size was picked so the browser also
runs it in real time: FLOPs at the 64x64 level dominate, so the first level is kept at 32
channels, and parameters live mostly in the cheap 8x8 level.

Training: AdamW (lr 2e-4, weight decay 0.01, betas 0.9/0.99), 1k warmup steps, cosine decay to
25%, gradient clipping at 1.0, EMA 0.9995. Evaluation and the browser both use the EMA weights.

## 7. In the browser (`export/`, `web/`)

**Export.** The ONNX graph computes the full preconditioned denoiser `D(x; sigma | context,
actions)`, so the browser's sampler is a 4-line Euler loop in TypeScript. Three transforms make
it fast and correct:

1. **GroupNorm as InstanceNormalization.** The PyTorch exporter's GroupNorm decomposes into about
   8 ops. Reshaping to `(B, groups, -1)` and calling `instance_norm` gives exactly the same
   function in one fused kernel. On WebGPU, per-kernel dispatch overhead dominates a model this
   size, so this cut compute ops from 825 to 597 and latency by 15%.
2. **fp16 storage, fp32 compute.** Initializers are rewritten as float16 plus `Cast` nodes, which
   ONNX Runtime constant-folds at load time. Half the download (19.6 MB), and it runs on GPUs
   without `shader-f16`.
3. **The WebGPU Conv workaround**, below.

**The ONNX Runtime Web bug.** The first in-browser run produced a different number on WebGPU
than on WASM for identical input, and the WASM result matched Python. `web/tools/ep-diff.html`
exposes all 471 intermediate tensors as graph outputs, runs both backends, and reports the first
node where they disagree: the very first convolution, whose inputs agreed exactly. A sweep of
single-conv models (`web/tools/conv-sweep.html`) then characterized it. **ONNX Runtime Web
1.30's WebGPU Conv is wrong whenever the input-channel count is divisible by 3 but not by 4**: 6,
9, 15 and 30 fail (errors above 1.0), while 1-5, 7, 8, 12, 13, 16 and 17 are exact to 1e-6.
The pattern points at a `vec3` load path in the generated WGSL, where `vec3<f32>` occupies 16
bytes in storage buffers. Our first conv sees 3 x (4 context + 1 noisy) = 15 channels. The
workaround is exact: zero-pad the input to 16 channels and add a zero weight slice. After it,
all 471 tensors match between backends. Reproduce it with `python
scripts/webgpu_diagnostics.py`.

**Performance.** About 9 ms per denoiser call on WebGPU (M4 Pro, Chrome) without contention, and
26 ms on multithreaded WASM. Two denoising steps per frame at a fixed 15 Hz leaves headroom.
The page shows live ms/frame and fps.

**Bit-exact simulator port.** The split screen needs reality in the browser too, so the
simulator was ported to TypeScript (`web/src/sim/`). Physics is float64 on both sides and agrees
to about 1e-15 over 90 steps. The renderer matched only after emulating NumPy's float32
semantics: `Math.fround` after every float32 operation, including the order in which NumPy
reduces the 2x2 supersample block. That order was measured, not assumed:
`((v00 + v01) + v10) + v11` matches 100% of pixels, while the obvious pairwise order matches
77%. Textures are decoded by a 70-line PNG decoder (`png.ts`) rather than `canvas.getImageData`,
which may color-manage or premultiply. Result: **0 of 258,048 pixel bytes differ**, enforced in
CI by `web/tests/sim.parity.test.ts`.

**One inference at a time.** The world model and the autopilot are two sessions on one ONNX
Runtime Web module. A run that started while another was in flight corrupted the module's
memory (`RuntimeError: memory access out of bounds`), and every later run on the page failed.
It surfaced when switching modes in the middle of a "Real or dream?" clip. All inference now
goes through one page-wide queue (`web/src/ort-queue.ts`); clips are cancellable, and a frame
imagined for a dream that has since been re-seeded is discarded rather than drawn.

**Attract mode.** With no input, a car coasts straight off the track, and the dream, correctly,
does the same. So the page opens with the pixel autopilot driving *inside the dream*, and the
first key press hands over the wheel.

## 8. The physics audit (`eval/`)

**The instrument.** For an egocentric top-down camera, consecutive frames are related by a rigid
motion: a point seen at car-frame coordinates `q` in frame t+1 sat at `R(dpsi) q + d` in frame t.
`estimate_motion` solves for `(df, dl, dpsi)` per frame pair. It runs a joint 22 x 13 grid search
over forward motion and rotation (searching them one after the other fails, because a turn also
shifts pixels sideways and up), then a 1-D search over slip, then 60 Adam steps through
`grid_sample` on blurred frames, with the car sprite and HUD masked out. Validated on 512 real
frame pairs near the track, it recovers speed with **R² = 0.999** (mean error 0.15 m/s) and yaw
rate with **R² = 0.999** (0.011 rad/s). Far out on featureless grass it degrades, so audits only
score windows near the circuit.

**Metrics.** Every metric is computed the same way on dreamed and real sequences, so the
instrument's own error appears as the "reality" number:

- *Fidelity.* PSNR and SSIM to the true future vs. horizon for 1-4 sampling steps, against a
  copy-the-last-frame baseline.
- *Motion.* Speed and yaw-rate error vs. the truth over 4 s.
- *Speedometer consistency.* The dreamed HUD speed vs. the dreamed ego-motion. A physically
  consistent dream agrees with itself.
- *Friction circle.* The share of transitions whose implied acceleration
  `sqrt((v r)^2 + (dv/dt)^2)` exceeds 1.25 mu g.
- *Controllability.* From identical context, five control sequences (left, straight, right,
  full throttle, full brake) are held for 1 s. The true simulator is rolled from the exact stored
  state with the same controls, and the yaw-rate and speed responses are compared: sign
  agreement, correlation and response ratio.

## 9. Inside the network (`eval/probes.py`)

**Probes.** The 8x8 bottleneck is average-pooled at the first sampling step, the moment the
network must imagine the next frame from pure noise. Ridge regressions (penalty chosen on a
validation split) are fit on training circuits and scored on held-out ones. Two controls keep
the result honest: the same probe on a *randomly initialized* network of the same architecture,
and a probe on the raw context pixels. Speed is excluded from the headline because it is drawn in
the HUD, so raw pixels decode it too. Yaw rate (motion between frames), slip, and curvature
beyond the view are not drawn anywhere, yet the trained network represents them.

**Steering, and a negative result.** Adding a probe's direction to the bottleneck during sampling
tests whether the network *uses* the representation. With the ridge direction it barely does:
a push of 100x the natural variation changed the output by 0.05%. A layer-by-layer sensitivity
sweep showed why. The U-Net's skip connections let the decoder route around the bottleneck, and
the regression direction sits in a subspace the decoder ignores. The difference of class means
("mass-mean": fast minus slow frames), pushed with the *same norm*, moves the dreamed speed from
about 3 m/s to about 25 m/s with the controls held neutral. This mirrors Marks & Tegmark (2023):
discriminative probe directions are decodable but not causally implicated, while mass-mean
directions are both. The browser's "edit the dream's mind" sliders are mass-mean directions for
speed and turning.

## 10. The autopilot (`train/policy.py`)

"Learning by cheating": every one of the 463k dataset frames is relabelled with the action the
privileged expert would take there. The mixed drivers visited plenty of bad states, so the
student learns recoveries for free. Behaviour cloning trains a 0.66M-parameter CNN on 4-frame
pixel stacks, with input noise so that slightly softer dreamed frames do not throw it off. One
DAgger round then rolls the student out, relabels the states it visits and retrains. Off-track
time on held-out circuits fell from 5.3% to 3.9%, at 96% of the teacher's pace.

## 11. Charts

Charts follow a data-viz method rather than taste: the form is picked by the data's job, then
validated categorical colors, thin marks, a legend whenever there are two or more series, direct
labels only where they separate, text in text tokens, hover tooltips that never gate the data (a
table view sits under every web chart), and light and dark README variants. The three palette
slots were checked with a CVD/contrast validator against both GitHub surfaces and the site's own
surface, under the stricter all-pairs test that scatter plots need. In light mode one slot sits
below 3:1 on white, so every README figure carries direct labels and the README carries the
numbers as tables.

## 12. What is next

- **Circuits beyond star shapes.** A curvature-of-arc-length representation, kappa(s), with the
  closure constraint enforced by the sampler, would allow hairpins that double back, at the cost
  of the free closure the polar form gives.
- **Ask for a kind of circuit.** Classifier-free guidance on lap length or "twistiness" would
  let the difficulty setting pick the circuit as well as the rivals.
- **Learn what is fun.** Validity is geometric. Lap-time spread and overtakes from real races are
  a signal a designer could be fine-tuned on.

- **Memory.** The dream forgets what is behind the car. A recurrent or retrieval memory, like the
  larger world models' memory modules, would let a lap close on itself.
- **Train in the dream.** DIAMOND's second half: train the autopilot with RL entirely inside the
  world model, then measure the dream-to-reality gap.
- **Distill to one step.** Consistency distillation would cut browser latency by about 2x.
- **An ablation of context-noise augmentation**, to quantify how much of the long-horizon
  stability it buys.
