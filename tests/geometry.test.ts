import { describe, it, expect } from 'vitest';
import { fitCircle, fitCircleRansac, circleFrom3, fitLine, fitLineRobust } from '../src/geometry/fit';
import { toFrame, fromFrame, signedDistanceToLine } from '../src/geometry/vec';

describe('circle fitting', () => {
  it('fits three points exactly', () => {
    const c = circleFrom3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 })!;
    expect(c.center.x).toBeCloseTo(0);
    expect(c.center.y).toBeCloseTo(0);
    expect(c.radius).toBeCloseTo(10);
  });

  it('least-squares fits a noisy arc', () => {
    const pts = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * Math.PI; // half circle only
      const r = 25 + (i % 2 ? 0.2 : -0.2);
      return { x: 100 + r * Math.cos(a), y: 50 + r * Math.sin(a) };
    });
    const c = fitCircle(pts)!;
    expect(c.center.x).toBeCloseTo(100, 0);
    expect(c.center.y).toBeCloseTo(50, 0);
    expect(c.radius).toBeCloseTo(25, 0);
  });

  it('RANSAC ignores outliers', () => {
    const pts = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * 2 * Math.PI;
      return { x: 30 * Math.cos(a), y: 30 * Math.sin(a) };
    });
    for (let i = 0; i < 20; i++) pts.push({ x: 5 + i, y: -3 + (i % 5) });
    const fit = fitCircleRansac(pts, 1)!;
    expect(fit.circle.radius).toBeCloseTo(30, 1);
    expect(fit.inliers.length).toBeGreaterThanOrEqual(60);
  });
});

describe('line fitting', () => {
  it('fits a vertical line', () => {
    const l = fitLine([{ x: 5, y: 0 }, { x: 5, y: 10 }, { x: 5, y: 20 }])!;
    expect(Math.abs(l.dir.y)).toBeCloseTo(1);
    expect(l.point.x).toBeCloseTo(5);
  });

  it('robust fit rejects an outlier', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 0.1 + (i % 2 ? 0.05 : -0.05), y: i }));
    pts.push({ x: 30, y: 10 });
    const l = fitLineRobust(pts)!;
    expect(Math.abs(signedDistanceToLine({ x: 1, y: 10 }, l.point, l.dir))).toBeLessThan(0.2);
  });
});

describe('frames', () => {
  it('round-trips points', () => {
    const f = { origin: { x: 3, y: 4 }, uAxis: { x: 0.6, y: 0.8 }, vAxis: { x: -0.8, y: 0.6 } };
    const p = { x: 12, y: -7 };
    const q = fromFrame(f, toFrame(f, p));
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
  });
});
