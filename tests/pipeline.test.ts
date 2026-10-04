import { describe, it, expect, beforeAll } from 'vitest';
import { generatePhantom, type Phantom } from '../src/imaging/synthetic';
import { detectFemoralHead, detectCanal } from '../src/imaging/detect';
import { emptyCase, type CaseData } from '../src/planning/types';
import { buildPlan, engagementDepth, stemOutlineLocal, stemToFemur } from '../src/planning/plan';
import { measure } from '../src/planning/measure';
import { DEFAULT_LIBRARY, neckHeadCenter, stemWidthAt, stemLength, parseStemTable } from '../src/planning/implants';
import { add, scale, signedDistanceToLine, fromFrame } from '../src/geometry/vec';

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
    c.options.stemAlignment = 'canal';
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
      const half = 16 - 10 * Math.min(1, Math.max(0, (d + 10) / 150));
      return { d, medial: half, lateral: half };
    });
    const sizes = DEFAULT_LIBRARY.stems[0].sizes;
    const d3 = engagementDepth(sizes[2], profile).depth;
    const d8 = engagementDepth(sizes[7], profile).depth;
    expect(d8).toBeLessThan(d3);
  });

  it('CATALYSTEM template matches its dimension table', () => {
    const fam = DEFAULT_LIBRARY.stems[0];
    expect(fam.sizes).toHaveLength(13);
    const s7 = fam.sizes.find((z) => z.size === '7')!;
    // Body: length 107, ML 32 at resection, 12 distal (0.8 × length).
    expect(stemLength(s7)).toBe(107);
    const prox = stemWidthAt(s7, 0)!;
    expect(prox.medial + prox.lateral).toBeCloseTo(32, 5);
    const dist = stemWidthAt(s7, 0.8 * 107)!;
    expect(dist.medial + dist.lateral).toBeCloseTo(12, 0);
    // Necks (0 head): std offset 38 / leg length 30, high offset 46 / 30.
    const std = s7.offsets.find((o) => o.id === 'std')!;
    const high = s7.offsets.find((o) => o.id === 'high')!;
    expect(neckHeadCenter(std)).toEqual({ x: 38, y: -30 });
    expect(neckHeadCenter(high)).toEqual({ x: 46, y: -30 });
    expect(std.neckShaftAngle).toBe(131);
    // Outline is a closed polygon reaching the tip and the neck.
    const poly = stemOutlineLocal(s7, std);
    expect(Math.max(...poly.map((p) => p.y))).toBeCloseTo(107, 0);
    expect(Math.min(...poly.map((p) => p.y))).toBeLessThan(-20);
  });

  it('parses a pasted table with or without high-offset columns', () => {
    const specs = parseStemTable('size\tlength\n1\t95\t25\t8\t32\t28\t26\t38\t32\t26\n2,97,26,8,33,29,27');
    expect(specs).toHaveLength(2);
    expect(specs[0].necks.map((n) => n.id)).toEqual(['std', 'high']);
    expect(specs[1].necks.map((n) => n.id)).toEqual(['std']);
    expect(() => parseStemTable('1\t95\t25')).toThrow(/columns/);
  });
});

describe('stem seating stays anatomical', () => {
  const headCutLimit = (plan: NonNullable<ReturnType<typeof buildPlan>>) => {
    const m = plan.measurements.op;
    // Head centre height above the LT along the pelvic vertical, minus the head radius.
    return m.ltBelowLine! + m.corHeight! - m.headDiameter! / 2;
  };

  it('a single falsely narrow canal level does not push the stem up', () => {
    const c = buildCase();
    const base = buildPlan(c, DEFAULT_LIBRARY)!;
    const canal = c.landmarks.L.canal!;
    // Collapse one level 30 mm below the LT to a 4 mm canal.
    const i = canal.levels.findIndex((l) => l.t * ph.mmPerPx > 30);
    const lev = canal.levels[i];
    const mid = scale(add(lev.medialEndosteal, lev.lateralEndosteal), 0.5);
    const half = 2 / ph.mmPerPx;
    const dir = scale(add(lev.lateralEndosteal, scale(lev.medialEndosteal, -1)), 1 / lev.canalWidth);
    lev.lateralEndosteal = add(mid, scale(dir, half));
    lev.medialEndosteal = add(mid, scale(dir, -half));
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.stem!.chosen.size.size).toBe(base.stem!.chosen.size.size);
    expect(Math.abs(plan.stem!.resectionAboveLT - base.stem!.resectionAboveLT)).toBeLessThan(2);
  });

  it('never places the neck cut above the femoral head, even when the canal looks too narrow', () => {
    const c = buildCase();
    for (const lev of c.landmarks.L.canal!.levels) {
      const mid = scale(add(lev.medialEndosteal, lev.lateralEndosteal), 0.5);
      lev.medialEndosteal = add(mid, scale(add(lev.medialEndosteal, scale(mid, -1)), 0.3));
      lev.lateralEndosteal = add(mid, scale(add(lev.lateralEndosteal, scale(mid, -1)), 0.3));
    }
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.stem!.resectionAboveLT).toBeLessThanOrEqual(headCutLimit(plan) + 1);
    expect(plan.stem!.resectionAboveLT).toBeLessThanOrEqual(30);
    expect(plan.warnings.some((w) => w.includes('canal is probably too narrow'))).toBe(true);
  });

  it('keeps the neck cut between the LT and the head for every automatic plan', () => {
    for (const lld of [0, 6, 12]) {
      ph = generatePhantom({ mmPerPx: 0.4, noise: 3, lldMm: lld });
      const plan = buildPlan(buildCase(), DEFAULT_LIBRARY)!;
      expect(plan.stem!.resectionAboveLT).toBeGreaterThanOrEqual(0);
      expect(plan.stem!.resectionAboveLT).toBeLessThanOrEqual(headCutLimit(plan));
    }
    ph = generatePhantom({ mmPerPx: 0.4, noise: 3, lldMm: 6 });
  });
});

