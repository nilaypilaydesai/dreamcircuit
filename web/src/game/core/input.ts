// Game input: keyboard, gamepad and touch, read as continuous driving controls plus
// edge-triggered menu events. Listens only while the game screen is active, so the rest of the
// site (the DATA pages) keeps normal keyboard scrolling.
//
// Touch races with one thumb on a joystick fixed low on the left (steer; push it all the way over
// to drift, pull it back to brake) while the gas is automatic, and the other on DRIFT (which also
// hops, for tricks), ITEM and BACK (the item thrown behind; R on a keyboard, X on a pad).

// "cancel" is the pad's B: back in menus, but not a pause in a race (there B brakes)
export type MenuEvent = "up" | "down" | "left" | "right" | "confirm" | "back" | "cancel" | "pause";

export interface DriveInput { steer: number; throttle: number; brake: number; drift: boolean; hop: boolean; item: boolean; back: boolean }

const DRIVE: Record<string, string> = {
  ArrowUp: "gas", KeyW: "gas", ArrowDown: "brake", KeyS: "brake",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
  ShiftLeft: "drift", ShiftRight: "drift", Space: "drift", KeyX: "gas", KeyZ: "brake",
  KeyE: "item", KeyC: "item", KeyR: "back",
};
const MENU: Record<string, MenuEvent> = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right", Enter: "confirm", Space: "confirm", KeyX: "confirm",
  Escape: "back", Backspace: "back", KeyP: "pause",
};

const DEAD = 0.12; // stick dead zone, in stick radii
const DRIFT_ON = 0.9; // pushed this far over, the stick drifts
const DRIFT_OFF = 0.72; // and keeps drifting until it comes back inside this

/** Joystick deflection (in stick radii, +x right, +y down) to driving controls. Steering has a
 * dead zone and a gentle curve for small corrections; a stick pushed all the way to the side
 * drifts (with hysteresis, so a drift does not flicker off mid-corner); pulled back, straight or
 * on a diagonal, it brakes and then reverses (steering while it backs up). */
export function stickControls(dx: number, dy: number, drifting: boolean):
  { steer: number; brake: number; drift: boolean } {
  const x = Math.max(-1, Math.min(1, dx)), ax = Math.abs(x);
  const mag = ax < DEAD ? 0 : Math.min(1, ((ax - DEAD) / (1 - DEAD)) ** 1.25);
  return {
    steer: mag === 0 ? 0 : -Math.sign(x) * mag, // the game's steer is + = left
    brake: dy > 0.55 && dy > ax * 0.75 ? 1 : 0,
    drift: drifting ? ax > DRIFT_OFF : ax > DRIFT_ON,
  };
}

