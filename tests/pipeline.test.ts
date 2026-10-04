import { describe, it, expect, beforeAll } from 'vitest';
import { generatePhantom, type Phantom } from '../src/imaging/synthetic';
import { detectFemoralHead, detectCanal } from '../src/imaging/detect';
import { emptyCase, type CaseData } from '../src/planning/types';
import { buildPlan, engagementDepth, stemHeadCenter } from '../src/planning/plan';
import { measure } from '../src/planning/measure';
import { DEFAULT_LIBRARY } from '../src/planning/implants';
import { add, scale, signedDistanceToLine } from '../src/geometry/vec';

let ph: Phantom;
const px = (p: { x: number; y: number }) => scale(p, 1 / ph.mmPerPx);

function buildCase(): CaseData {
  const c = emptyCase();
  c.operativeSide = 'L';
  c.calibration = { method: 'manual', mmPerPx: ph.mmPerPx };
  for (const side of ['R', 'L'] as const) {
    const f = ph.femora[side];
    const l = c.landmarks[side];
    l.teardrop = px(ph.teardrops[side]);
    l.lesserTrochanter = px(f.lesserTrochanter);
    const head = detectFemoralHead(ph.image, px(add(f.head, { x: 2, y: -1.5 })), 18 / ph.mmPerPx, 32 / ph.mmPerPx);
    if (!head) throw new Error('head not found');
    l.head = head.circle;
    const prox = px(add(f.axisAtLT, scale(f.axisDir, 0)));
    const dist = px(add(f.axisAtLT, scale(f.axisDir, 170)));
    const canal = detectCanal(ph.image, prox, dist, {
      stepPx: 3 / ph.mmPerPx,
      halfWidthPx: 30 / ph.mmPerPx,
      minCanalPx: 6 / ph.mmPerPx,
    });
    if (!canal) throw new Error('canal not found');
    l.canalSeeds = [prox, dist];
    l.canal = canal;
  }
  return c;
}

beforeAll(() => {
  ph = generatePhantom({ mmPerPx: 0.4, noise: 3, lldMm: 6 });
});

describe('detection on phantom', () => {
  it('finds the femoral head within 1 mm', () => {
    const f = ph.femora.L;
    const det = detectFemoralHead(ph.image, px(add(f.head, { x: 3, y: 2 })), 18 / ph.mmPerPx, 32 / ph.mmPerPx)!;
    expect(det).not.toBeNull();
    const c = scale(det.circle.center, ph.mmPerPx);
    expect(Math.hypot(c.x - f.head.x, c.y - f.head.y)).toBeLessThan(1);
    expect(det.circle.radius * ph.mmPerPx).toBeCloseTo(f.headRadius, 0);
  });

  it('finds the marker ball and calibrates scale', () => {
    const det = detectFemoralHead(ph.image, px(add(ph.markerCenter, { x: 1, y: 1 })), 8 / ph.mmPerPx, 20 / ph.mmPerPx)!;
    const mmPerPx = ph.markerDiameterMm / (2 * det.circle.radius);
    expect(mmPerPx).toBeCloseTo(ph.mmPerPx, 2);
  });

  it('detects canal width and axis', () => {
    const f = ph.femora.R;
    const prox = px(f.axisAtLT);
    const dist = px(add(f.axisAtLT, scale(f.axisDir, 170)));
    const canal = detectCanal(ph.image, prox, dist, { stepPx: 3 / ph.mmPerPx, halfWidthPx: 30 / ph.mmPerPx, minCanalPx: 6 / ph.mmPerPx })!;
    expect(canal).not.toBeNull();
    // Axis passes through the true axis at LT level.
    const off = signedDistanceToLine(prox, canal.axis.point, canal.axis.dir) * ph.mmPerPx;
    expect(Math.abs(off)).toBeLessThan(1);
    const iso = canal.isthmus!.canalWidth * ph.mmPerPx;
    expect(iso).toBeGreaterThan(11);
    expect(iso).toBeLessThan(14);
  });
});

describe('measurements and plan', () => {
  it('measures LLD and offsets', () => {
    const c = buildCase();
    const m = measure(c)!;
    expect(m.legLengthDifference).toBeCloseTo(-6, 0);
    expect(Math.abs(m.obliquity)).toBeLessThan(0.5);
    expect(m.op.headDiameter!).toBeCloseTo(49, 0);
    expect(m.op.femoralOffset!).toBeGreaterThan(35);
    expect(m.op.femoralOffset!).toBeLessThan(48);
    expect(m.warnings).toEqual([]);
  });

  it('produces a plan that restores leg length and offset', () => {
    const c = buildCase();
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.missing).toEqual([]);
    expect(plan.cup!.size.outerDiameter).toBeGreaterThanOrEqual(52);
    expect(plan.cup!.size.outerDiameter).toBeLessThanOrEqual(56);
    expect(plan.stem).toBeDefined();
    expect(plan.targetLegLengthChange).toBeCloseTo(6, 0);
    expect(Math.abs(plan.predictedLegLengthChange! - plan.targetLegLengthChange)).toBeLessThan(3);
    expect(Math.abs(plan.predictedOffsetChange! - plan.targetOffsetChange)).toBeLessThan(6);
    expect(plan.stem!.resectionAboveLT).toBeGreaterThan(3);
    expect(plan.stem!.resectionAboveLT).toBeLessThan(25);
    for (const f of plan.stem!.fill) expect(f.fill).toBeLessThanOrEqual(1.05);
  });

  it('honours overrides', () => {
    const c = buildCase();
    c.options.stemSizeOverride = '5';
    c.options.offsetOverride = 'high';
    c.options.headLengthOverride = 0;
    c.options.cupSizeOverride = 60;
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.stem!.chosen.size.size).toBe('5');
    expect(plan.stem!.chosen.offset.id).toBe('high');
    expect(plan.cup!.size.outerDiameter).toBe(60);
  });
});

describe('stem mechanics', () => {
  it('bigger stems seat higher in a tapering canal', () => {
    const profile = Array.from({ length: 60 }, (_, i) => {
      const d = -20 + i * 4;
      const half = 16 - 9 * Math.min(1, Math.max(0, (d + 10) / 150));
      return { d, medial: half, lateral: half };
    });
    const sizes = DEFAULT_LIBRARY.stems[0].sizes;
    const d3 = engagementDepth(sizes[2], profile).depth;
    const d8 = engagementDepth(sizes[7], profile).depth;
    expect(d8).toBeLessThan(d3);
  });

  it('head length moves the head along the neck axis', () => {
    const off = DEFAULT_LIBRARY.stems[0].sizes[0].offsets[0];
    const a = stemHeadCenter(off, 0, 0);
    const b = stemHeadCenter(off, 7, 0);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(7);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeLessThan(a.y);
  });
});
