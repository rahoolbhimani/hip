/**
 * Automatic landmark proposals on an AP pelvis radiograph (no trained model).
 *
 * Works on a ~1 mm/px downsampled copy:
 *  - femoral heads and the calibration marker: gradient-direction circular
 *    Hough transform (bright disc), one head per image half
 *  - femoral shafts: per-row search for the bright-cortex / darker-canal /
 *    bright-cortex pattern below each head, robust line fit
 *  - lesser trochanter: largest local protrusion of the medial bone edge
 *    below the head
 *  - teardrop: search around the typical position relative to the head for
 *    the inferior tip of a bright structure (bright above, darker below)
 *
 * Every result is a PROPOSAL for the user to confirm or drag.
 */
import { type GrayImage, createGray, sample, smooth1d, derivative } from './gray';
import { type Vec2, add, scale, sub } from '../geometry/vec';
import { type Circle, type Line, fitLineRobust, median } from '../geometry/fit';
import { detectFemoralHead } from './detect';

export type PatientSide = 'R' | 'L';

export interface AutoSide {
  head?: Circle;
  teardrop?: Vec2;
  lesserTrochanter?: Vec2;
  canalSeeds?: [Vec2, Vec2];
}

export interface AutoResult {
  /** Scale used for the search (mm per full-resolution px). */
  mmPerPx: number;
  /** Detected calibration marker (full-res px), if any. */
  marker?: Circle;
  sides: Record<PatientSide, AutoSide>;
  notes: string[];
}

/** Typical AP pelvis field width (mm at the hip) used when the image is uncalibrated. */
const ASSUMED_FIELD_MM = 380;

export function guessMmPerPx(img: GrayImage): number {
  return ASSUMED_FIELD_MM / img.width;
}

// ------------------------------------------------------------------ small-image helpers

interface Small {
  img: GrayImage;
  /** Full-res px per small px. */
  f: number;
  /** mm per small px. */
  mm: number;
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

function downsample(img: GrayImage, f: number): GrayImage {
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * img.width + x * f;
        for (let dx = 0; dx < f; dx++) acc += img.data[row + dx];
      }
      out.data[y * w + x] = acc / (f * f);
    }
  }
  return out;
}

function blur(img: GrayImage, sigma: number): GrayImage {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += img.data[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * w + x] = a / sum;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out.data[y * w + x] = a / sum;
    }
  }
  return out;
}

function prepare(img: GrayImage, mmPerPx: number): Small {
  const f = Math.max(1, Math.round(1 / mmPerPx));
  const small = blur(downsample(img, f), 1.2);
  const { width: w, height: h } = small;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  const d = small.data;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const sx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
      const sy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  return { img: small, f, mm: f * mmPerPx, gx, gy, mag };
}

function percentile(arr: Float32Array, p: number): number {
  const step = Math.max(1, Math.floor(arr.length / 50000));
  const v: number[] = [];
  for (let i = 0; i < arr.length; i += step) v.push(arr[i]);
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

interface HoughPeak {
  x: number;
  y: number;
  r: number;
  score: number;
}

/**
 * Circular Hough for bright discs: each strong edge pixel votes at distance r
 * along its gradient (which points into the brighter interior).
 */
function houghBrightCircles(s: Small, rMin: number, rMax: number, region: { x0: number; x1: number; y0: number; y1: number }): HoughPeak[] {
  const { width: w, height: h } = s.img;
  const thr = percentile(s.mag, 0.85);
  const radii: number[] = [];
  for (let r = Math.max(2, Math.floor(rMin)); r <= Math.ceil(rMax); r++) radii.push(r);
  const acc = radii.map(() => new Float32Array(w * h));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = s.mag[i];
      if (m < thr) continue;
      const ux = s.gx[i] / m;
      const uy = s.gy[i] / m;
      for (let k = 0; k < radii.length; k++) {
        const cx = Math.round(x + ux * radii[k]);
        const cy = Math.round(y + uy * radii[k]);
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        acc[k][cy * w + cx] += 1;
      }
    }
  }
  const peaks: HoughPeak[] = [];
  for (let k = 0; k < radii.length; k++) {
    const a = acc[k];
    const circ = 2 * Math.PI * radii[k];
    for (let y = Math.max(1, region.y0); y < Math.min(h - 1, region.y1); y++) {
      for (let x = Math.max(1, region.x0); x < Math.min(w - 1, region.x1); x++) {
        // 3×3 box sum tolerates small centre errors.
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += a[(y + dy) * w + x + dx];
        const score = v / circ;
        if (score > 0.15) peaks.push({ x, y, r: radii[k], score });
      }
    }
  }
  peaks.sort((p, q) => q.score - p.score);
  // Non-maximum suppression.
  const out: HoughPeak[] = [];
  for (const p of peaks) {
    if (out.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < Math.max(p.r, q.r) * 0.8)) continue;
    out.push(p);
    if (out.length >= 12) break;
  }
  return out;
}

