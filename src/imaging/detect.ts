/**
 * Classical (model-free) image analysis used to automate the measurements
 * that would otherwise require tedious manual tracing:
 *
 *  - femoral head: radial edge search from a seed + robust circle fit
 *  - femoral canal: endosteal/periosteal edge detection on profiles taken
 *    perpendicular to the shaft, then a robust fit of the anatomical axis
 *
 * All distances here are in pixels; callers convert using the calibration.
 */
import { type GrayImage, sample, smooth1d, derivative } from './gray';
import { type Vec2, add, scale, sub, norm, perp, dot, dist } from '../geometry/vec';
import { type Circle, type Line, fitCircleRansac, fitLineRobust, median } from '../geometry/fit';

export interface HeadDetection {
  circle: Circle;
  edgePoints: Vec2[];
  /** Fraction of rays that produced an inlier edge (0..1). */
  confidence: number;
}

/**
 * Detect the femoral head contour around a seed point placed roughly at its
 * centre. Rays are cast outward; on each ray we take the strongest
 * bright-to-dark transition (dense head → joint space) inside the allowed
 * radius band, then fit a circle with RANSAC.
 */
export function detectFemoralHead(
  img: GrayImage,
  seed: Vec2,
  minRadiusPx: number,
  maxRadiusPx: number,
  rays = 72,
): HeadDetection | null {
  const candidates: Vec2[] = [];
  const sigma = Math.max(1, minRadiusPx * 0.04);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const profile: number[] = [];
    for (let r = 0; r <= maxRadiusPx * 1.1; r += 1) {
      profile.push(sample(img, seed.x + dir.x * r, seed.y + dir.y * r));
    }
    const d = derivative(smooth1d(profile, sigma));
    let bestR = -1;
    let bestVal = 0;
    for (let r = Math.floor(minRadiusPx); r <= Math.min(maxRadiusPx, d.length - 2); r++) {
      // Head is denser (brighter) than the joint space: negative gradient going out.
      const v = -d[r];
      if (v > bestVal) {
        bestVal = v;
        bestR = r;
      }
    }
    if (bestR > 0) candidates.push(add(seed, scale(dir, bestR)));
  }
  const fit = fitCircleRansac(candidates, Math.max(1.5, minRadiusPx * 0.05));
  if (!fit) return null;
  const { circle, inliers } = fit;
  if (circle.radius < minRadiusPx * 0.8 || circle.radius > maxRadiusPx * 1.2) return null;
  return { circle, edgePoints: inliers, confidence: inliers.length / rays };
}

export interface CanalLevel {
  /** Point on the seed axis at which the profile was taken. */
  center: Vec2;
  /** Distance along the shaft from the proximal seed (px). */
  t: number;
  medialEndosteal: Vec2;
  lateralEndosteal: Vec2;
  medialPeriosteal?: Vec2;
  lateralPeriosteal?: Vec2;
  /** Endosteal (inner) canal width in px. */
  canalWidth: number;
  /** Outer cortical width in px, when both periosteal edges were found. */
  outerWidth?: number;
}

export interface CanalDetection {
  levels: CanalLevel[];
  /** Fitted anatomical axis through the canal midpoints, directed distally. */
  axis: Line;
  /** Narrowest canal level (isthmus). */
  isthmus: CanalLevel | null;
}

/**
 * Detect the femoral canal between two seed points placed inside the
 * medullary canal (proximal and distal). Profiles are sampled perpendicular to
 * the seed axis; the endosteal border is the strongest dark→bright rise
 * walking outward from the centre, the periosteal border the strongest
 * bright→dark fall beyond it.
 */
