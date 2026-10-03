// How to play: four short pages instead of one wall of text: the keyboard, the gamepad and the
// touch controls, each drawn as key caps (or the stick) beside a few words, and the tips, a line
// apiece. Left and right turn the pages; any other key goes back.

import type { PixelFont } from "../core/font";
import { H, W, hex, type Screen } from "../core/gfx";

const INK = hex("#0b0b14");
const PANEL = hex("#0c0a1d");
const EDGE = hex("#c79bff");
const HOT = hex("#ffd23f");
const DIM = hex("#8f87b8");
const TEXT = hex("#f1eeff");
const CAP = hex("#2a2350"), CAP_TOP = hex("#6a5cb0"), CAP_SIDE = hex("#16122c");

export const HOWTO_PAGES = ["KEYS", "PAD", "TOUCH", "TIPS"];

type Row = { caps: string[]; text: string };

const KEYS: Row[] = [
  { caps: ["^", "W"], text: "GAS" },
  { caps: ["v", "S"], text: "BRAKE. HOLD IT TO BACK UP" },
  { caps: ["<", ">", "A", "D"], text: "STEER" },
  { caps: ["SHIFT", "SPACE"], text: "DRIFT, OR HOP AT A RAMP" },
  { caps: ["E"], text: "USE YOUR ITEM" },
  { caps: ["R"], text: "THROW IT BEHIND YOU" },
  { caps: ["ESC"], text: "PAUSE" },
  { caps: ["M"], text: "SOUND ON OR OFF" },
];
const PAD: Row[] = [
  { caps: ["A"], text: "GAS" },
  { caps: ["B"], text: "BRAKE. HOLD IT TO BACK UP" },
  { caps: ["STICK"], text: "STEER" },
  { caps: ["RB"], text: "DRIFT, OR HOP AT A RAMP" },
  { caps: ["Y"], text: "USE YOUR ITEM" },
  { caps: ["X"], text: "THROW IT BEHIND YOU" },
  { caps: ["START"], text: "PAUSE" },
];
// (the stick caps draw a joystick: centred, pushed over, pulled back)
const TOUCH: Row[] = [
  { caps: ["@"], text: "THE STICK UNDER YOUR LEFT THUMB STEERS" },
  { caps: ["@>"], text: "PUSH IT ALL THE WAY OVER TO DRIFT" },
  { caps: ["@v"], text: "PULL IT BACK TO BRAKE (THE GAS IS ON BY ITSELF)" },
  { caps: ["DRIFT"], text: "HOP, OR DRIFT" },
  { caps: ["ITEM"], text: "USE YOUR ITEM" },
  { caps: ["BACK"], text: "THROW IT BEHIND YOU" },
  { caps: ["II"], text: "PAUSE" },
];
const TIPS: [string, string][] = [
  ["DRIFT", "HOLD IN A TURN, LET GO: MINI-TURBO"],
  ["START", "GAS JUST BEFORE GO: ROCKET START"],
  ["RAMPS", "HOP RIGHT AT THE LIP: TRICK BOOST"],
  ["AIM", "PRESS ONCE TO AIM, AGAIN TO THROW. A MIRROR SHOWS THE AIM BEHIND"],
  ["SHIELD", "HOLD OIL OR AN ORB BEHIND YOU"],
  ["COINS", "UP TO 10: EACH ADDS TOP SPEED"],
  ["FALLS", "OFF A BRIDGE, INTO LAVA OR A POND: A DRONE LIFTS YOU OUT"],
  ["MOON", "LOW GRAVITY: YOU FLOAT OVER CRESTS"],
];

/** A thumb stick, from above: a ring for its well and the knob in it, centred or pushed
 * (``to``: ">" or "v"). */
function stick(scr: Screen, x: number, y: number, to: string): number {
  const cx = x + 7, cy = y + 6;
  for (let a = 0; a < 48; a++) {
    const t = (a / 48) * Math.PI * 2;
    scr.fillRect(Math.round(cx + Math.cos(t) * 6.5), Math.round(cy + Math.sin(t) * 6.5), 1, 1, DIM);
  }
  const kx = cx + (to === ">" ? 3 : 0), ky = cy + (to === "v" ? 3 : 0);
  for (let dy = -3; dy <= 3; dy++) {
    const half = Math.floor(Math.sqrt(Math.max(0, 11 - dy * dy)));
    scr.fillRect(kx - half, ky + dy, 2 * half + 1, 1, dy < -1 ? TEXT : CAP_TOP);
  }
  return 15;
}

/** A key cap: a raised key with ``label`` on it (^ v < > draw arrows; @ a thumb stick). Returns
 * its width. */
