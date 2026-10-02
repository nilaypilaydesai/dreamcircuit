// Draw 64x64 frames onto (CSS-upscaled, pixelated) canvases.

import { chwToRgb } from "../dream/engine";

export class Screen {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;

  constructor(readonly canvas: HTMLCanvasElement, readonly size = 64) {
    canvas.width = size;
    canvas.height = size;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.image = this.ctx.createImageData(size, size);
    this.image.data.fill(255);
  }

  drawRGB(rgb: Uint8Array): void {
    const d = this.image.data;
    for (let i = 0, n = this.size * this.size; i < n; i++) {
      d[4 * i] = rgb[3 * i];
      d[4 * i + 1] = rgb[3 * i + 1];
      d[4 * i + 2] = rgb[3 * i + 2];
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  drawCHW(chw: Float32Array): void {
    this.drawRGB(chwToRgb(chw, this.size));
  }
}

/** PSNR (dB) between two RGB byte frames, the "divergence" readout of split mode. */
export function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  const mse = se / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** Tiny sparkline of recent PSNR values. */
export function drawSpark(canvas: HTMLCanvasElement, values: number[], lo = 8, hi = 32): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(148,163,184,0.18)";
  ctx.lineWidth = 1;
  for (const v of [15, 25]) {
    const y = h - ((v - lo) / (hi - lo)) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  if (values.length < 2) return;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#fb923c");
  grad.addColorStop(1, "#a78bfa");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#8b93a7";
  ctx.font = "11px JetBrains Mono, monospace";
  ctx.fillText("dream vs reality PSNR (dB)", 6, 13);
}