export function detectCanal(
  img: GrayImage,
  proximal: Vec2,
  distal: Vec2,
  opts: { stepPx: number; halfWidthPx: number; minCanalPx: number },
): CanalDetection | null {
  const axisDir = norm(sub(distal, proximal));
  const across = perp(axisDir);
  const length = dist(proximal, distal);
  const levels: CanalLevel[] = [];
  const sigma = Math.max(1, opts.halfWidthPx * 0.02);

  for (let t = 0; t <= length + 1e-6; t += opts.stepPx) {
    const c = add(proximal, scale(axisDir, t));
    const half = Math.round(opts.halfWidthPx);
    const plus: number[] = [];
    const minus: number[] = [];
    for (let s = 0; s <= half; s++) {
      plus.push(avgAcross(img, c, across, axisDir, s));
      minus.push(avgAcross(img, c, across, axisDir, -s));
    }
    const ep = findEdges(smooth1d(plus, sigma), opts.minCanalPx / 2);
    const em = findEdges(smooth1d(minus, sigma), opts.minCanalPx / 2);
    if (!ep || !em) continue;
    const a = add(c, scale(across, ep.endo));
    const b = add(c, scale(across, -em.endo));
    const level: CanalLevel = {
      center: c,
      t,
      // Assign medial/lateral later once we know the side; store as +/- for now.
      medialEndosteal: b,
      lateralEndosteal: a,
      canalWidth: ep.endo + em.endo,
    };
    if (ep.peri !== undefined && em.peri !== undefined) {
      level.lateralPeriosteal = add(c, scale(across, ep.peri));
      level.medialPeriosteal = add(c, scale(across, -em.peri));
      level.outerWidth = ep.peri + em.peri;
    }
    levels.push(level);
  }
  if (levels.length < 3) return null;

  // Reject levels whose width is wildly off the local median (overlapping
  // structures, lesser trochanter, etc.).
  const widths = levels.map((l) => l.canalWidth);
  const med = median(widths);
  const kept = levels.filter((l) => l.canalWidth > med * 0.4 && l.canalWidth < med * 2.5);
  const mids = kept.map((l) => scale(add(l.medialEndosteal, l.lateralEndosteal), 0.5));
  let axis = fitLineRobust(mids);
  if (!axis) return null;
  if (dot(axis.dir, axisDir) < 0) axis = { point: axis.point, dir: scale(axis.dir, -1) };

  // Isthmus: narrowest canal in the distal two thirds, using a small running median.
  let isthmus: CanalLevel | null = null;
  const startIdx = Math.floor(kept.length / 3);
  for (let i = startIdx; i < kept.length; i++) {
    const win = kept.slice(Math.max(0, i - 1), i + 2).map((l) => l.canalWidth);
    const w = median(win);
    if (!isthmus || w < isthmus.canalWidth) isthmus = { ...kept[i], canalWidth: w };
  }
  return { levels: kept, axis, isthmus };
}

function avgAcross(img: GrayImage, c: Vec2, across: Vec2, along: Vec2, s: number): number {
  // Average a short segment along the shaft to suppress noise.
  let acc = 0;
  let n = 0;
  for (let k = -2; k <= 2; k++) {
    const p = add(add(c, scale(across, s)), scale(along, k));
    const v = sample(img, p.x, p.y);
    if (!Number.isNaN(v)) {
      acc += v;
      n++;
    }
  }
  return n ? acc / n : NaN;
}

function findEdges(profile: number[], minEndo: number): { endo: number; peri?: number } | null {
  const d = derivative(profile);
  let last = d.length - 1;
  for (let i = 0; i < d.length; i++) {
    if (Number.isNaN(profile[i])) {
      last = i - 1;
      break;
    }
  }
  const start = Math.max(1, Math.floor(minEndo));
  let max = 0;
  for (let i = start; i < last; i++) max = Math.max(max, d[i]);
  if (max <= 0) return null;
  // Endosteal edge: the first strong dark→bright rise walking outward. Taking
  // the first (rather than the global) maximum avoids jumping to a neighbouring
  // bone or the skin line.
  let endo = -1;
  for (let i = start; i < last; i++) {
    if (d[i] >= 0.5 * max && d[i] >= d[i - 1] && d[i] >= d[i + 1]) {
      endo = i;
      break;
    }
  }
  if (endo < 0) return null;
  const rise = d[endo];
  // Periosteal edge: the first strong bright→dark fall beyond the cortex.
  let minFall = 0;
  for (let i = endo + 2; i < last; i++) minFall = Math.min(minFall, d[i]);
  let peri: number | undefined;
  if (-minFall >= rise * 0.25) {
    for (let i = endo + 2; i < last; i++) {
      if (-d[i] >= 0.5 * -minFall && d[i] <= d[i - 1] && d[i] <= d[i + 1]) {
        peri = i;
        break;
      }
    }
  }
  return { endo, peri };
}
