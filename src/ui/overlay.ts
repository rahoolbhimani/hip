/**
 * Draws measurements and implant templates on top of the radiograph.
 * All drawing happens in IMAGE pixel space; `k` is the number of image px per
 * screen px so line widths and labels stay constant on screen.
 */
import { type Vec2, type Frame, fromFrame, scale, add, sub, norm, perp, rad } from '../geometry/vec';
import type { AppState } from '../app/store';
import { stemOutlineLocal, neckCutLocal, stemToFemur } from '../planning/plan';
import { neckHeadCenter } from '../planning/implants';
import { otherSide } from '../planning/types';

export interface Layers {
  measurements: boolean;
  canal: boolean;
  cup: boolean;
  stem: boolean;
}

const C = {
  landmark: '#ffd166',
  reference: '#4cc9f0',
  measure: '#90e0ef',
  canal: '#80ed99',
  cup: '#ff6b6b',
  stem: '#c77dff',
  cut: '#ffbe0b',
  pending: '#ffffff',
  head: '#f4a261',
  ghost: '#9ef01a',
  proposed: '#ffbe0b',
};

export function drawOverlay(ctx: CanvasRenderingContext2D, s: AppState, k: number, layers: Layers): void {
  const c = s.case;
  const mmPerPx = c.calibration?.mmPerPx;
  const toPx = (pMm: Vec2): Vec2 => scale(pMm, 1 / (mmPerPx ?? 1));

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Calibration
  const cal = c.calibration;
  if (cal?.marker) {
    circle(ctx, cal.marker.center, cal.marker.radius, '#ffffff', 1.5 * k, [4 * k, 3 * k]);
    label(ctx, add(cal.marker.center, { x: cal.marker.radius + 6 * k, y: 0 }), `${cal.markerDiameterMm} mm marker`, '#ffffff', k);
  }
  if (cal?.line) {
    line(ctx, cal.line[0], cal.line[1], '#ffffff', 1.5 * k);
    label(ctx, cal.line[1], `${cal.lineLengthMm} mm`, '#ffffff', k);
  }

  const m = s.measurements;
  const plan = s.plan;

  // Reference lines & leg length
  if (layers.measurements && m && mmPerPx) {
    const f = m.pelvis;
    const a = toPx(fromFrame(f, { x: -220, y: 0 }));
    const b = toPx(fromFrame(f, { x: 220, y: 0 }));
    line(ctx, a, b, C.reference, 1.2 * k, [8 * k, 5 * k]);
    for (const sm of [m.op, m.contra]) {
      const l = c.landmarks[sm.side];
      if (l.lesserTrochanter && sm.ltBelowLine !== undefined) {
        const top = toPx(fromFrame(f, { x: toFrameX(f, scale(l.lesserTrochanter, mmPerPx)), y: 0 }));
        line(ctx, top, l.lesserTrochanter, C.measure, 1 * k, [3 * k, 3 * k]);
        label(ctx, mid2(top, l.lesserTrochanter), `${sm.ltBelowLine.toFixed(1)} mm`, C.measure, k);
      }
      if (l.head && l.teardrop) {
        // Acetabular offset: horizontal teardrop → head centre (pelvic frame).
        const td = { x: toFrameX(f, scale(l.teardrop, mmPerPx)), y: toFrameY(f, scale(l.teardrop, mmPerPx)) };
        const hc = sm.headCenter!;
        line(ctx, toPx(fromFrame(f, { x: td.x, y: hc.y })), l.head.center, C.measure, 1 * k, [2 * k, 3 * k]);
        line(ctx, toPx(fromFrame(f, { x: td.x, y: td.y })), toPx(fromFrame(f, { x: td.x, y: hc.y + 10 })), C.measure, 1 * k, [2 * k, 3 * k]);
      }
    }
  }

  // Landmarks
  for (const side of ['R', 'L'] as const) {
    const l = c.landmarks[side];
    const isOp = side === c.operativeSide;
    const tag = side;
    if (l.teardrop) point(ctx, l.teardrop, C.landmark, k, `TD ${tag}`);
    if (l.lesserTrochanter) point(ctx, l.lesserTrochanter, C.landmark, k, `LT ${tag}`);
    if (l.greaterTrochanter) point(ctx, l.greaterTrochanter, C.landmark, k, `GT ${tag}`);
    if (l.acetabularEdge) point(ctx, l.acetabularEdge, C.landmark, k, `Edge ${tag}`);
    if (l.head) {
      circle(ctx, l.head.center, l.head.radius, C.head, (isOp ? 1.6 : 1.2) * k);
      cross(ctx, l.head.center, 6 * k, C.head, 1.2 * k);
      if (mmPerPx) label(ctx, add(l.head.center, { x: -l.head.radius, y: -l.head.radius - 6 * k }), `Ø ${(2 * l.head.radius * mmPerPx).toFixed(1)}`, C.head, k);
    }
    if (layers.canal && l.canal) {
      ctx.fillStyle = C.canal;
      for (const lev of l.canal.levels) {
        dot(ctx, lev.medialEndosteal, 1.6 * k);
        dot(ctx, lev.lateralEndosteal, 1.6 * k);
      }
      const ax = l.canal.axis;
      const first = l.canal.levels[0].center;
      const last = l.canal.levels[l.canal.levels.length - 1].center;
      const t0 = (first.x - ax.point.x) * ax.dir.x + (first.y - ax.point.y) * ax.dir.y - 80 / (mmPerPx ?? 0.15);
      const t1 = (last.x - ax.point.x) * ax.dir.x + (last.y - ax.point.y) * ax.dir.y;
      line(ctx, add(ax.point, scale(ax.dir, t0)), add(ax.point, scale(ax.dir, t1)), C.canal, 1 * k, [6 * k, 4 * k]);
    }
    if (l.canalSeeds) {
      for (const sd of l.canalSeeds) point(ctx, sd, C.canal, k);
    }
  }

  // Cup template
  if (layers.cup && plan?.cup && mmPerPx && m) {
    const f = m.pelvis;
    const cup = plan.cup;
    const center = toPx(fromFrame(f, cup.center));
    const r = cup.size.outerDiameter / 2 / mmPerPx;
    const rimA = toPx(fromFrame(f, cup.inferomedialRim));
    const rimB = toPx(fromFrame(f, cup.superolateralRim));
    const faceDir = norm(sub(rimB, rimA));
    // Dome lies on the superomedial side of the face line.
    const towardsDome = norm(sub(toPx(fromFrame(f, add(cup.center, { x: -Math.sin(rad(cup.inclination)), y: Math.cos(rad(cup.inclination)) }))), center));
    const start = Math.atan2(faceDir.y, faceDir.x);
    const ccwIsDome = isCcwDome(faceDir, towardsDome);
    ctx.save();
    ctx.strokeStyle = C.cup;
    ctx.lineWidth = 2 * k;
    ctx.fillStyle = 'rgba(255,107,107,0.12)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, start, start + Math.PI, ccwIsDome);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Liner / bearing
    circleArcSameSide(ctx, center, cup.bearingDiameter / 2 / mmPerPx, start, ccwIsDome, C.cup, 1 * k);
    ctx.restore();
    cross(ctx, center, 7 * k, C.cup, 1.5 * k);
    label(ctx, add(rimB, { x: 8 * k, y: 0 }), `Cup ${cup.size.outerDiameter} mm @ ${cup.inclination}°`, C.cup, k);
  }

  // Stem template
  if (layers.stem && plan?.stem && plan.femur && mmPerPx) {
    const fem = plan.femur;
    const ch = plan.stem.chosen;
    const toImg = (q: Vec2): Vec2 => toPx(fromFrame(fem, stemToFemur(ch.pose, q)));
    const outline = stemOutlineLocal(ch.size, ch.offset).map(toImg);
    ctx.save();
    ctx.strokeStyle = C.stem;
    ctx.fillStyle = 'rgba(199,125,255,0.16)';
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Stem axis
    const len = ch.size.profile[ch.size.profile.length - 1].d;
    line(ctx, toImg({ x: 0, y: -10 }), toImg({ x: 0, y: len + 8 }), C.stem, 0.8 * k, [5 * k, 4 * k]);
    // 0 mm head on the stem
    const hc = toImg(neckHeadCenter(ch.offset));
    const bearing = plan.cup?.bearingDiameter ?? 32;
    circle(ctx, hc, bearing / 2 / mmPerPx, C.stem, 1.5 * k);
    cross(ctx, hc, 6 * k, C.stem, 1.5 * k);
    // Neck cut
    const [cutA, cutB] = neckCutLocal(ch.size, ch.offset).map(toImg);
    line(ctx, cutA, cutB, C.cut, 2 * k, [6 * k, 4 * k]);
    label(ctx, add(cutA, { x: 8 * k, y: 14 * k }), `Cut ${plan.stem.resectionAboveLT.toFixed(0)} mm above LT`, C.cut, k);
    const tip = toImg({ x: 0, y: len });
    label(ctx, add(tip, { x: 10 * k, y: 0 }), `${ch.size.size} ${ch.offset.id === 'high' ? 'high offset' : 'standard'}${plan.stem.manual ? ' (manual)' : ''}`, C.stem, k);
    // Tilt handle marker at the tip
    ctx.save();
    ctx.fillStyle = C.stem;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 5 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Reduction: stem head → cup centre, and where the LT ends up.
    if (plan.cup && s.measurements && plan.reconstruction) {
      const pel = s.measurements.pelvis;
      const cupC = toPx(fromFrame(pel, plan.cup.center));
      line(ctx, hc, cupC, '#ffffff', 1.2 * k, [2 * k, 2 * k]);
      const lt = c.landmarks[c.operativeSide].lesserTrochanter;
      if (lt) {
        // Translate the LT by the reduction vector T = C − S (pelvic frame).
        const T = sub(plan.cup.center, plan.reconstruction.stemHead);
        const ltP = add(toFrameXY(pel, scale(lt, mmPerPx)), T);
        const ghost = toPx(fromFrame(pel, ltP));
        ctx.save();
        ctx.globalAlpha = 0.9;
        point(ctx, ghost, C.ghost, k, 'LT after');
        ctx.restore();
        line(ctx, lt, ghost, C.ghost, 1 * k, [2 * k, 3 * k]);
      }
    }
  }

  // Proposed (unconfirmed) points: amber dashed ring; the one under review gets a target.
  for (const side of ['R', 'L'] as const) {
    const l = c.landmarks[side];
    for (const [key, st] of Object.entries(l.status ?? {})) {
      if (st !== 'proposed') continue;
      const pts: Vec2[] =
        key === 'head' && l.head ? [l.head.center]
        : key === 'canal' && l.canalSeeds ? [...l.canalSeeds]
        : key === 'teardrop' && l.teardrop ? [l.teardrop]
        : key === 'lesserTrochanter' && l.lesserTrochanter ? [l.lesserTrochanter]
        : [];
      for (const p of pts) circle(ctx, p, 11 * k, C.proposed, 1.5 * k, [3 * k, 3 * k]);
    }
  }
  const cur = s.review ? s.review.items[s.review.index] : null;
  if (cur) {
    const l = cur.kind === 'landmark' ? c.landmarks[cur.side] : null;
    const p =
      cur.kind === 'marker' ? c.calibration?.marker?.center
      : cur.key === 'head' ? l?.head?.center
      : cur.key === 'canal' ? l?.canalSeeds?.[0]
      : cur.key === 'teardrop' ? l?.teardrop
      : cur.key === 'lesserTrochanter' ? l?.lesserTrochanter
      : undefined;
    if (p) {
      circle(ctx, p, 20 * k, C.proposed, 2.5 * k);
      line(ctx, { x: p.x - 34 * k, y: p.y }, { x: p.x - 22 * k, y: p.y }, C.proposed, 2 * k);
      line(ctx, { x: p.x + 22 * k, y: p.y }, { x: p.x + 34 * k, y: p.y }, C.proposed, 2 * k);
      line(ctx, { x: p.x, y: p.y - 34 * k }, { x: p.x, y: p.y - 22 * k }, C.proposed, 2 * k);
      line(ctx, { x: p.x, y: p.y + 22 * k }, { x: p.x, y: p.y + 34 * k }, C.proposed, 2 * k);
    }
  }

  // Pending clicks for multi-click tools
  for (const p of s.pendingClicks) point(ctx, p, C.pending, k);

  // Contralateral mirrored COR target (helps visual check of cup position)
  if (layers.cup && m && mmPerPx && m.contra.headCenter) {
    const mir = { x: -m.contra.headCenter.x, y: m.contra.headCenter.y };
    const p = toPx(fromFrame(m.pelvis, mir));
    ctx.save();
    ctx.globalAlpha = 0.8;
    cross(ctx, p, 5 * k, C.reference, 1 * k);
    label(ctx, add(p, { x: -40 * k, y: 18 * k }), `mirrored ${otherSide(c.operativeSide)} COR`, C.reference, k);
    ctx.restore();
  }
}