function meanDisc(img: GrayImage, cx: number, cy: number, r: number): number {
  let acc = 0;
  let n = 0;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      acc += img.data[y * img.width + x];
      n++;
    }
  }
  return n ? acc / n : 0;
}

// ------------------------------------------------------------------ main entry

export function autoDetectLandmarks(
  img: GrayImage,
  opts: { mmPerPx?: number; standardOrientation: boolean; markerDiameterMm?: number },
): AutoResult {
  const notes: string[] = [];
  let mmPerPx = opts.mmPerPx ?? guessMmPerPx(img);
  const result: AutoResult = { mmPerPx, sides: { R: {}, L: {} }, notes };

  // --- Calibration marker (only searched when uncalibrated).
  if (!opts.mmPerPx) {
    const s = prepare(img, mmPerPx);
    const W = s.img.width;
    const H = s.img.height;
    const markerR = (opts.markerDiameterMm ?? 25) / 2 / s.mm;
    const bright = percentile(s.img.data, 0.985);
    const cands = houghBrightCircles(s, markerR * 0.55, markerR * 1.6, { x0: 0, x1: W, y0: 0, y1: H })
      .filter((p) => p.score > 0.35 && meanDisc(s.img, p.x, p.y, p.r * 0.7) >= bright * 0.97);
    if (cands.length) {
      const best = cands[0];
      const seed = { x: best.x * s.f + s.f / 2, y: best.y * s.f + s.f / 2 };
      const rPx = best.r * s.f;
      const det = detectFemoralHead(img, seed, rPx * 0.7, rPx * 1.3);
      const circle = det && det.confidence > 0.4 ? det.circle : { center: seed, radius: rPx };
      result.marker = circle;
      mmPerPx = (opts.markerDiameterMm ?? 25) / (2 * circle.radius);
      result.mmPerPx = mmPerPx;
    } else {
      notes.push('No calibration marker found: scale estimated from image width. Calibrate before trusting sizes.');
    }
  }

  const s = prepare(img, mmPerPx);
  const W = s.img.width;
  const H = s.img.height;
  const toFull = (p: Vec2): Vec2 => ({ x: p.x * s.f + s.f / 2, y: p.y * s.f + s.f / 2 });
  const mm = (v: number): number => v / s.mm; // mm → small px

  // --- Femoral heads: best bright disc of plausible size in each image half.
  const leftSide: PatientSide = opts.standardOrientation ? 'R' : 'L';
  const rightSide: PatientSide = leftSide === 'R' ? 'L' : 'R';
  const halves: Array<{ side: PatientSide; x0: number; x1: number }> = [
    { side: leftSide, x0: Math.floor(W * 0.04), x1: Math.floor(W * 0.5) },
    { side: rightSide, x0: Math.floor(W * 0.5), x1: Math.floor(W * 0.96) },
  ];
  for (const half of halves) {
    const peaks = houghBrightCircles(s, mm(18), mm(32), { x0: half.x0, x1: half.x1, y0: Math.floor(H * 0.08), y1: Math.floor(H * 0.75) });
    const marker = result.marker;
    const pk = peaks.find((p) => !marker || Math.hypot(toFull(p).x - marker.center.x, toFull(p).y - marker.center.y) > marker.radius * 2);
    if (!pk) {
      notes.push(`No femoral head found on the ${half.side === 'R' ? 'right' : 'left'} side.`);
      continue;
    }
    const seed = toFull(pk);
    const det = detectFemoralHead(img, seed, 15 / mmPerPx, 34 / mmPerPx);
    result.sides[half.side].head = det && det.confidence > 0.3 ? det.circle : { center: seed, radius: (pk.r * s.f) };
  }

  // --- Per side: shaft, LT, teardrop.
  for (const side of ['R', 'L'] as PatientSide[]) {
    const head = result.sides[side].head;
    if (!head) continue;
    const onLeft = (side === 'R') === opts.standardOrientation;
    const lat = onLeft ? -1 : 1; // image-x direction pointing lateral for this hip
    const hc = { x: head.center.x / s.f, y: head.center.y / s.f };
    const hr = head.radius / s.f;

    const shaft = findShaft(s, hc, lat, mm);
    if (shaft) {
      const ltSmall = findLesserTrochanter(s, hc, hr, shaft.line, lat, mm);
      const ltY = ltSmall ? ltSmall.y : hc.y + mm(55);
      const axisAt = (y: number): Vec2 => {
        const t = (y - shaft.line.point.y) / shaft.line.dir.y;
        return add(shaft.line.point, scale(shaft.line.dir, t));
      };
      const distalY = Math.min(shaft.lastY, ltY + mm(130));
      if (distalY - ltY > mm(50)) {
        result.sides[side].canalSeeds = [toFull(axisAt(ltY)), toFull(axisAt(distalY))];
      } else {
        notes.push(`The ${side === 'R' ? 'right' : 'left'} femoral shaft is too short on the image for reliable stem sizing.`);
      }
      if (ltSmall) result.sides[side].lesserTrochanter = toFull(ltSmall);
    } else {
      notes.push(`No femoral shaft found below the ${side === 'R' ? 'right' : 'left'} head.`);
    }

    const td = findTeardrop(s, hc, lat, mm);
    if (td) result.sides[side].teardrop = toFull(td);
  }

  // Teardrops should be roughly level; if one is far off, mirror the other's height.
  const tR = result.sides.R.teardrop;
  const tL = result.sides.L.teardrop;
  if (tR && tL && Math.abs(tR.y - tL.y) * mmPerPx > 15) {
    notes.push('Teardrops were detected at very different heights. Check both.');
  }
  return result;
}

