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

### The architect: where the training circuits come from

`trackgen/architect.py` lays out circuits the way a track designer sketches them: as a sequence
of features joined by straights. A feature is a hairpin (150 to 190 degrees at 9 to 14 m), a
tight corner, a medium corner, a sweeper, a kink, a chicane, esses or a double apex, each with
its own range of turning angles and radii, and every corner eases in and out of its curvature
like a clothoid, so the road never kinks. The corner angles are drawn first and scaled so the
lap's total turning is exact: one full turn for a plain loop, zero for a figure-eight. Once the
headings are fixed, the lap's end point is linear in the straights' lengths, so those are solved
(least squares with a minimum length) to close the lap exactly. A figure-eight is two lobes that
each close on themselves through one shared crossing, with a home straight for the start.

Every circuit must pass the rules the game enforces (`check`):

- lap length 520 to 980 m (plain loops at most 920 m), and every point within 235 m of the start
  line, so the circuit fits the game's world texture at 1.5x scale;
- no corner tighter than the 9 m minimum radius (with an 8% tolerance);
- clearance between stretches that are far apart along the lap;
- the start line on straight road (48 m before it, 24 m after it);
- plain loops never cross; figure-eights cross exactly once, at 50 degrees or more, at least 80 m
  from the start, with straight road around the crossing (34 m either side on the stretch that
  becomes the bridge, 16 m on the road underneath).

`trackgen-data` builds 70,000 of them in 13.5 minutes on 10 cores, 35% figure-eights, and holds
out 3,500. Each is resampled to 256 points evenly spaced along the road (2.8 m apart on average),
with the start line at point 0 heading +x, and the curvature at each point is kept for the style
signal.

### The representation: steps between points

The network does not dream the points. It dreams the 256 *steps* between consecutive points
(point i to point i + 1), at 2 m per network unit, so each component has unit spread.
`from_steps` turns steps back into a lap: known points stay exactly where they are, and each run
of dreamed steps from one known point to the next is corrected evenly so that it lands on the
known point at its end. With nothing known, the lap starts at the origin and the closing gap is
spread over every step. Why steps, and not points, is in "What did not work" below.

### The model

A 1-D U-Net (32/64/128/192 channels, two residual blocks per level, kernel 5, self-attention at
the bottleneck, 5.09M parameters). Every convolution uses **circular padding**: the lap is
periodic, so there is no edge for the network to see. Eleven input channels: the noisy steps, a
0/1 mask of known steps, the known steps, sin/cos of the position along the lap (so the network
knows where the start straight is), and its own previous estimate of the steps with the positions
they add up to (self-conditioning; zero on the first sampling step). The noise level, a style value and a layout (any,
plain loop, figure-eight) condition every block through adaptive normalization. The style and
the layout each have a learned "don't care", so both are optional. EDM preconditioning, with one
change: **known road is returned exactly**, `D = (c_skip x + c_out F)(1 - mask) + known mask`,
so the network only ever dreams the rest.

Training draws a known stretch for each example: none at all 20% of the time (dream a whole
circuit), the lap so far from the grid 40% of the time (as the game builds it), and one random
contiguous stretch otherwise. Known steps are never noised, and the loss covers only the steps
to be dreamed, weighted up to 10x next to existing road, where the join is decided. Noise levels
are log-normal with mean -1.6 and spread 1.6, broader and lower than EDM's defaults (-1.2,
1.2), so the network also learns the small noise levels where a corner's last fraction of a
meter is set. Half the examples are mirrored, 20% drop the style and 25% drop the layout. AdamW,
a cosine schedule over 14,000 steps at batch 256 (3e-4, 400 warmup steps), EMA 0.999, then 6,000
more with self-conditioning (1.5e-4): about an hour and a half on the M4 Pro's GPU.

The style of a stretch is the mean of `min(1, 15 |curvature|)` over its points, mapped to 0..1
between the 5th and 95th percentile of the training arcs: 0 is a stretch with barely a bend, 1
a stretch of hairpins and chicanes.

### Live generation

The game runs the procedure that `live_generate()` mirrors in Python:

1. **Before the countdown:** the grid and the first stretch, points -24 to 39, a quarter of the
   lap. The 24 points *behind* the line exist so the start grid has road under it.
