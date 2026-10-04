/**
 * Procedural AP-pelvis phantom with known ground truth. Used for the in-app
 * demo case and to test the detection + planning pipeline end to end.
 *
 * It is a schematic, not a realistic radiograph: bones are bright, soft
 * tissue mid-grey, air dark, with cortical shells around the femora.
 */
import { type GrayImage, createGray } from './gray';
import type { Vec2 } from '../geometry/vec';

export interface PhantomFemur {
  /** Head centre (mm). */
  head: Vec2;
  headRadius: number;
  /** Lesser trochanter tip (mm). */
  lesserTrochanter: Vec2;
  /** Point where the shaft axis crosses the LT level (mm). */
  axisAtLT: Vec2;
  /** Unit vector of the shaft axis pointing distally. */
  axisDir: Vec2;
  /** Endosteal canal half-width as a function of depth below LT (mm). */
  canalHalfWidth: (d: number) => number;
  cortex: (d: number) => number;
}

export interface Phantom {
  image: GrayImage;
  mmPerPx: number;
  markerCenter: Vec2;
  markerDiameterMm: number;
  teardrops: { R: Vec2; L: Vec2 };
  femora: { R: PhantomFemur; L: PhantomFemur };
}

function makeFemur(side: 'R' | 'L', teardrop: Vec2, ltDrop: number, headRadius: number): PhantomFemur {
  // Patient right is on the viewer's left: lateral = -x for R, +x for L.
  const lat = side === 'R' ? -1 : 1;
  const head = { x: teardrop.x + lat * 32, y: teardrop.y - 18 };
  // Shaft is adducted ~7° (distal end toward the midline).
  const a = (7 * Math.PI) / 180;
  const axisDir = { x: -lat * Math.sin(a), y: Math.cos(a) };
  const ltY = teardrop.y + ltDrop;
  // Axis passes 32 mm lateral of the head centre at LT level (~41 mm femoral offset with 7° adduction).
  const axisAtLT = { x: head.x + lat * 32, y: ltY };
  const lesserTrochanter = { x: axisAtLT.x - lat * 22, y: ltY };
  const canalHalfWidth = (d: number): number => {
    // Wide metaphysis tapering to a 12 mm isthmus ~110 mm below the LT.
    // Metaphysis flares proximally towards the neck and trochanters.
    if (d < -10) return 16 + Math.min(35, -10 - d) * 0.45;
    const t = Math.min(1, Math.max(0, (d + 10) / 120));
    return 16 - 10 * Math.sqrt(t);
  };
  const cortex = (d: number): number => 3 + 4 * Math.min(1, Math.max(0, (d + 10) / 110));
  return { head, headRadius, lesserTrochanter, axisAtLT, axisDir, canalHalfWidth, cortex };
}

export function generatePhantom(opts: { mmPerPx?: number; noise?: number; lldMm?: number } = {}): Phantom {
  const mmPerPx = opts.mmPerPx ?? 0.3;
  const noise = opts.noise ?? 4;
  const lld = opts.lldMm ?? 6;
  const widthMm = 400;
  const heightMm = 330;
  const W = Math.round(widthMm / mmPerPx);
  const H = Math.round(heightMm / mmPerPx);
  const img = createGray(W, H);

  const teardrops = { R: { x: 155, y: 140 }, L: { x: 245, y: 140 } };
  // The left hip is the arthritic/short side by `lld` mm.
  const femora = {
    R: makeFemur('R', teardrops.R, 42, 24),
    L: makeFemur('L', teardrops.L, 42 - lld, 24.5),
  };
  // Shift the whole left femur proximally with its LT.
  femora.L.head.y -= lld;

  const markerCenter = { x: 200, y: 290 };
  const markerDiameterMm = 25;

  let seed = 987654321;
  const rand = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296 - 0.5;
  };

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = px * mmPerPx;
      const y = py * mmPerPx;
      let v = 30; // air
      // Soft-tissue envelope (ellipse).
      const ex = (x - 200) / 190;
      const ey = (y - 170) / 210;
      if (ex * ex + ey * ey < 1) v = 70;

      // Pelvis: iliac wings + pubic rami, schematic.
      v = Math.max(v, pelvisIntensity(x, y));

      for (const side of ['R', 'L'] as const) {
        v = Math.max(v, femurIntensity(femora[side], side, x, y));
      }
      // Calibration marker (metal: brightest).
      const dm = Math.hypot(x - markerCenter.x, y - markerCenter.y);
      if (dm < markerDiameterMm / 2) v = 245;

      img.data[py * W + px] = Math.min(255, Math.max(0, v + rand() * noise * 2));
    }
  }
  return { image: img, mmPerPx, markerCenter, markerDiameterMm, teardrops, femora };
}

