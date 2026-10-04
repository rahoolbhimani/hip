/** Single-channel float image, row-major, used for all analysis. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

export function fromRGBA(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const g = createGray(width, height);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    g.data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return g;
}

/** Bilinear sample; returns NaN outside the image. */
export function sample(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const w = img.width;
  const d = img.data;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bot = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/** 1D Gaussian smoothing of a profile (NaNs are treated as edge-replicated). */
export function smooth1d(values: number[], sigma: number): number[] {
  if (sigma <= 0) return [...values];
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const k = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(k);
    sum += k;
  }
  const n = values.length;
  const clean = values.map((v, i) => (Number.isNaN(v) ? nearestFinite(values, i) : v));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const idx = Math.min(n - 1, Math.max(0, i + j));
      acc += clean[idx] * kernel[j + r];
    }
    out[i] = acc / sum;
  }
  return out;
}

function nearestFinite(values: number[], i: number): number {
  for (let d = 1; d < values.length; d++) {
    if (i - d >= 0 && !Number.isNaN(values[i - d])) return values[i - d];
    if (i + d < values.length && !Number.isNaN(values[i + d])) return values[i + d];
  }
  return 0;
}

/** Central-difference derivative of a profile. */
export function derivative(values: number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) out[i] = (values[i + 1] - values[i - 1]) / 2;
  return out;
}

/** Percentile-based contrast window, useful for display and normalisation. */
export function intensityWindow(img: GrayImage, lowPct = 0.01, highPct = 0.99): [number, number] {
  const step = Math.max(1, Math.floor(img.data.length / 200000));
  const vals: number[] = [];
  for (let i = 0; i < img.data.length; i += step) vals.push(img.data[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(lowPct * (vals.length - 1))];
  const hi = vals[Math.floor(highPct * (vals.length - 1))];
  return [lo, hi > lo ? hi : lo + 1];
}
