import { type Vec2, norm, sub, dist } from './vec';

export interface Circle {
  center: Vec2;
  radius: number;
}

export interface Line {
  /** A point on the line (the centroid of the fitted points). */
  point: Vec2;
  /** Unit direction. */
  dir: Vec2;
}

/** Circle through exactly three points. Returns null if collinear. */
export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): Circle | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
  return { center, radius: dist(center, a) };
}

/** Algebraic least-squares circle fit (Kåsa). Needs >= 3 non-collinear points. */
export function fitCircle(points: Vec2[]): Circle | null {
  const n = points.length;
  if (n < 3) return null;
  if (n === 3) return circleFrom3(points[0], points[1], points[2]);
  // Centre the data for numerical stability.
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const r1 = 0.5 * (suuu + suvv);
  const r2 = 0.5 * (svvv + svuu);
  const uc = (r1 * svv - r2 * suv) / det;
  const vc = (r2 * suu - r1 * suv) / det;
  const center = { x: uc + mx, y: vc + my };
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return { center, radius };
}

/** Deterministic pseudo-random generator so RANSAC results are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Robust circle fit: RANSAC over 3-point hypotheses followed by a least-squares
 * refit on the inliers. `tolerance` is the max radial residual for an inlier.
 */
export function fitCircleRansac(
  points: Vec2[],
  tolerance: number,
  iterations = 300,
): { circle: Circle; inliers: Vec2[] } | null {
  if (points.length < 3) return null;
  const rand = lcg(12345);
  let best: Vec2[] = [];
  for (let i = 0; i < iterations; i++) {
    const a = points[Math.floor(rand() * points.length)];
    const b = points[Math.floor(rand() * points.length)];
    const c = points[Math.floor(rand() * points.length)];
    const hyp = circleFrom3(a, b, c);
    if (!hyp) continue;
    const inliers = points.filter((p) => Math.abs(dist(p, hyp.center) - hyp.radius) <= tolerance);
    if (inliers.length > best.length) best = inliers;
  }
  if (best.length < 3) return null;
  const circle = fitCircle(best);
  if (!circle) return null;
  return { circle, inliers: best };
}

/** Total-least-squares line fit (principal axis of the point cloud). */
export function fitLine(points: Vec2[]): Line | null {
  const n = points.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: mx, y: my }, dir: norm({ x: Math.cos(theta), y: Math.sin(theta) }) };
}

/**
 * Robust line fit: least-median-of-squares over point pairs to get an
 * outlier-free starting line, then a least-squares refit on the points whose
 * residual is within k × the robust scale.
 */
export function fitLineRobust(points: Vec2[], k = 3): Line | null {
  const n = points.length;
  if (n < 2) return null;
  if (n < 4) return fitLine(points);
  const rand = lcg(4242);
  const residuals = (l: Line): number[] =>
    points.map((p) => {
      const d = sub(p, l.point);
      return Math.abs(d.x * l.dir.y - d.y * l.dir.x);
    });
  let best: Line | null = null;
  let bestMed = Infinity;
  const trials = Math.min(400, (n * (n - 1)) / 2);
  for (let t = 0; t < trials; t++) {
    const a = points[Math.floor(rand() * n)];
    const b = points[Math.floor(rand() * n)];
    if (dist(a, b) < 1e-9) continue;
    const l: Line = { point: a, dir: norm(sub(b, a)) };
    const med = median(residuals(l));
    if (med < bestMed) {
      bestMed = med;
      best = l;
    }
  }
  if (!best) return fitLine(points);
  // 1.4826 converts the median absolute residual to a Gaussian sigma.
  const limit = Math.max(k * 1.4826 * bestMed, 1e-6);
  const res = residuals(best);
  const kept = points.filter((_, i) => res[i] <= limit);
  return fitLine(kept.length >= 2 ? kept : points);
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