describe('goals and manual placement', () => {
  it('honours a "change by" leg-length goal', () => {
    const c = buildCase();
    c.options.legLengthGoal = { mode: 'change', mm: 0 };
    c.options.offsetGoal = { mode: 'change', mm: 0 };
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.targetLegLengthChange).toBe(0);
    expect(Math.abs(plan.predictedLegLengthChange!)).toBeLessThan(3);
  });

  it('equal-leg-length goal plus extra', () => {
    const c = buildCase();
    c.options.legLengthGoal = { mode: 'match', mm: 2 };
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.targetLegLengthChange).toBeCloseTo(8, 0);
  });

  it('leg length and offset follow the dragged stem exactly', () => {
    const c = buildCase();
    const auto = buildPlan(c, DEFAULT_LIBRARY)!;
    const ch = auto.stem!.chosen;
    c.options.stemSizeOverride = ch.size.size;
    c.options.offsetOverride = ch.offset.id;
    c.options.stemPose = { ...ch.pose, depth: ch.pose.depth + 5 };
    const sunk = buildPlan(c, DEFAULT_LIBRARY)!;
    // Seating 5 mm deeper along a ~7° adducted axis shortens by ~5·cos7°.
    expect(auto.predictedLegLengthChange! - sunk.predictedLegLengthChange!).toBeCloseTo(5 * Math.cos((7 * Math.PI) / 180), 1);
    expect(sunk.stem!.manual).toBe(true);
    // Components add up.
    const r = sunk.reconstruction!;
    expect(r.acetabular.ll + r.femoral.ll).toBeCloseTo(r.total.ll, 6);
    expect(r.acetabular.off + r.femoral.off).toBeCloseTo(r.total.off, 6);
  });

  it('a dragged cup moves the COR and changes leg length one-for-one', () => {
    const c = buildCase();
    const auto = buildPlan(c, DEFAULT_LIBRARY)!;
    c.options.cupCenter = { x: auto.cup!.center.x, y: auto.cup!.center.y + 4 };
    const raised = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(raised.reconstruction!.acetabular.ll).toBeCloseTo(auto.reconstruction!.acetabular.ll - 4, 6);
  });
});

describe('template alignment', () => {
  it('auto stem is upright to the inter-teardrop line by default', () => {
    const c = buildCase();
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    const ch = plan.stem!.chosen;
    // Stem axis direction in image mm vs the pelvic vertical.
    const fem = plan.femur!;
    const top = fromFrame(fem, stemToFemur(ch.pose, { x: 0, y: 0 }));
    const tip = fromFrame(fem, stemToFemur(ch.pose, { x: 0, y: 100 }));
    const along = { x: tip.x - top.x, y: tip.y - top.y };
    const u = plan.measurements.pelvis.uAxis;
    expect(Math.abs(along.x * u.x + along.y * u.y) / Math.hypot(along.x, along.y)).toBeLessThan(0.01);
    // The phantom shaft is adducted 7°, so the template is tilted ~7° relative to the canal.
    expect(Math.abs(plan.autoStemTilt!)).toBeCloseTo(7, 0);
  });

  it('canal alignment keeps the stem on the femoral axis', () => {
    const c = buildCase();
    c.options.stemAlignment = 'canal';
    const plan = buildPlan(c, DEFAULT_LIBRARY)!;
    expect(plan.stem!.chosen.pose.tilt).toBe(0);
  });
});