function keycap(scr: Screen, f: PixelFont, x: number, y: number, label: string): number {
  if (label[0] === "@") return stick(scr, x, y, label.slice(1));
  const arrow = label.length === 1 && "^v<>".includes(label);
  const w = arrow ? 13 : f.width(label) + 7, h = 13;
  scr.fillRect(x, y + 2, w, h - 1, CAP_SIDE); // the key's sides
  scr.fillRect(x, y, w, h - 2, CAP); // its top
  scr.fillRect(x + 1, y, w - 2, 1, CAP_TOP);
  scr.fillRect(x, y + 1, 1, h - 4, CAP_TOP);
  if (arrow) {
    const cx = x + 6, cy = y + 5;
    for (let k = 0; k < 4; k++) {
      if (label === "^") scr.fillRect(cx - k, cy - 2 + k, 2 * k + 1, 1, TEXT);
      else if (label === "v") scr.fillRect(cx - k, cy + 2 - k, 2 * k + 1, 1, TEXT);
      else if (label === "<") scr.fillRect(cx - 2 + k, cy - k, 1, 2 * k + 1, TEXT);
      else scr.fillRect(cx + 2 - k, cy - k, 1, 2 * k + 1, TEXT);
    }
  } else {
    f.draw(scr, label, x + 4, y + 2, { color: TEXT });
  }
  return w;
}

/** Rows of key caps and their words (a line or two), spread out over ``room`` px from y, in a
 * column from x to x + width. */
function rows(scr: Screen, f: PixelFont, list: Row[], x: number, y: number, width: number, capsW: number, room: number): void {
  const text = list.map((r) => f.wrap(r.text, width - capsW - 6).slice(0, 2));
  const tall = text.map((l) => Math.max(13, l.length * 10));
  const gap = Math.max(3, Math.min(9, Math.floor((room - tall.reduce((a, b) => a + b, 0)) / Math.max(1, list.length - 1))));
  let yy = y;
  list.forEach((r, i) => {
    let cx = x;
    for (const c of r.caps) cx += keycap(scr, f, cx, yy, c) + 3;
    text[i].forEach((line, j) => f.draw(scr, line, x + capsW + 6, yy + 3 + j * 10, { color: TEXT }));
    yy += tall[i] + gap;
  });
}

/** Draw page ``page`` of how to play. */
export function drawHowTo(scr: Screen, f: PixelFont, page: number, touch: boolean, now: number): void {
  const pw = Math.min(W - 16, 380), ph = H - 12, x0 = Math.round((W - pw) / 2), y0 = 6;
  scr.dimRect(x0, y0, pw, ph, PANEL, 0.9);
  scr.fillRect(x0, y0, pw, 1, EDGE);
  scr.fillRect(x0, y0 + ph - 1, pw, 1, EDGE);
  scr.fillRect(x0, y0, 1, ph, EDGE);
  scr.fillRect(x0 + pw - 1, y0, 1, ph, EDGE);
  f.draw(scr, "HOW TO PLAY", W / 2, y0 + 7, { color: HOT, outline: INK, align: "center" });
  // the tabs: which page this is, and the others
  const tabs = HOWTO_PAGES.map((name) => f.width(name) + 12);
  let tx = Math.round(W / 2 - (tabs.reduce((a, b) => a + b, 0) + 4 * (tabs.length - 1)) / 2);
  HOWTO_PAGES.forEach((name, i) => {
    const on = i === page;
    if (on) scr.dimRect(tx, y0 + 19, tabs[i], 12, EDGE, 0.22);
    scr.fillRect(tx, y0 + 30, tabs[i], 1, on ? HOT : hex("#3a3166"));
    f.draw(scr, name, tx + 6, y0 + 21, { color: on ? HOT : DIM });
    tx += tabs[i] + 4;
  });
  const top = y0 + 40, bottom = y0 + ph - 20, room = bottom - top, inner = pw - 24, cx0 = x0 + 12;
  if (page === 0) rows(scr, f, KEYS, cx0, top, inner, 104, room);
  else if (page === 1) rows(scr, f, PAD, cx0, top, inner, 52, room);
  else if (page === 2) rows(scr, f, TOUCH, cx0, top, inner, 46, room);
  else {
    // a label, then the tip in a line or two; the rows spread out to fill the page
    const textX = cx0 + 64, textW = inner - 64;
    const wrapped = TIPS.map(([, t]) => f.wrap(t, textW).slice(0, 2));
    const used = wrapped.reduce((a, l) => a + l.length * 10, 0);
    const gap = Math.max(3, Math.min(9, Math.floor((room - used) / (TIPS.length - 1))));
    let y = top;
    TIPS.forEach(([label], i) => {
      f.draw(scr, label, cx0, y, { color: EDGE });
      wrapped[i].forEach((line, j) => f.draw(scr, line, textX, y + j * 10, { color: TEXT }));
      y += wrapped[i].length * 10 + gap;
    });
  }
  const foot = touch ? "TAP FOR THE NEXT PAGE" : "< > PAGES     ANY OTHER KEY: BACK";
  if (Math.floor(now * 2) % 2 === 0 || page > 0) f.draw(scr, foot, W / 2, y0 + ph - 13, { color: DIM, align: "center" });
}
