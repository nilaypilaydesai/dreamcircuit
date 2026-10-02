// Keyboard, touch and gamepad -> (steer, pedal) in [-1, 1]. Digital inputs produce exactly the
// {-1, 0, 1} actions of the "keyboard" drivers in the training data.

export interface Controls {
  steer: number; // + = left
  pedal: number; // + = throttle, - = brake
}

const KEYS: Record<string, "gas" | "brake" | "left" | "right"> = {
  ArrowUp: "gas", KeyW: "gas", ArrowDown: "brake", KeyS: "brake",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
};

export class Input {
  private held = new Set<string>();
  private inView = true;
  onAction: ((name: string) => void) | null = null;

  /** Keys drive the car only while ``scope`` is on screen; elsewhere the page scrolls as usual. */
  constructor(touchRoot: HTMLElement | null, scope?: HTMLElement) {
    if (scope && "IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        this.inView = entries.some((en) => en.isIntersecting);
        if (!this.inView) this.held.clear();
      }, { threshold: 0.3 }).observe(scope);
    }
    window.addEventListener("keydown", (e) => {
      if (!this.inView || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const k = KEYS[e.code];
      if (k) {
        this.held.add(k);
        e.preventDefault();
      } else if (e.code === "Space") {
        this.onAction?.("autopilot");
        e.preventDefault();
      } else if (e.code === "KeyR") {
        this.onAction?.("wake");
      } else if (e.code === "KeyT") {
        this.onAction?.("track");
      } else if (/^Digit[1-4]$/.test(e.code)) {
        this.onAction?.(`steps:${e.code.slice(5)}`);
      }
    });
    window.addEventListener("keyup", (e) => {
      const k = KEYS[e.code];
      if (k) this.held.delete(k);
    });
    window.addEventListener("blur", () => this.held.clear());
    touchRoot?.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach((b) => {
      const k = b.dataset.k!;
      const on = (e: Event) => { e.preventDefault(); this.held.add(k); b.classList.add("on"); };
      const off = (e: Event) => { e.preventDefault(); this.held.delete(k); b.classList.remove("on"); };
      b.addEventListener("pointerdown", on);
      b.addEventListener("pointerup", off);
      b.addEventListener("pointerleave", off);
      b.addEventListener("pointercancel", off);
    });
  }

  get active(): boolean {
    return this.held.size > 0 || this.gamepad() !== null;
  }

  private gamepad(): Controls | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p) continue;
      const steer = -(Math.abs(p.axes[0]) > 0.12 ? p.axes[0] : 0);
      const gas = p.buttons[7]?.value ?? 0;
      const brake = p.buttons[6]?.value ?? 0;
      if (steer !== 0 || gas > 0.05 || brake > 0.05) return { steer, pedal: gas - brake };
    }
    return null;
  }

  read(): Controls {
    const pad = this.gamepad();
    if (pad) return pad;
    const h = this.held;
    return {
      steer: (h.has("left") ? 1 : 0) - (h.has("right") ? 1 : 0),
      pedal: (h.has("gas") ? 1 : 0) - (h.has("brake") ? 1 : 0),
    };
  }
}