function findShaft(s: Small, hc: Vec2, lat: number, mm: (v: number) => number): { line: Line; lastY: number } | null {
  const { width: W, height: H } = s.img;
  const pts: Vec2[] = [];
  const contrast = Math.max(1, percentile(s.img.data, 0.99) - percentile(s.img.data, 0.01));
  const y0 = Math.round(hc.y + mm(65));
  const y1 = Math.min(H - 3, Math.round(hc.y + mm(220)));
  for (let y = y0; y <= y1; y += Math.max(1, Math.round(mm(4)))) {
    // Row profile averaged over 3 rows, with prefix sums for fast band means.
    const prefix = new Float64Array(W + 1);
    for (let x = 0; x < W; x++) {
      const v = (s.img.data[(y - 1) * W + x] + s.img.data[y * W + x] + s.img.data[(y + 1) * W + x]) / 3;
      prefix[x + 1] = prefix[x] + v;
    }
    const band = (a: number, b: number): number => {
      const lo = Math.max(0, Math.min(W, Math.round(a)));
      const hi = Math.max(0, Math.min(W, Math.round(b)));
      return hi > lo ? (prefix[hi] - prefix[lo]) / (hi - lo) : NaN;
    };
    let best = { score: -Infinity, x: 0 };
    const xa = hc.x + lat * mm(-35);
    const xb = hc.x + lat * mm(75);
    const xmin = Math.max(2, Math.min(xa, xb));
    const xmax = Math.min(W - 3, Math.max(xa, xb));
    for (let x = xmin; x <= xmax; x++) {
      for (let c = mm(3); c <= mm(14); c += Math.max(1, mm(1))) {
        for (let t = mm(3); t <= mm(9); t += Math.max(1, mm(2))) {
          const canal = band(x - c, x + c);
          const L = band(x - c - t, x - c);
          const R = band(x + c, x + c + t);
          const oL = band(x - c - t - mm(6), x - c - t);
          const oR = band(x + c + t, x + c + t + mm(6));
          if ([canal, L, R, oL, oR].some(Number.isNaN)) continue;
          const score = (Math.min(L, R) - canal + Math.min(L - oL, R - oR) - 0.5 * Math.abs(L - R)) / contrast;
          if (score > best.score) best = { score, x };
        }
      }
    }
    if (best.score > 0.08) pts.push({ x: best.x, y });
  }
  if (pts.length < 5) return null;
  const line = fitLineRobust(pts);
  if (!line) return null;
  // Shafts are near-vertical.
  if (Math.abs(line.dir.y) < 0.9) return null;
  const dir = line.dir.y < 0 ? scale(line.dir, -1) : line.dir;
  const inl = pts.filter((p) => {
    const d = sub(p, line.point);
    return Math.abs(d.x * dir.y - d.y * dir.x) < mm(4);
  });
  if (inl.length < Math.max(5, pts.length * 0.4)) return null;
  return { line: { point: line.point, dir }, lastY: Math.max(...inl.map((p) => p.y)) };
}

