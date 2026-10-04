/** Minimal 2D vector toolkit. All functions are pure and allocate new objects. */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotate(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export const deg = (radians: number): number => (radians * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Signed perpendicular distance from point p to the infinite line through a with direction dir. */
export function signedDistanceToLine(p: Vec2, a: Vec2, dir: Vec2): number {
  const d = norm(dir);
  return cross(d, sub(p, a));
}

/** Orthogonal projection of p onto the line through a with direction dir. */
export function projectOntoLine(p: Vec2, a: Vec2, dir: Vec2): Vec2 {
  const d = norm(dir);
  return add(a, scale(d, dot(sub(p, a), d)));
}

/** Intersection of two infinite lines (point + direction). Returns null for parallel lines. */
export function intersectLines(a: Vec2, da: Vec2, b: Vec2, db: Vec2): Vec2 | null {
  const denom = cross(da, db);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(b, a), db) / denom;
  return add(a, scale(da, t));
}

/**
 * A right-handed-on-screen orthonormal frame. Points are expressed as
 * (u, v) coordinates: u along `uAxis`, v along `vAxis`, relative to `origin`.
 */
export interface Frame {
  origin: Vec2;
  uAxis: Vec2;
  vAxis: Vec2;
}

export function toFrame(f: Frame, p: Vec2): Vec2 {
  const d = sub(p, f.origin);
  return { x: dot(d, f.uAxis), y: dot(d, f.vAxis) };
}

export function fromFrame(f: Frame, q: Vec2): Vec2 {
  return add(f.origin, add(scale(f.uAxis, q.x), scale(f.vAxis, q.y)));
}
