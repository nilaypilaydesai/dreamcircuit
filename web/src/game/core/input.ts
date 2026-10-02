// Game input: keyboard, gamepad and touch, read as continuous driving controls plus
// edge-triggered menu events. Listens only while the game screen is active, so the rest of the
// site (the DATA pages) keeps normal keyboard scrolling.

// "cancel" is the pad's B: back in menus, but not a pause in a race (there B brakes)
export type MenuEvent = "up" | "down" | "left" | "right" | "confirm" | "back" | "cancel" | "pause";

const DRIVE: Record<string, string> = {
  ArrowUp: "gas", KeyW: "gas", ArrowDown: "brake", KeyS: "brake",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
  ShiftLeft: "drift", ShiftRight: "drift", Space: "drift", KeyX: "gas", KeyZ: "brake",
  KeyE: "item", KeyC: "item",
};
const MENU: Record<string, MenuEvent> = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right", Enter: "confirm", Space: "confirm", KeyX: "confirm",
  Escape: "back", Backspace: "back", KeyP: "pause",
};

export class GameInput {
  private held = new Set<string>();
  private events: MenuEvent[] = [];
  private padPrev = new Set<string>();
  active = true;
  onMute: (() => void) | null = null;
  pointer: { x: number; y: number; down: boolean; clicked: boolean } = { x: -1, y: -1, down: false, clicked: false };

  constructor(canvas: HTMLCanvasElement, touchRoot: HTMLElement) {
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
    });
    canvas.addEventListener("pointerup", (e) => {
      toLocal(e);
      this.pointer.down = false;
      this.pointer.clicked = true;
    });
    touchRoot.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach((b) => {
      const k = b.dataset.k!;
      const on = (e: Event) => { e.preventDefault(); this.held.add(k); b.classList.add("on"); };
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
  }

  private pollPad(): { steer: number; gas: number; brake: number; drift: boolean; item: boolean } | null {
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
        brake: Math.max(p.buttons[6]?.value ?? 0, p.buttons[1]?.pressed || p.buttons[2]?.pressed ? 1 : 0),
        drift: !!(p.buttons[5]?.pressed || p.buttons[4]?.pressed),
        item: !!p.buttons[3]?.pressed,
      };
    }
    return null;
  }

  /** Driving controls this frame. steer: + = left. */
  drive(): { steer: number; throttle: number; brake: number; drift: boolean; item: boolean } {
    const pad = this.pollPad();
    const h = this.held;
    const steer = (h.has("left") ? 1 : 0) - (h.has("right") ? 1 : 0);
    const k = {
      steer, throttle: h.has("gas") ? 1 : 0, brake: h.has("brake") ? 1 : 0, drift: h.has("drift"),
      item: h.has("item"),
    };
    if (!pad) return k;
    return {
      steer: Math.abs(pad.steer) > Math.abs(k.steer) ? pad.steer : k.steer,
      throttle: Math.max(k.throttle, pad.gas),
      brake: Math.max(k.brake, pad.brake),
      drift: k.drift || pad.drift,
      item: k.item || pad.item,
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