function findLesserTrochanter(s: Small, hc: Vec2, hr: number, axis: Line, lat: number, mm: (v: number) => number): Vec2 | null {
  const medial = -lat;
  const rows: Array<{ y: number; dist: number; ax: number }> = [];
  const y0 = Math.round(hc.y + hr + mm(8));
  const y1 = Math.round(hc.y + hr + mm(70));
  for (let y = y0; y <= y1; y++) {
    const t = (y - axis.point.y) / axis.dir.y;
    const ax = axis.point.x + axis.dir.x * t;
    const prof: number[] = [];
    for (let k = 0; k <= mm(55); k++) prof.push(sample(s.img, ax + medial * k, y));
    const d = derivative(smooth1d(prof, 1));
    let minD = 0;
    for (let k = Math.round(mm(8)); k < d.length - 1; k++) minD = Math.min(minD, d[k]);
    if (minD >= 0) continue;
    // First strong bright→dark fall walking medially = medial bone edge.
    let edge = -1;
    for (let k = Math.round(mm(8)); k < d.length - 1; k++) {
      if (d[k] <= 0.5 * minD && d[k] <= d[k - 1] && d[k] <= d[k + 1]) {
        edge = k;
        break;
      }
    }
    if (edge > 0) rows.push({ y, dist: edge, ax });
  }
  if (rows.length < 10) return null;
  const win = Math.max(3, Math.round(mm(12)));
  let best: { y: number; dist: number; ax: number; prot: number } | null = null;
  for (let i = win; i < rows.length - win; i++) {
    const around = median([...rows.slice(i - win, i - Math.floor(win / 2)), ...rows.slice(i + Math.floor(win / 2) + 1, i + win + 1)].map((r) => r.dist));
    const prot = rows[i].dist - around;
    if (!best || prot > best.prot) best = { ...rows[i], prot };
  }
  if (!best || best.prot < mm(1.5)) return null;
  return { x: best.ax + medial * best.dist, y: best.y };
}

function findTeardrop(s: Small, hc: Vec2, lat: number, mm: (v: number) => number): Vec2 | null {
  const medial = -lat;
  const prior = { x: hc.x + medial * mm(32), y: hc.y + mm(18) };
  const R = Math.round(mm(14));
  const sigma = mm(8);
  const { width: W } = s.img;
  let best: { x: number; y: number; v: number } | null = null;
  for (let y = Math.round(prior.y - R); y <= prior.y + R; y++) {
    for (let x = Math.round(prior.x - R); x <= prior.x + R; x++) {
      if (x < 1 || y < 1 || x >= W - 1 || y >= s.img.height - 1) continue;
      // Bright above, darker below → strongly negative vertical gradient.
      const gy = s.gy[y * W + x];
      const w = Math.exp(-((x - prior.x) ** 2 + (y - prior.y) ** 2) / (2 * sigma * sigma));
      const v = -gy * w;
      if (!best || v > best.v) best = { x, y, v };
    }
  }
  return best && best.v > 0 ? { x: best.x, y: best.y } : prior;
}