2. **During lap 1:** whenever the race leader is within 72 points (28% of a lap) of the end of
   the road, the next 32 points (about 130 m at the game's scale) are dreamed, conditioned on
   everything known, the layout and the style the race asks for (the track type's program, or
   the player's driving).
3. **The closing arc** is conditioned on both ends at once, the road so far and the grid, and its
   steps are corrected to land on the grid.

Each arc is 24 Heun steps (47 network calls, EDM Algorithm 1 without churn, noise levels from
40 down to 0.002 with rho = 7), decoded with `from_steps`, smoothed with a small circular
Gaussian (sigma = 1 point, new arc only) and checked **in context**: the arc plus the designer's
guess for the still-unknown rest must form a valid circuit under the architect's rules.
Checking the arc with the guess for the rest catches an arc that would make closing the lap
impossible while it can still be dreamed again. A failing arc is resampled up to 3 times; after
that a sigma = 2 smoothing of the last sample is kept, so the race always goes on. An arc that
passes but has a corner tighter than 20 m (in game meters: the architect allows 12.4 m, a hairpin
a kart takes at about 16 m/s, and players found the dreamed laps too tight) is dreamed again too,
on the same retries; if every try has one, the try with the widest corner is kept (an arc asked to
be wild, a Technical track's, may bend to 16 m). Smoothing the tight corners wider was tried first
and made them worse: a Gaussian pulls a round bend's points in toward its middle and closer
together (4.1 m apart became 2.5 m), so the same turn happens in less road, and on one test circuit
the tightest bend went from 15.7 m to 11.4 m. Smoothing irons out kinks; only the designer can draw
a wider corner.

**The style signal.** The race keeps exponential averages, over about eight seconds, of the
player's speed as a share of the class's top speed, the share of time spent drifting, off the
road (grass or shoulder), and in a spin or a bump. Before each arc it asks for
`0.5 + 1.25 (speed - 0.72) + 0.6 drift - 1.1 offroad - 0.25 (1 - clean)`, shifted by +0.1 on
Legend and -0.1 on Rookie, clamped to 0.05..0.95. It is a hand-written heuristic, not learned
from players.

**Track types.** The setup screens offer seven (`race/tracktypes.ts`), and every one still
dreams its circuit live; a type sets the layout the designer is asked for, a style program, and
what gets built on the road. Classic and Figure 8 ask for whatever the driving asks for (above);
Speedway asks every arc for calm road (0.04) and Technical for wild road (0.96); Grand Tour
alternates the two arc by arc; Stunt Park alternates calm and middling arcs on a figure-eight;
Roller Coaster leans a little calmer than the driving. A program comes with a band each arc's
*measured* style must land in (calm: at most 0.45; wild: at least 0.6; asked for calm or wild,
the designer's arcs measure 0.32 and 0.87 on average). The game measures the new arc, in the
context of the designer's guess for the rest of the lap, exactly as training did (`arcStyle`: the
mean of min(1, 15 |curvature|) in model meters, mapped by the training percentiles), and agrees
with the Python to within 0.06 on every reference arc. An arc outside its band is dreamed again
with the same retries the drivability check has, and if every try misses, the drivable one
closest to the band is kept, so the race never waits on a style. On the exported designer (10
live laps each), 77% of Speedway arcs, 90% of Technical arcs and 62% of Grand Tour arcs land in
their band at the first try, so with four tries an arc misses it about 0.3%, 0.01% and 2% of the
time. The type also sets the feature
rules: how long a straight earns a jump (85 m by default, 70 m on a Speedway, 50 m in a Stunt
Park), pads along the straights on a Speedway and out of every tight corner (60 m apart) on a
Technical track, and climbs in any world on a Roller Coaster (95-150 m long and 4-6.5 m high,
kept well short of the line by an estimate of the road per segment so far, since the lap's
length is not known until it closes). The counts a type confirms (2 jumps and 3 pads on a
Speedway, 4 pads on a Technical track, 3 jumps in a Stunt Park, 4 climbs on a Roller Coaster)
are made good when the lap locks if the dream left too few: on the straightest free stretches,
never on a bridge and never under or just ahead of a kart. Jumps look away from the item rows
first, then beside them, then on a gentler bend (1/60 m: a 20 m flight drifts 3 m, still on the
road); climbs may carry a row of boxes, which rides up with the road. The countdown shows the
type and what it confirms, and the results list what was built.

The game turns known points into road one Catmull-Rom segment at a time, in driving order, as
soon as the four points a segment needs are known. Committed road is appended to the dense
centerline (a point every 0.6 m, at 1.5x scale for kart-friendly widths) and never moves, with
one exception: when a new arc crosses road that exists, the later stretch is lifted into a
bridge (section 3), even if part of it was built already. When the last segment closes the loop,
the circuit is **locked**: lap counting switches to the closed loop, the far landscape, start
gantry and grandstand are placed, and laps 2 and 3 run on the same road.

### What did not work, and what did

- **The first designer (v1) wrote a circuit as a radius per angle**, r(theta) at 128 angles
  around a center. Closure was free and live generation worked (98.4% of whole circuits and 99%
  of live builds valid), but a radius function can only describe a loop that winds once around
  its center: no figure-eights, no bridges. v2 needed a representation that can cross itself.
- **v2 first dreamed the points**, (x, y) in meters. After 10,500 of 14,000 training steps, 13.5% of
  whole loops and none of the figure-eights passed the rules, and not one of 16 laps built live
  did. Two things were wrong.
- **The noise schedule.** With EDM's default log-normal noise levels, about 1% of training
  examples see noise below 2 m, but that is the scale at which a corner's last fraction of a
  meter, and so the 9 m minimum radius, is decided. Training on from the 10.5k checkpoint with a
  broader schedule (mean -2.4, spread 1.8) took whole-lap validity to 74% for loops and 46% for
  figure-eights within 3,500 steps. Live builds still failed, every time.
- **The joins.** Inpainting real laps with half the lap known failed 48 times out of 48, with a
  near-zero radius exactly where dreamed road met known road. Measured directly: the first
  dreamed point after the known road was 2.6 m off at a noise level of 30 m, and 5 to 7 m off at
  100 to 300 m. With points 2.8 m apart, joins turned by up to 120 degrees at one point. The
  error is made while the noise is high, and later, low-noise steps treat a smooth offset as road
  and keep it.
- **What did not fix the joins.** Re-imposing the known road at every sampling step (1 live loop
  in 5 passed). Keeping known road exact during training for 700 steps (the step across the
  join fell from 5.3 m to 3.3 m; inpainting still failed 58 of 64). Weighting the loss 10x next to
  the join for 700 steps (the first point's error at 30 m of noise went from 2.55 to 2.46 m).
  Pulling the first six dreamed points toward a smooth continuation of the road during sampling
  (3 live loops in 5: the kink moved to the end of the pulled stretch).
- **What did: steps.** Absolute coordinates span hundreds of meters and a join needs them right to
  a fraction of a percent; a step is a few meters long, so continuing the road only asks the
  network to keep a step close to its neighbor, and the position at a join is exact by
  construction. Combined with the exact known road, the join-weighted loss and a broad noise
  schedule, trained from scratch for 14,000 steps, it built 100% of 40 loops and 85% of 40
  figure-eights live (in-training evaluation).
- **Then the global shape: self-conditioning.** With steps, where the road *is* has to be added
  up from hundreds of steps, and the figure-eights' remaining failures were global: laps reaching
  too far from the start, crossings on a bend, the wrong number of crossings. The network now also
  sees its own previous estimate of the lap, as steps and as the positions they add up to
  (self-conditioning, fed back at every sampling step and, half of the time, in training). It was
  grown from the 14k model (the new input channels start at zero, so it begins exactly where that
  model left off) and trained 6,000 steps more. One-pass figure-eights went from 37% to 47%
  valid and the style steering widened (0.34/0.81 to 0.32/0.87 for calm/wild); live builds stayed
  where they were. That is the model that ships.

### In the browser

The designer is small, so it runs on ONNX Runtime Web's WASM backend, single-threaded, in a
**Web Worker**: the worker holds the session and runs the whole Heun loop for each request,
posting the running whole-lap guess a few times along the way (the minimap draws it) and the
finished steps at the end. The main thread turns steps into points (`fromSteps`, a TypeScript
mirror of `from_steps`) and does the checks. The exported model says which representation it
expects, and the game refuses a model that predates steps rather than drawing garbage. Weights
are stored as fp16 and cast to fp32 in the graph.

Two safety nets cover slow devices. Race speed is capped by the distance left to the frontier,
so no kart can drive past road that does not exist yet. And the dream mist at the frontier hides
the unbuilt edge: the ground there shimmers into fog, and the road appears out of it.

## 3. The game (`web/src/game/`)

**Loop.** A fixed 60 Hz update with an accumulator, rendered once per animation frame into a
`Uint32Array` framebuffer that is blitted with `putImageData` and scaled up with
nearest-neighbor CSS, so every pixel stays square. The framebuffer takes the window's shape: a
whole-number scale is picked so the buffer is as close to 225 rows as it can be (216 on a 1080p
screen, at 5x), and the buffer is made exactly big enough to cover the window at that scale,
cropping at most scale-1 screen pixels. A phone held upright fits its width instead (320 pixels
across) with bands above and below. The horizon and focal length scale with the buffer's height,
so a wider window simply sees more to the sides; the HUD and the menus are laid out against the
edges and wrap long lines.

**Mode-7 ground.** Each scanline below the horizon is a line across the ground plane at distance
`z = h f / (y - horizon)` (camera 2.9 m up, focal length 250 px at 216 rows). The world is one 2560x2560
texture at 0.3 m per texel (768 m across, which is why the architect keeps every lap within 235 m
of its start line), painted when road is committed (grass noise, asphalt, kerbs on corners
tighter than 40 m, edge lines, the start checkers and grid slots, and the shadow a bridge casts on
the road below it) and mip-mapped, so each row samples the level that matches its footprint.
Distance fog blends into each world's horizon color, and the frontier mist is a per-pixel term
that pulses near the end of the dreamed road. The ground is flat, but it is not painted flat: a
height field (two scales of noise, up to 8 m from low to high) is lit from the north-west on a
grid every 1.2 m and multiplied into the terrain's colours, so meadows, desert and sea floor read
as rolling land, at about 50 ms per race (the sand's ripples cost more than the relief does). Oil slicks are painted into the ground the same way,
per pixel as each row is drawn: a dark puddle with a wobbly edge, a slowly turning rainbow film
and the sky shining on its far side, so it lies flat in perspective under the karts that drive
over it. Where the road is not the ground (a deck, a climb, a jump ramp, the harbor tunnel's tube)
the ground under the oil is hidden, so the same puddle is laid on the road as faces
(`render/decals.ts`): rim, body, the film's ring and the shine, each point put on the road's
surface where it is (up the climb's slope, round the tube's wall), all one decal at one depth:
on raised road just short of its near edge, so it goes down after every piece of road it lies on,
and in the tube (whose panels are the backdrop to everything) at its far edge, as a pad is. A slick keeps
the road point it was dropped from, so on a deck it is laid on the deck and not on the road
beneath. A sprite used to stand in for it there, and a slick on a bridge stood up like a wall.

**Polygons in a Mode-7 world.** A flat ground texture cannot show a bridge, so bridges, climbs,
tunnels, jump ramps, boost pads and the landforms around the circuit are drawn as flat-shaded
convex polygons by a small software rasterizer
(`render/poly.ts`): transform to camera space, clip against the near plane, cull faces that look
away, fog by distance, fill scanline by scanline. Polygons and sprites share one painter's sort,
with a small depth bias per kind so a kart on a deck draws over the deck and a kart underneath
draws under it. Road surfaces that karts stand on (decks, climbs, ramps, pads) sort by their far
edge rather than their middle: sorted by the middle, the piece of road under a kart was often
drawn after it, and its far half covered the kart's wheels on a flat deck and half the kart on a
steep climb (a Roller Coaster screenshot showed it). A boost pad lies on the road wherever it is:
on a climb, each part of it is drawn straight after the piece of road it lies on (the climb's road
records the nearest sort key of its strips, and the pad goes just nearer than that, over the road's
lines and before any kart on it, which sorts half a meter nearer still); on the ground, the whole
pad is one decal at its far end's depth. Drawn as one flat plate at the height of its start, as
it was, a pad on a slope sank under the climb's road (out of sight, or cut in pieces by it); a
third to a half of all pads lay on a climb once climbs came to every world. The camera rides up
onto bridges with the kart it follows and rises partway on a jump, for a sense of air, but never
more than 1.8 m short of it (the top of a jump at home): on the moon a flight goes 9.5 m up, and
rising only partway the camera lost the kart off the top of the screen.

**Bridges.** When the dreamed road crosses itself (a figure-eight), the later stretch becomes a
bridge: it is lifted 6 m over the road below, on 44 m smoothstep ramps either side of a 34 m
level deck, with kerbed edges, a dashed center line, girder sides, guard rails with posts, and
pillars placed clear of the road underneath. Crossings are found with a spatial hash as each arc
is committed; road that was already built is lifted after the fact, its texture repainted, its
scenery moved and the boxes and coins on it lifted with it. Karts have a height: the ground under a kart is the deck, a ramp or the
plain road, the guard rails keep it on the deck, and two karts only collide if they are at the
same level, so traffic passes over and under freely. The height under a kart is read between the
two road points either side of it (and a jump ramp's wedge by the kart's exact place along it):
read at the nearest point alone, the road rose in steps of a point, 0.6 m apart, one or two a frame
(0.11, then 0.22, then 0.11 m), and a kart shuddered up every ramp and bridge. A kart on raised road
is drawn over the road it stands on, and only what is on the ground under a bridge's deck is drawn
before the deck when the camera is up on it (that rule once applied to anything low whenever the
camera was high, and a kart coming down a ramp under a camera still up on the deck vanished into
it).

**Sprites.** Karts are tiny voxel models (body, wheels, driver, helmet in each livery's colors)
rendered from 16 directions at load time. The renderer picks the view from the angle between the
camera and the kart and leans the sprite with steering. Scenery (trees, rocks, cacti, crystals,
palms, lamps, chevron boards, the start gantry, grandstands) is painted with simple primitives.
The items are drawn the way 16-bit games drew pre-rendered 3D: shaded pixel by pixel under one
light from the upper left, in a few steps of brightness so they stay pixel art. Balls (bombs, dream
orbs) take a normal from the sphere, a stepped diffuse term, a highlight and light reflected up
onto their lower edge; turbo cells, oil barrels and the rocket are bodies of revolution shaded
across their width; the prism is a bevelled star lit on one side of each point's ridge; the shock
is a bolt with its edge showing; the boomerang is rounded across each arm and spins in eight
frames; and the item box is a crystal cube, ray-cast into ten frames of a quarter turn (which is
all a cube needs), with a question mark on every side. The HUD's item slot uses bigger versions
drawn pixel for pixel. Billboards are depth-sorted, scaled with distance and fogged, with drop
shadows and drift sparks. Nothing is a bitmap file.

**Scenery placement.** A spatial hash of the committed road decides what may stand where: trees
and rocks scatter near new road as it is committed (never on it), chevron boards go on the
outside of tight corners, and the distant landscape is placed once the circuit locks.

**Karts and rivals.** Arcade handling: acceleration toward a class top speed (Rookie 24,
Intermediate 26, Pro 28, Legend 32 m/s), slower surfaces off the asphalt (kerb, shoulder, grass), yaw rate limited by
grip over speed, and drifting: hold drift while steering to slide with a stronger turn, charge blue (0.7 s)
and orange (1.6 s) sparks, and release for a mini-turbo. Rivals follow a racing line that cuts
the inside of corners with pure pursuit, brake for a friction-limited speed profile with
braking-distance lookahead, make room for karts ahead of them, drift tight corners (one decision
per corner, held through it, released on exit), and rubber-band: far behind the player they find
6%, far ahead they lift 7%. A headless test drives a rival around a twisty circuit and requires
three clean laps, under 2% of the time on grass, and at least three drifts.

**Jumps, tricks and boost pads.** As road is committed, the game places features on it: jump
ramps on straights longer than 95 m (at least 260 m apart, and never near a bridge, an item row
or the start), and boost pads at corner exits (170 m apart). A ramp is an 11 m striped wedge, 1.7
m high at the lip; a fast kart leaves it on a ballistic arc (gravity 26 m/s^2, arcade-short), with
a third of its steering in the air. The straight a ramp needs is long enough for the flight: 45 m
from the foot to past the landing at home, and as much longer as gravity is weaker on the moon
(124 m). A hop (the drift button) from 0.24 s before the lip to 0.18 s
after it is a trick, and within 0.085 s of the lip a perfect one: the kart spins in the air and
lands into a boost (0.8 s, or 1.35 s for a perfect trick). Pads give a 1 s boost; every boost
widens the field of view and draws speed lines. Rivals try tricks too, more often in the faster
classes.

The race measures a ramp, a pad and a tunnel by arc length (a ramp's height and a pad's boost go
by how far along the road a kart is), and they are drawn by arc length too (`Track.stepAlong`),
from a foot that lies on a road point (`Track.indexBack`). They used to be drawn by counting road
points off as 0.6 m each, but a lap's points are a little closer than that (0.53 to 0.59 m, by
circuit: each stretch between the dreamed points is split into a whole number of pieces no
longer than 0.6 m), so a jump's wedge was drawn up to 7.7 m from where karts drove up it, a pad up
to 0.7 m short of the stretch that boosts, and a tunnel's walls began up to 6 m before the mouth
drawn.

**The start.** The countdown reads the throttle: press it in the half second before GO for a
rocket start (a 1.2 s boost); hold it for more than 1.7 s and the wheels spin for 0.75 s
instead. Rivals get their own good starts at a rate set by their class. (Until the hero video
was filmed, the game passed no controls to the race during the countdown at all, so a rocket
start was impossible; filming one found it, and a test now drives the start procedure.)

**Soundtrack.** Each world, and the title screen, has its own chiptune, sequenced in code
(`core/music.ts`): four channels (pulse lead, pulse arpeggio, triangle bass, noise drums) over a
chord progression, synthesized with WebAudio. The building site's is a hammering riff on the flat
seventh with a hat on every sixteenth; the moon's is slow and weightless, long notes on the raised
fourth of the lydian mode over a glittering arpeggio and hardly any drums. A test checks that
every world has a song of its own and that every bar of every song is whole. The tempo steps up
on the final lap. The music
leads the mix: the engine note (a sawtooth and a square an octave apart, pitched by speed) sits
under it as a low-passed hum at under a fifth of its first loudness, or not at all (ENGINE on the
main menu); its buzzy upper harmonics were what made it grate.

**The garage.** A kart is a body, wheels, a spoiler and an exhaust (`race/parts.ts`), plus paint
and an accent colour, which are only looks. There are 13 bodies, each taking its cues from a
kind of real car (an Italian mid-engine V8, a V12 wedge, a British carbon-tub GT, a rear-engine
flat-six, a W16 hypercar, a Swedish megacar, a JDM twin-turbo, American muscle, a kei car, a
rally hatch, a Le Mans prototype, an electric hypercar, and the classic go-kart), 13 wheels, 10
spoilers and 11 exhausts named after real tuner parts. Every part adds points to six stats, the
six a classic kart racer shows (speed, acceleration, weight, handling, traction, mini-turbo),
around a neutral 10 out of 20, and the stats become multipliers on the race class's numbers:
top speed within 8%, acceleration within 25%, cornering grip within 12%, the speed kept on the
shoulder and the grass, a mini-turbo that charges sooner and fires up to 35% longer, and weight,
which splits each bump's push and impulse by mass. The classic kart is exactly neutral, so the
race physics (and its tests) are unchanged for it. Rivals draw 24 random builds, rank them by a
racing score (speed and mini-turbo count most) and take one from the bottom on Rookie, the lower
middle on Intermediate, the upper middle on Pro and the top on Legend. Each kart is assembled as a voxel model from its parts (a
shell sampled from a width and roof-height profile along the car, a carved cockpit, lights,
intakes, stripes; wheels with rims painted on their outer faces; the spoiler and pipes mounted
where the body says) and baked into its 16 views once per build; the garage's turntable splats
the same voxels live at any angle, so the kart can turn slowly on its pedestal. The garage screen
is laid out from the screen's size: the showroom (the title, the kart on its pedestal as big as
the height allows, the stats on a card under it) beside the parts panel (each part's name over
what is fitted, with room between parts), and a bar along the bottom with a line about the part
picked, as tall as the longest of those lines needs, so nothing moves from one part to the next;
on a phone held upright the three are stacked.

**The reef, Tokyo and the volcano.** Three worlds are more than palettes. Under the sea (Coral Reef)
the ground is lit by caustics, two layers of a tiling 64x64 sine pattern drifting against each
other and multiplied, so bright filaments ripple over the sand at the cost of two table lookups
per ground pixel; shafts of light slant down over the view, bubbles rise past the camera, and
schools of fish circle points around the lap, each fish turned to face the way it swims across the
screen. Every driver wears a clear bubble helmet: when a kart is baked, the centre of its
driver's helmet is projected into each of the 16 views, and a translucent dome with a bright rim
and a glint is drawn there over the sprite. Tokyo (Tokyo Nights) is a world for drifting: the
designer is asked for a more winding road there (the style signal leans 0.12 wilder), between lit
towers, vending machines, paper lanterns, neon signs, utility poles and cherry trees, the paving
wet and holding the neon in its puddles. The road bores under buildings on long, gently curving
straights: walls the karts are kept between, tiled, with sodium lamps inside, and the building's
lit windows and a neon sign over each mouth; the view darkens while the camera is in one. The
skyline is a night city with a lattice tower, and Fuji far off under the moon; a canal runs past
the bends to fall into.

**Climbs in every world.** Hills are a second kind of raised road next to bridges, and every world
has them, built its own way (`render/structures.ts`): over rolling meadows behind wooden fences
(Dream Valley), onto mesa tops walled in level bands of sandstone (level with the ground, not
with the road, as rock is laid down) and over dunes (Sunset Mesa), over ridges of rock with fans
and tubes of coral standing on them (Coral Reef), up onto an elevated expressway (concrete
parapets, sodium lamps reaching over the road, green signs, piers) and up the ramp of a parking
garage (columns, strip lights under the floor above, a striped kerb) in Tokyo, along causeways
of basalt columns raised over the lava itself (Volcano Core), up
onto concrete foundations, along scaffolding of pipes and planks and high along a tower crane's
girder, a steel deck on a yellow truss with a column to the ground every so often and the crane
standing beside it (Construction Zone), and over crater rims (Moon Base); in the Harbor Tunnel the
whole tube rises and falls over humps. A climb is a smooth
sin^2 hump or a plateau (smoothstep ramps either side of a level top, long enough that a kart at
full speed stays on the road over the top under normal gravity, and never steeper than about 22%).
A world's kinds of climb take turns, so a lap has one of each, each waiting a while for room before
the next has its go: drawn at random, a long girder lost its place to the short kinds on lap after
lap, and the building site went without one. Climbs are decided once the road 100 m past their
foot has been dreamed, after the jumps, tunnels and pads on that road are placed: a climb never
covers a jump or where its karts land, and a straight that may yet earn a jump is left for it.
Set the other way round, the climbs took the straights first and the worlds lost up to four jumps
in five; now every world keeps all its jumps and climbs two to four times a lap (six to eight on
the moon's bigger laps). The road a climb
lifts was painted flat, so it is painted again, the boxes and coins on it ride up with it, and the
scenery beside it is cleared. A Roller Coaster track sets climbs in any world, in that world's
style. If the dream later crosses itself, the climbs near the new bridge and the road under it are
flattened (the bridge needs the headroom), the ground is repainted, the boxes, coins and oil on
them come back down with the road, and the cuttings and whatever stands in the way there are
cleared (left as they were, boxes hung in the air over the flattened road, as much as 5.4 m up,
and oil floated out of reach of the karts). Karts stay on a climb as on
a bridge: guard rails keep a kart on raised road, and the ground under a kart is the road's height
where it is.

**The land around the circuit.** When the lap locks, up to 28 landforms are set out (more on the
moon's bigger ground, 66 there) (`world/landforms.ts`): knolls in the meadows, buttes and dunes in
the desert, reef rocks crowned with coral, blocks of towers with floors of lit windows in Tokyo,
cinder cones with lava in their craters, heaps of spoil on the building site and old crater rims
on the moon. Each is a solid turned about its middle (rings of
points from its foot up, a little ragged, joined into faces, `render/landforms.ts`), lit by the same
north-west sun as the ground's relief, culled when it is behind the camera or past the far plane.
Their feet stay at least 25.5 m from the road's centerline everywhere: past the fence that keeps
karts within 17 m of the road's edge, so nothing ever drives into one, and nothing grows inside
them. (Brought 4 m inside the fence, to stand closer to the road, a foot could reach where a kart
in the grass drives; the test now checks the clearance against the fence itself.) All the climbs, landforms, bridges and tunnels in view take 0.4 to 0.8 ms a frame on average
to build and fill, and about 3 ms at worst (measured headlessly, 300 views around a lap in every
world).

**The building site and the moon.** Construction Zone is raced on the buildings: the climbs above,
and tunnels through the ground floors of buildings going up (concrete barriers along the road,
rust-red steel columns, floor slabs overhead with the first as the ceiling, glass going in on some
bays, the next storey's columns sticking up out of the top, and a striped clearance bar at each
end; the view darkens less than under a building in Tokyo, as the frame is open to the light). The ground is
churned dirt with the tread of the machines' tracks, the scenery is tower cranes, buildings' steel
skeletons, mixers, diggers, stacks of pipes and girders, barriers and drums, and the skyline is a
city of towers with half-built frames and tower cranes in front of it. Moon Base has weak gravity
(three tenths of the usual), for the karts, their jumps and the items alike, and the game's crest
rule does the rest: a kart leaves the road where its speed squared times the road's bend over the
top is more than gravity can hold, which on a crater's rim takes 15 to 20 m/s on the moon and
27 m/s or more at home, where a Pro kart tops out at 28 (the road's slope and bend are measured over
2.4 m either side, so the steps between road points do not set karts flying). The ground is regolith pocked with a thousand craters, each a
bowl lit on one side inside a bright rim of thrown-out dust; the drivers wear helmets; the scenery
is landers, dishes, habitats, boulders and a rover; and the sky is black, with stars, grey ridges
and the Earth, its seas, land, ice and clouds lit from one side and its night side faint. A jump
on the moon flies three times as far (a Pro kart 85 m, a boosted Legend 150 m), which on a lap of the
usual size was a ninth of the lap in one leap and often past the end of the straight, so the moon
draws every circuit 1.6 times the size (laps of 1.3 to 2 km). The designer dreams, and every check
runs, at its own size: only the road laid out in the world is scaled, and a map is kept at the usual
size and raced at the scale of whichever world it is raced in. The ground texture grows to hold the
biggest lap the checks allow (3920 texels across instead of 2560, its craters and scenery as thick
on the ground as before) and paints in 0.86 s: the painters now hash each noise cell's corners once
per row instead of at every texel, the same bits 1.5 to 3 times faster in every world, and the
dreaming screen goes up before a race is set out, so START never leaves the menu frozen.

Inside the volcano (Volcano Core) the road is a causeway of rock across a lake of lava
(`world/lava.ts`). The terrain is not painted in colours there: each lava texel holds a phase (from
two scales of noise and a slow drift across the lake) and a crust level (molten, a cooled plate,
lava in a shadow, or a glowing crack in the rock), marked in the alpha byte that real colours keep
at 255. The Mode-7 renderer looks each mark up in a palette that turns over with time, so bands of
heat flow across the whole lake for one table lookup a pixel: the old colour-cycling trick. Mip
levels keep the marks where a block is mostly lava (so far lava flows too) and blend the colours
they stand for at its edge. As road is committed, a bank of rock is laid either side of it, 2.6 m
past the shoulder, only over lava (never over road or rock already there), with a glowing rim where
it meets the lava. A kart on the ground and off the road goes in when the texel under it is lava:
the same texture the player sees decides. It sinks for half a second in a splash of lava and a
puff of smoke (the sprite is clipped at the surface and glows hot), the view goes dark red, and
under cover of it the kart is lifted out at the last road point it was on, centred and facing up
the road, hanging from a rescue drone that lowers it from 3.4 m and lets it go just over the road
two seconds after it went in; a fresh hop as it drops is a trick, as off a ramp. Meanwhile it is out
of the race: no item, kart or bump touches it, and it cannot use its own item. Being set down
behind the line counts as backing over it, so no lap is counted twice. Rivals drive the same line
as anywhere else and almost never go in (in 27 test races across three classes and three circuits,
not once); the player who drives off the rock does. The sky is the crater: ridged walls of basalt
in strata, lit red toward their foot, with lava pouring down them from notches in the rim, and
embers rise through the air; the scenery is basalt columns, obsidian shards, smoking vents, magma
boulders and spires of rock standing in the lava, and nobody sits in a grandstand out there.

**Maps.** Quick Race races a fresh dream, or a map: the last eight circuits the player dreamed
(saved on the device, in decimeters, with their track type and world, named MY DREAM 1, 2, ...) or
eight showcase circuits the designer dreamed (the ones the trailer was filmed on, shipped with the
game). A map is raced as it is, with no dreaming, by its own track type's rules, and the setup
screen draws its layout beside the hint. While a map is picked, the TRACK row shows the map's own
type, dimmed and locked, so the screen never claims a type the race won't use.

**The rescue drone, in every world.** The volcano's rescue works anywhere. When the lap locks, each
other world but the tunnel (where there is nowhere off the road to go) sets out up to seven
hazards of its own kind (`world/hazards.ts`): ponds in Dream Valley, quicksand in Sunset Mesa, a
trench in the reef, a canal in Tokyo (a lip of granite blocks, a dark wall down to black water
holding the city's lights), dug-out pits on the building site and chasms on the moon. Each is an ellipse on the
outside of a bend (the tightest bends first, where karts run wide), wholly 10.3 m or more from every
road point (past the road and its shoulder), clear of the start and of each other, painted into the
ground (and painted again after any repaint of that ground) with nothing left standing in it. A kart
on the ground in one goes in as into the lava: it sinks out of sight in a splash of the hazard's
colours, the screen darkens to the hazard's colour, and the drone sets it back on the road it left.
A kart can also fall off raised road: flying over the open edge of a bridge, a girder,
scaffolding, a foundation, a mesa's wall or a basalt causeway, there is nothing under it but the ground far below, and once it has dropped 1.5 m under the deck the drone
comes for it and lifts it back onto the deck. Over an embankment's slope (a meadow's, a dune's, a
crater's rim) a kart just lands on the road again, as before. Rivals keep to their racing lines and
seldom go in.

**The Harbor Tunnel.** The whole race runs in a road tunnel, a tube (`world/tube.ts`): a flat
floor as wide as any road, walls that curve up in half circles 4.5 m across to a flat roof as wide
as the floor, the whole way round. A kart's offset (m left of the centerline, as everywhere) is
how far round the tube it has gone from the middle of the floor: past the floor's edge it is up a
wall, past the wall on the roof, and on round it comes down the other wall. So the race goes on
in its usual flat terms (the tube unrolled is a road 54 m wide whose two edges are one line, the
middle of the roof), and items, rivals, pads and laps work as anywhere else; only drawing bends
it round. Up a wall a kart is held on by its speed, the more the higher it is (12 m/s where the
wall stands upright), and anywhere on the upper half it needs 22.5 m/s; slower, it slides back
down, fast from the roof. WALL and LOOP show beside the speed, gold when a kart is fast enough
for each, with ticks on the speed bar. Up a wall or on the roof a kart turns no more than 45
degrees off the way along the tunnel, the wall carries it round the tunnel's bends, and when the
steering is let go it straightens out along the tunnel: so a loop is a spiral on down the
tunnel, with the way on always in view, and a kart left alone rides the wall. Free to turn, a
kart drove straight round and round the tube, seen side on, with the whole tunnel spinning past
it: driven by a recording driver steering at random, the view turned 8 to 12 degrees a frame in
two frames of five (now in one of fourteen, sliding off the roof or looping). Pads go up the
walls and on the roof, where only a kart fast enough to loop can reach them, and up to four cars
drive the floor in three lanes, 60 to 95 m apart and slower than any racer, to weave through or
ride a wall past. Its circuits are drawn 1.6 times the size and dreamed calmer, so the bends are
wide enough to drive round the inside of.

In the tube there is no Mode-7 ground and no sky (`render/tube.ts`). It is drawn as road tunnels
are built: an asphalt road in three lanes with white edge lines, dashed lane lines and amber
cat's eyes, a concrete walkway along each side, the walls faced with pale tiles to head height
under a dark cable tray and bare concrete above, and a concrete roof with a row of lights down
its middle, every 4.5 m, each throwing a pool of light on the road below; lane signals hang from
the roof every 160 m, and a green emergency-phone niche is set into the right-hand wall every 96
m. (It began as a tube of neon light, strips and pulsing rings, and was redrawn as a real
tunnel.) The 260 m of tube ahead of the camera are drawn (past its far plane, where the fog is
whole: drawn short of it, the far end of a straight showed as a dark disc), as rings of 22 panels
(the road in four, a walkway each side, each wall in six facets, the roof in four), in pieces
that lengthen with distance (3, 6, then 12 road points). Each piece starts at a whole multiple of
its length and the lining is shaded in sections 12 road points long, so the pieces and their
shades stay put while the camera moves through them; the dashes, lights and signs are set where
they fall along the road (counted afresh each lap, so one by the line is the same from either
side). The panels are the backdrop to everything in the tube: sorted 7 m deeper than they are, a
panel always goes down before a kart, a pad or a line lying on it, while anything a bend's wall
really hides is much further behind it than that. Where a figure-eight's tube crosses itself,
the pass the camera is not on is left out (from inside it is never seen, and drawn it would show
through the walls), and so is everything on it. Everything in the tube is placed where it lies
between road points (`tubePlace`): snapped to the nearest point, half a meter apart, every kart
shook as it moved, by about 10 px a frame on the screen.

The chase camera is fixed to the kart's own frame round the tube: 6.2 m behind it along the
tube, 2.9 m off the surface along the way the kart's surface faces (rising with the kart up a
jump's ramp and partway into the air), looking along the tube and turned at most 9 degrees
toward where the kart heads. So the kart stays upright in the middle of the foot of the
screen, and the tube turns about it as it climbs a wall, loops over the roof or dips over a
crest. The first camera was put where the race's flat terms put it, behind the kart as they
measure it, and up the way the surface faced there; driving round the tube it lagged far round
the curve, stared at walls, moved up to 9 m in a frame and turned up to 15 degrees a frame, and
the kart flew off the screen (thousands of pixels off, or behind the camera) or showed tipped
every which way. It looks down the tube the way the kart is going, and when the kart has turned
round past 115 degrees from that, it swings round behind the kart the way the kart turned, in
0.45 s, closer in and lower as it goes round, so the kart keeps its place on the screen (it cut
round in a frame at first, the whole tunnel turning about at once; swung round at its usual
distance, 6.2 m to the side, it would have been out through the wall). The rear-view mirror
rides just ahead of the kart looking back, and any other camera (the film's) goes where its flat
terms say. Each sprite and its shadow are turned on the
screen by how the camera sees its surface's up. A surface's normal tips with the road's slope
(eased from one road point to the next): taken as level, the floor of a climb ahead faced away
from a camera below it and was culled.

Round the tube the race's flat terms stretch the road's length away from its middle on a bend
(round the outside) or squeeze it (round the inside), while the tube itself is never more than 11
m from its middle; so a kart up a wall or on the roof moves along the road at the tube's own
measure (`tubeStretch`), or through a bend it went as much as two and a half times as fast as its
speed said, or crawled. Round the inside of a bend tight enough to squeeze the flat terms to under
a third, near where they fold over themselves, no kart can hold on up a wall or on the roof at
any speed, and it slides back down: in the fold, a kart on the roof jumped about the tube.

So in the tube a kart's place is kept in the tube's own terms: its road point, how far on it is
to the next, and how far round the tube it is. It moves in those terms, along the road at the
tube's own measure and round it, and its place in the flat terms, which the rest of the race
goes by, follows from them; only when something else moves it in flat terms (a bump, a shove)
is that carried back into its place round the tube. Kept in flat terms and found again from
them each frame, a kart going round over the middle of the roof was put 5 to 20 m further along
the tunnel in a frame (40 m round the inside of a tight bend, where the flat terms fold over and
one flat place stands for meters of tube), and the camera fixed to it jumped with it. Karts are
drawn, and the camera follows them, by those places, and which side of a kart the camera sees is
worked out round the tube too (from where the camera stood in flat terms, a kart crossing the
middle of the roof was seen from the wrong side for a frame). Sprites going by within 4 m of the
camera, behind the kart it follows, are drawn see-through, and within 2.2 m not at all.

**Something in the way.** Every world has its own (`race/obstacles.ts`), set out along the road as
it is committed, each kind its own distance apart (a cow every 260 m, a geyser every 230, a
wrecking ball every 360), and on flat road if it stands on the ground. Cows graze beside the road
and walk across it as karts come, and three in ten stop dead half way. Tumbleweeds blow across
the mesa, some from the foot of a cutting's wall. Jellyfish drift and bob over the reef road and
sting only when they are low. Police cars wait in alleys between Tokyo's buildings, pull out
after the player with a siren and a flashing warning, ram them from behind, back off for a
moment and come again, and give up after two hits, 22 s or once the player is 260 m clear.
Geysers in the volcano's road glow and bubble for a second before they blow a column of lava 7.5
m up. A wrecking ball swings across the building site's road on a 12.3 m cable from a crane's jib,
once every 3.8 s, low enough to hit only near the bottom of its swing. On the moon, meteors are
called in 70 to 130 m ahead of the player and fall for 1.8 s at a slant onto a red ring that
pulses faster as they near. A hit spins a kart out (the wrecking ball also knocks it aside and
slows it), a tumbleweed only slows it, and a geyser or a meteor throws it into the air; each kind
has its own sprites and sound. Rivals are told where the danger is and steer round it.

**Cuttings.** Once a stretch of flat road's climbs are decided, the land may rise in walls beside it
(`world/banks.ts`), so the road runs down through the land rather than across it: on one side or
both (a Tokyo street has both seven times in ten, a mesa canyon six), 40 to 150 m long and 2.5 to
22 m tall by world, 8.9 m out from the centerline (past the road and its shoulder), leaning back
as they rise (a grassy bank lies well back, a street's shop fronts stand upright). Grassy banks
with a dry-stone wall at their foot in the valley, a canyon of red rock in beds on the mesa, rock
walls topped with coral on the reef, streets of lit shop fronts with their signs and floors of
windows above in Tokyo, basalt cliffs with glowing seams in the volcano, site hoardings with
containers stacked behind on the building site, banks of regolith on the moon. They keep clear of
bridges, tunnels, jumps, the line and whatever comes in from the side (cows, the police's alleys,
a crane's mast); a wall holds a kart at the edge of the shoulder, and hazards and scenery keep
off its land.

**The Grand Prix.** A cup (`race/cup.ts`) runs one race in every world, back to back. The rivals
keep the same karts throughout (their builds come from the cup's seed, not each race's), and each
race pays points by finishing place, 15, 12, 10, 8, 6, 4, 2 and 1; the standings rank by points,
then by total race time. After each race the standings animate (`ui/ceremony.ts`): each racer's
points pop in, the totals count up, and the rows slide from the old order to the new. After the
last race comes the award ceremony: a scripted camera finds third, second and first on their
pedestals (each racer's own kart model, drawn live by the garage's turntable, with their name
floating over it), then pulls back while rockets climb and burst into sparks, confetti falls and
spotlights sweep; a fanfare, a cheering crowd (band-passed noise swelling up) and the fireworks are
all synthesized. The size of the show follows the player's result: a win gets the most fireworks
and gold confetti.

**Controls.** Keyboard, gamepad and touch feed one set of driving controls. On touch the left
half of the screen is a floating joystick: it appears under the thumb, its base follows a thumb
that slides past the rim, it has a dead zone and a gentle curve for small corrections, pushed all
the way to the side it drifts (with hysteresis, so a drift does not flicker off mid-corner), and
pulled back, straight or on a diagonal, it brakes and then reverses, steering as it backs up. The
gas is automatic once the race is on, so steering and drifting take one thumb; before GO the
engine revs only while the thumb is on the stick, which keeps the rocket start a matter of
timing. DRIFT (hops and tricks too), ITEM and BACK (the item thrown behind: R on a keyboard, X on
a pad) sit under the right thumb. On every device the brake
wins over the gas, and held at a standstill it backs the kart up at up to 7 m/s; the grass slows
a reversing kart's top speed but no longer drags it to a halt (it once cancelled all but 1 m/s^2
of the reverse thrust, and reversing is how a kart gets out of the grass). HOW TO PLAY on the main menu is
four short pages (keys, pad, touch and tips), each control drawn as a key cap or the stick beside a
few words; it was one page of small text, too crowded to read.

**Items.** A row of four boxes spans the road every 210 m of committed road (the first one
shortly after the start, none in the last 70 m before the line), with lines of coins between, so
boxes appear as the road is dreamed. Driving through one gives an item; the player's slot spins for
1.2 s first. There are 22 (`race/items.ts`), as many as Mario Kart 8 Deluxe has, each doing the job
of one of its items, with original names and art. Turbo, Triple Turbo and Gold Turbo (a boost on
every press for 7.5 s); Oil Slick and Triple Oil, dropped behind (a slick is 4.6 m across, a third of the road); Puck and Triple Puck, which slide
along the aimed arrow, bounce off the road's edges up to six times and spin the first kart they
meet, their thrower too; Dream Orb and Triple Orb, which travel up the centerline at the shooter's
speed plus 12 m/s, ease toward the target's lane and home in directly within 22 m; Comet, which flies
up the road at 75 m/s over everyone to whoever leads by then, hangs over them and comes down, its
blast spinning whoever is within 6.5 m; Bomb, lobbed at the racer one place ahead, which chases them
down and goes off, its blast spinning everyone within 5.5 m (the karts it catches as well as its
target; thrown by the leader it lands where it was aimed and waits); Rocket, which drives the kart
itself up the road's own points, past two karts at most and never into the lead; Static, which fills
the screens of everyone ahead with drifting snow for 4.5 s (rivals steer worse under it); Shock,
which spins, shrinks, slows and disarms everyone else, and a full-size kart that drives over a
shrunk one flattens it; Prism, invincible and 15% faster for 7 s; Flares, a fireball on every
press for 10 s, bouncing up the road; Boomerang, out along the arrow and back, three times;
Grabber, a claw in front of the kart for 8 s that snaps at karts and items it can reach, a little
boost with each bite; Horn, a ring of sound that spins karts within 7 m and knocks every item within
9 m out of the air, and a comet within 14 m; Jackpot, eight items circling the kart, used one by one;
Coin, two coins (every coin, up to ten, adds 0.6% to top speed, and a spin costs three); and
Phantom, see-through and untouchable for 5 s, which steals an item from someone ahead.

Thrown items are aimed with two presses, ahead (E) or behind (R): an arrow on the road in front of
the kart sweeps left and right (up to 43 degrees either way) and a second sweeps behind it, mirrored
(on the same side of the kart); the first press locks one (it turns blue, and a bomb or a puck rides
out behind the kart as a shield meanwhile), and the second throws along it; rivals aim at the
nearest kart in the arc and press twice, two frames apart, and throw back at a kart on their tail
when there is nobody to hit ahead. The chase camera, 6.2 m behind the kart and 2.9 m up, cannot see
the road behind it (the ground is in view only from about a meter behind the kart, under the kart's
own sprite), so while the player holds something that can go back, a rear-view mirror sits at the
top of the screen: the world drawn a second time into a small framebuffer (the renderers read the
screen's size as they draw, so it is swapped for the mirror's for the call), from 2.5 m ahead of the
kart and 3.4 m up, looking back over it (the kart itself is not drawn), the sky remapped to the
mirror's field of view, then flipped as a mirror is, so what is on the kart's left shows on the
left; the arrow behind is drawn 1.6 times larger there. Thrown back, an item goes back down the road
at its own speed (thrown ahead it carries the kart's): a puck slides and bounces, an orb goes
straight back like one (no homing), a bomb lands behind and waits, a boomerang goes out and home. Items meet as they do in the classic:
two projectiles, or a projectile and a slick, take each other out; a projectile into a waiting bomb
sets it off; an item held out behind a kart blocks one hit from behind, and every puck or orb of a
triple circling a kart blocks one; a prism or a rocket shrugs everything off and a phantom lets it
pass straight through; a blast or a horn clears the items around it. Items act on the press of the
button, never on the hold.

The odds are the classic's own: Mario Kart 8's Grand Prix item tables (version 4.1, as transcribed
on the Super Mario Wiki), one for players and one for computer drivers, each in nine tiers of
distance behind the leader (the classic's units read at 2.5 cm, a kart being about 2 m long in both
games), with this game's item standing in for each of the classic's, and the later Deluxe edition's
phantom given 2.5% in the second to fourth tiers (`race/odds.ts`). The leader mostly gets coins,
oil and pucks; a kart far behind gets triple turbos, prisms, gold turbos and rockets. The rocket
keeps this game's own rule on top: only the kart in last place, in a field of three or more, and
only 60 m or more behind the kart one place ahead (it once carried last place straight into the
lead). One comet may be out at a time, and a shock, a comet or static that has just gone off is out
of the draw for a while; its share goes to the rest. Every kart shows what it carries: the item it will
use next floats over the driver's head, spare shots and a jackpot circle the kart, a held item drags
on the road behind it, and a grabber lunges in front. Rivals save each item for its moment
(turbos on straights, oil and the horn with a kart close behind, orbs and pucks with a kart in
range ahead, the rest when it pays), hold an item out as a shield when someone is on their tail,
and react sooner in the faster classes.

**Bumps, and a bug the item tests found.** Karts change speed only along their heading. The
first collision model exchanged the closing speed along the contact normal straight into each
kart's speed, without projecting it onto the heading. In a side-on pile-up the same pair
collides frame after frame, so speed was pumped into one kart, and a kart shoved into reverse
read as still approaching and ran away backwards: one reached 88 m/s and another -55 m/s.
Projecting the impulse onto each heading makes the exchange physical (a reversing kart is now
slowed, not accelerated), and speeds are clamped and bled off above the class limit. A crowded
8-kart race in the test suite holds every kart under 1.3 times its own top speed (a rocket is
meant to go faster). Weight from the garage splits each bump by mass, and an invincible kart
(prism or rocket) is not moved at all: it shoves the other kart aside and spins it.

**Race.** A state machine: dreaming, countdown, racing, done. Positions sort by race distance;
laps count crossings of the start line by the sign change of the arc length past it, so backing
over the line un-counts a lap. The results screen estimates finishing times for anyone still on
track when the player finishes.

**Testing a game that does not paint.** The browser pane used for verification is hidden, and a
hidden page gets no animation frames. A dev-only hook (`window.__dc`, stripped from production
builds) advances the simulation a fixed number of steps with given keys held (or an AI pilot),
processes queued menu input and renders once, so whole races can be driven, measured and
captured deterministically.

**Hunting glitches frame by frame.** Through the same hook, 40 seconds of racing in every world
(and in the tunnel, a kart turning round the tube every nine seconds) are recorded with the
game's own camera and HUD, every second step saved with where the camera is and which way it
looks, and where the kart lands on the screen. A script then flags a camera that moves or turns
too far in a frame, a kart that jumps about the screen or leaves it, and pixels outside the HUD
that change and change straight back (A, B, A). Besides the tunnel's camera and its shaking karts
(above), it caught, in every world, the camera lagging the kart's height coming down a climb or
landing a jump: the kart sank to the foot of the screen, and for a frame or two after a landing
below it. The camera now leads the kart on a slope by as much as it would lag, and never rides
more than 0.3 m over it. It also caught the jump ramps' stripes strobing under a kart at speed
(once narrowed to 1.2 m; 1.6 m again), the wrecking ball and its cable swinging through the camera
(a black bar across half the screen for a frame; both are left out that close), and the police
and tunnel warnings printed over the kart (they hang in the sky now). What is left is the
shimmer of fine pixel art moving across the screen (a city's lit windows panning past, a banner's
letters as it nears), which is the motion itself.

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
  copy-the-last-frame baseline. `docs/assets/reality_vs_dream.gif` shows an open-loop rollout
  next to the truth: the dream stays plausible while it drifts away from the real road.
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
and a probe on the raw context pixels. Speed and the steering angle are excluded from the
headline because both are drawn in the HUD (a speed bar and a steering marker), so raw pixels
decode them too. Yaw rate (motion between frames), slip, and curvature
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