function toFrameX(f: Frame, p: Vec2): number {
  return (p.x - f.origin.x) * f.uAxis.x + (p.y - f.origin.y) * f.uAxis.y;
}
function toFrameXY(f: Frame, p: Vec2): Vec2 {
  return { x: toFrameX(f, p), y: toFrameY(f, p) };
}
function toFrameY(f: Frame, p: Vec2): number {
  return (p.x - f.origin.x) * f.vAxis.x + (p.y - f.origin.y) * f.vAxis.y;
}

function isCcwDome(faceDir: Vec2, towardsDome: Vec2): boolean {
  // Canvas arcs: clockwise (anticlockwise=false) sweeps from start towards
  // the direction perp(faceDir) in screen space (y down).
  const cwSide = perp(faceDir); // rotate +90° in y-down space = clockwise
  return cwSide.x * towardsDome.x + cwSide.y * towardsDome.y < 0;
}

function circleArcSameSide(ctx: CanvasRenderingContext2D, c: Vec2, r: number, start: number, ccw: boolean, color: string, w: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.setLineDash([3 * w, 3 * w]);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, start, start + Math.PI, ccw);
  ctx.stroke();
  ctx.restore();
}

function mid2(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function line(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, color: string, w: number, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

export function circle(ctx: CanvasRenderingContext2D, c: Vec2, r: number, color: string, w: number, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, c: Vec2, size: number, color: string, w: number): void {
  line(ctx, { x: c.x - size, y: c.y }, { x: c.x + size, y: c.y }, color, w);
  line(ctx, { x: c.x, y: c.y - size }, { x: c.x, y: c.y + size }, color, w);
}

function dot(ctx: CanvasRenderingContext2D, p: Vec2, r: number): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function point(ctx: CanvasRenderingContext2D, p: Vec2, color: string, k: number, text?: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  if (text) label(ctx, add(p, { x: 7 * k, y: -7 * k }), text, color, k);
}

function label(ctx: CanvasRenderingContext2D, p: Vec2, text: string, color: string, k: number): void {
  ctx.save();
  ctx.font = `${12 * k}px system-ui, sans-serif`;
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, p.x, p.y);
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
  ctx.restore();
}