export class GameInput {
  private held = new Set<string>();
  private events: MenuEvent[] = [];
  private padPrev = new Set<string>();
  active = true;
  onMute: (() => void) | null = null;
  pointer: { x: number; y: number; down: boolean; clicked: boolean } = { x: -1, y: -1, down: false, clicked: false };
  /** Set once the player drives by touch: the gas then works by itself. */
  touchMode = false;
  private stickId: number | null = null;
  private stickVec: [number, number] = [0, 0];
  private stickDrift = false;
  private readonly touchRoot: HTMLElement;
  private readonly stick: HTMLElement | null;
  private readonly knob: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement, touchRoot: HTMLElement) {
    this.touchRoot = touchRoot;
    // a phone or tablet drives by touch from the start (its prompts say TAP, its gas is automatic)
    this.touchMode = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    window.addEventListener("keydown", (e) => {
      if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyM") {
        this.onMute?.();
        return;
      }
      const d = DRIVE[e.code];
      const m = MENU[e.code];
      if (d) this.held.add(d);
      if (m && !e.repeat) this.events.push(m);
      if (d || m) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      const d = DRIVE[e.code];
      if (d) this.held.delete(d);
    });
    window.addEventListener("blur", () => this.held.clear());
    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * canvas.width;
      this.pointer.y = ((e.clientY - r.top) / r.height) * canvas.height;
    };
    canvas.addEventListener("pointermove", toLocal);
    canvas.addEventListener("pointerdown", (e) => {
      toLocal(e);
      this.pointer.down = true;
      if (e.pointerType === "touch") this.touchMode = true;
    });
    canvas.addEventListener("pointerup", (e) => {
      toLocal(e);
      this.pointer.down = false;
      this.pointer.clicked = true;
    });
    touchRoot.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach((b) => {
      const k = b.dataset.k!;
      const on = (e: Event) => { e.preventDefault(); this.touchMode = true; this.held.add(k); b.classList.add("on"); };
      const off = (e: Event) => { e.preventDefault(); this.held.delete(k); b.classList.remove("on"); };
      b.addEventListener("pointerdown", on);
      b.addEventListener("pointerup", off);
      b.addEventListener("pointerleave", off);
      b.addEventListener("pointercancel", off);
    });
    touchRoot.querySelectorAll<HTMLButtonElement>("button[data-ev]").forEach((b) => {
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.events.push(b.dataset.ev as MenuEvent);
      });
    });
    this.stick = touchRoot.querySelector<HTMLElement>("#stick");
    this.knob = this.stick?.querySelector<HTMLElement>(".knob") ?? null;
    const zone = touchRoot.querySelector<HTMLElement>("#stick-zone");
    if (zone) this.wireStick(zone);
    this.restStick();
    window.addEventListener("resize", () => { if (this.stickId === null) this.restStick(); });
  }

  /** The joystick stays where it is, low on the left, and its knob follows the thumb within its
   * rim. (It floated: it appeared under the thumb, and its base followed a thumb that slid past the
   * rim, so on a phone it wandered round the screen.) A thumb that comes down well away from it
   * is left alone, rather than steering hard at once. */
  private wireStick(zone: HTMLElement): void {
    const radius = () => (this.stick ? this.stick.offsetWidth / 2 - 6 : 50);
    const centre = (): [number, number] => {
      const b = this.stick?.getBoundingClientRect();
      return b ? [b.left + b.width / 2, b.top + b.height / 2] : [0, 0];
    };
    const steer = (e: PointerEvent) => {
      const [cx, cy] = centre(), r = radius();
      let dx = (e.clientX - cx) / r, dy = (e.clientY - cy) / r;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.stickVec = [dx, dy];
      this.moveKnob(dx, dy, r);
    };
    zone.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.stickId !== null) return;
      const [cx, cy] = centre();
      if (Math.hypot(e.clientX - cx, e.clientY - cy) > radius() * 2.4) return;
      this.stickId = e.pointerId;
      this.touchMode = true;
      zone.setPointerCapture?.(e.pointerId);
      this.stick?.classList.add("on");
      steer(e);
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.stickId) return;
      e.preventDefault();
      steer(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stickVec = [0, 0];
      this.stickDrift = false;
      this.stick?.classList.remove("on", "drift");
      this.moveKnob(0, 0, radius());
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  private moveKnob(dx: number, dy: number, r: number): void {
    if (this.knob) this.knob.style.transform = `translate(${dx * r}px, ${dy * r}px)`;
  }

  /** Where the stick waits for a thumb: low on the left. */
  private restStick(): void {
    if (!this.stick) return;
    this.stick.style.left = `${Math.max(86, window.innerWidth * 0.15)}px`;
    this.stick.style.top = `${window.innerHeight - Math.max(104, window.innerHeight * 0.27)}px`;
  }

  /** Show the touch controls only during a race (in menus, taps go to the menus); the pause
   * button also while a circuit is being dreamed, where it cancels. */
  setRacing(on: boolean, pausable = on): void {
    this.touchRoot.classList.toggle("racing", on);
    this.touchRoot.classList.toggle("pausable", pausable);
    if (!on) {
      this.held.delete("drift");
      this.held.delete("item");
      this.held.delete("back");
    }
  }

  private pollPad(): { steer: number; gas: number; brake: number; drift: boolean; item: boolean; back: boolean } | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p) continue;
      const now = new Set<string>();
      const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
      if (p.buttons[12]?.pressed || ay < -0.6) now.add("up");
      if (p.buttons[13]?.pressed || ay > 0.6) now.add("down");
      if (p.buttons[14]?.pressed || ax < -0.6) now.add("left");
      if (p.buttons[15]?.pressed || ax > 0.6) now.add("right");
      if (p.buttons[0]?.pressed) now.add("confirm");
      if (p.buttons[1]?.pressed) now.add("cancel");
      if (p.buttons[9]?.pressed) now.add("pause");
      for (const k of now) if (!this.padPrev.has(k)) this.events.push(k as MenuEvent);
      this.padPrev = now;
      // steer + = left: stick left is negative x; d-pad left adds, d-pad right subtracts
      const steer = -(Math.abs(ax) > 0.15 ? ax : 0) + (p.buttons[14]?.pressed ? 1 : 0) - (p.buttons[15]?.pressed ? 1 : 0);
      return {
        steer: Math.max(-1, Math.min(1, steer)),
        gas: Math.max(p.buttons[7]?.value ?? 0, p.buttons[0]?.pressed ? 1 : 0),
        brake: Math.max(p.buttons[6]?.value ?? 0, p.buttons[1]?.pressed ? 1 : 0),
        drift: !!(p.buttons[5]?.pressed || p.buttons[4]?.pressed),
        item: !!p.buttons[3]?.pressed, // Y
        back: !!p.buttons[2]?.pressed, // X: the item thrown behind
      };
    }
    return null;
  }

  /** Driving controls this frame. steer: + = left. ``countdown``: before GO, touch revs the
   * engine only while the thumb is on the stick (so a rocket start is a well-timed touch). */
  drive(countdown = false): DriveInput {
    const pad = this.pollPad();
    const h = this.held;
    const k: DriveInput = {
      steer: (h.has("left") ? 1 : 0) - (h.has("right") ? 1 : 0),
      throttle: h.has("gas") ? 1 : 0, brake: h.has("brake") ? 1 : 0, drift: h.has("drift"), item: h.has("item"),
      back: h.has("back"),
      // (tricks come from the drift key or button only: on touch, the stick pushed hard over drifts
      // too, and every hard turn before a jump was taken as a trick)
      hop: h.has("drift"),
    };
    if (this.touchMode) {
      const s = stickControls(this.stickVec[0], this.stickVec[1], this.stickDrift);
      if (this.stickId !== null) this.stickDrift = s.drift;
      this.stick?.classList.toggle("drift", this.stickId !== null && s.drift);
      if (Math.abs(s.steer) > Math.abs(k.steer)) k.steer = s.steer;
      k.brake = Math.max(k.brake, s.brake);
      k.drift ||= this.stickId !== null && s.drift;
      const gas = countdown ? (this.stickId !== null ? 1 : 0) : k.brake > 0 ? 0 : 1;
      k.throttle = Math.max(k.throttle, gas);
    }
    if (!pad) return k;
    return {
      steer: Math.abs(pad.steer) > Math.abs(k.steer) ? pad.steer : k.steer,
      throttle: Math.max(k.throttle, pad.gas),
      brake: Math.max(k.brake, pad.brake),
      drift: k.drift || pad.drift,
      hop: k.hop || pad.drift,
      item: k.item || pad.item,
      back: k.back || pad.back,
    };
  }

  /** Edge-triggered menu events since the last call. */
  takeEvents(): MenuEvent[] {
    this.pollPad();
    const e = this.events;
    this.events = [];
    return e;
  }

  takeClick(): { x: number; y: number } | null {
    if (!this.pointer.clicked) return null;
    this.pointer.clicked = false;
    return { x: this.pointer.x, y: this.pointer.y };
  }

  get anyDriveHeld(): boolean {
    return this.held.size > 0;
  }
}