function pelvisIntensity(x: number, y: number): number {
  let v = 0;
  // Iliac wings.
  for (const cx of [130, 270]) {
    const dx = (x - cx) / 70;
    const dy = (y - 75) / 60;
    if (dx * dx + dy * dy < 1) v = Math.max(v, 140);
  }
  // Sacrum.
  {
    const dx = (x - 200) / 38;
    const dy = (y - 85) / 55;
    if (dx * dx + dy * dy < 1) v = Math.max(v, 125);
  }
  // Acetabular region / ischium blocks around each teardrop.
  for (const cx of [150, 250]) {
    const dx = (x - cx) / 38;
    const dy = (y - 150) / 45;
    if (dx * dx + dy * dy < 1) v = Math.max(v, 135);
    // Obturator foramen (dark hole).
    const ox = (x - (cx + (cx < 200 ? 18 : -18))) / 16;
    const oy = (y - 172) / 20;
    if (ox * ox + oy * oy < 1) v = 75;
  }
  // Teardrop: a brighter U-shaped line at each medial acetabular wall.
  for (const cx of [155, 245]) {
    const r = Math.hypot(x - cx, y - 135);
    if (Math.abs(r - 5) < 1.2 && y > 133) v = Math.max(v, 185);
  }
  // Pubic symphysis bridge.
  if (Math.abs(x - 200) < 50 && y > 168 && y < 182) v = Math.max(v, 130);
  return v;
}

function femurIntensity(f: PhantomFemur, side: 'R' | 'L', x: number, y: number): number {
  const lat = side === 'R' ? -1 : 1;
  let v = 0;
  // Head: dense sphere (brighter centrally because of thickness).
  const dh = Math.hypot(x - f.head.x, y - f.head.y);
  if (dh < f.headRadius) v = Math.max(v, 165 + 25 * Math.sqrt(1 - (dh / f.headRadius) ** 2));
  // Joint space ring is implicit (soft tissue/acetabulum around the head).

  // Shaft coordinates: s = across (positive lateral), d = depth below LT.
  const rx = x - f.axisAtLT.x;
  const ry = y - f.axisAtLT.y;
  const d = rx * f.axisDir.x + ry * f.axisDir.y;
  const s = (rx * f.axisDir.y - ry * f.axisDir.x) * -lat; // positive = lateral
  if (d > -45 && d < 230) {
    const half = f.canalHalfWidth(d);
    const outer = half + f.cortex(d);
    const as = Math.abs(s);
    if (as < half) v = Math.max(v, 115); // medullary canal (cancellous / marrow)
    else if (as < outer) v = Math.max(v, 200); // cortex
  }
  // Neck: a band from the head to the proximal shaft.
  const nx0 = f.head.x;
  const ny0 = f.head.y;
  const nx1 = f.axisAtLT.x - f.axisDir.x * 25;
  const ny1 = f.axisAtLT.y - f.axisDir.y * 25;
  const ndx = nx1 - nx0;
  const ndy = ny1 - ny0;
  const nl = Math.hypot(ndx, ndy);
  const t = ((x - nx0) * ndx + (y - ny0) * ndy) / (nl * nl);
  if (t > 0 && t < 1) {
    const px = nx0 + ndx * t;
    const py = ny0 + ndy * t;
    if (Math.hypot(x - px, y - py) < 15) v = Math.max(v, 150);
  }
  // Greater trochanter.
  const gx = f.axisAtLT.x + lat * 14;
  const gy = f.axisAtLT.y - 45;
  if (((x - gx) / 14) ** 2 + ((y - gy) / 22) ** 2 < 1) v = Math.max(v, 150);
  // Lesser trochanter: small bump medially at LT level.
  const lt = f.lesserTrochanter;
  if (Math.hypot(x - (lt.x + lat * 6), y - lt.y) < 7) v = Math.max(v, 160);
  return v;
}
