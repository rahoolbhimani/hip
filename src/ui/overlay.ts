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

/** Colours follow the common templating convention: blue cup, green stem, red measurements, cyan landmarks. */
export const C = {
  landmark: '#3fd0e0',
  reference: '#3fd0e0',
  measure: '#ff4040',
  canal: '#d9a441',
  cup: '#3d6bff',
  stem: '#2ee86a',
  pending: '#ffffff',
  head: '#f4a261',
  ghost: '#c8f560',
  proposed: '#ffbe0b',
};

/** A drawn, draggable label (image px) so the viewer can hit-test it. */
export interface LabelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Movable labels: `offsets` holds the user's drag offset per label id in
 * SCREEN px (so a moved label stays put relative to its anchor at any zoom);
 * `boxes` is filled with every label drawn this frame.
 */
export interface LabelLayer {
  offsets: Record<string, Vec2>;
  boxes: LabelBox[];
}

export function drawOverlay(ctx: CanvasRenderingContext2D, s: AppState, k: number, layers: Layers, labels: LabelLayer = { offsets: {}, boxes: [] }): void {
  const c = s.case;
  const mmPerPx = c.calibration?.mmPerPx;
  const toPx = (pMm: Vec2): Vec2 => scale(pMm, 1 / (mmPerPx ?? 1));
  labels.boxes.length = 0;
  const mlabel = (id: string, anchor: Vec2, text: string, color: string, dflt: Vec2 = { x: 8, y: -8 }): void => {
    const off = labels.offsets[id] ?? { x: 0, y: 0 };
    const pos = add(anchor, scale(add(dflt, off), k));
    const box = tag(ctx, pos, text, color, k);
    labels.boxes.push({ id, ...box });
    if (Math.hypot(off.x, off.y) > 12) {
      // Leader line from the anchor to the nearest edge of the moved label.
      const nx = Math.max(box.x, Math.min(anchor.x, box.x + box.w));
      const ny = Math.max(box.y, Math.min(anchor.y, box.y + box.h));
      line(ctx, anchor, { x: nx, y: ny }, color, 0.8 * k, [3 * k, 3 * k]);
    }
  };
  const showM = layers.measurements;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const op = c.operativeSide;

  // Calibration
  const cal = c.calibration;
  if (cal?.marker) {
    circle(ctx, cal.marker.center, cal.marker.radius, C.landmark, 1.2 * k, [4 * k, 3 * k]);
    if (showM) mlabel('marker', add(cal.marker.center, { x: cal.marker.radius, y: 0 }), `${cal.markerDiameterMm} mm marker`, '#ffffff', { x: 6, y: 4 });
  }
  if (cal?.line) {
    line(ctx, cal.line[0], cal.line[1], '#ffffff', 1.5 * k);
    label(ctx, cal.line[1], `${cal.lineLengthMm} mm`, '#ffffff', k);
  }

  const m = s.measurements;
  const plan = s.plan;

  // ---- Leg length: teardrop line, drops to each LT, A / NA heights, LLD.
  if (showM && m && mmPerPx) {
    const f = m.pelvis;
    const tds = [c.landmarks.R.teardrop, c.landmarks.L.teardrop].filter((p): p is Vec2 => !!p).map((p) => toFrameXY(f, scale(p, mmPerPx)));
    const xs = [...tds.map((p) => p.x)];
    for (const sm of [m.op, m.contra]) {
      const lt = c.landmarks[sm.side].lesserTrochanter;
      if (lt) xs.push(toFrameX(f, scale(lt, mmPerPx)));
    }
    const x0 = Math.min(...xs) - 15;
    const x1 = Math.max(...xs) + 15;
    line(ctx, toPx(fromFrame(f, { x: x0, y: 0 })), toPx(fromFrame(f, { x: x1, y: 0 })), C.measure, 1.6 * k);
    for (const sm of [m.op, m.contra]) {
      const l = c.landmarks[sm.side];
      if (!l.lesserTrochanter || sm.ltBelowLine === undefined) continue;
      const ltF = toFrameXY(f, scale(l.lesserTrochanter, mmPerPx));
      const top = toPx(fromFrame(f, { x: ltF.x, y: 0 }));
      line(ctx, top, l.lesserTrochanter, C.measure, 1.4 * k, [6 * k, 4 * k]);
      const tagText = `${sm.side === op ? 'A' : 'NA'} ${sm.ltBelowLine.toFixed(1)} mm`;
      mlabel(`ll-${sm.side}`, l.lesserTrochanter, tagText, C.measure, { x: -20, y: 34 });
    }
    if (m.legLengthDifference !== undefined && tds.length === 2) {
      const midTop = toPx(fromFrame(f, { x: (tds[0].x + tds[1].x) / 2, y: 0 }));
      mlabel('lld', midTop, `LLD ${signedMm(m.legLengthDifference)}`, C.measure, { x: -40, y: -8 });
    }
  }

  // ---- Landmarks: cyan ⊕ markers (they are also the drag handles).
  for (const side of ['R', 'L'] as const) {
    const l = c.landmarks[side];
    const isOp = side === op;
    const t = (name: string) => (showM ? `${name}` : undefined);
    if (l.teardrop) target(ctx, l.teardrop, C.landmark, k, t('TD'), mlabel, `td-${side}`);
    if (l.lesserTrochanter) target(ctx, l.lesserTrochanter, C.landmark, k, undefined, mlabel, `lt-${side}`);
    if (l.greaterTrochanter) target(ctx, l.greaterTrochanter, C.landmark, k, t('GT'), mlabel, `gt-${side}`);
    if (l.acetabularEdge) target(ctx, l.acetabularEdge, C.landmark, k, t('Edge'), mlabel, `edge-${side}`);
    if (l.head) {
      // Native head: thin outline, native centre as a small cross.
      circle(ctx, l.head.center, l.head.radius, C.head, (isOp ? 1.2 : 1) * k, isOp ? [] : [5 * k, 4 * k]);
      cross(ctx, l.head.center, 5 * k, C.head, 1.2 * k);
      if (mmPerPx && showM) mlabel(`head-${side}`, add(l.head.center, { x: -l.head.radius * 0.7, y: -l.head.radius * 0.7 }), `Ø ${(2 * l.head.radius * mmPerPx).toFixed(1)}`, C.head, { x: -60, y: -10 });
    }
    const reviewingCanal = s.review?.items[s.review.index]?.kind === 'landmark' && (s.review.items[s.review.index] as { side: string; key: string }).side === side && (s.review.items[s.review.index] as { key: string }).key === 'canal';
    if ((layers.canal || reviewingCanal) && l.canal) {
      ctx.fillStyle = C.canal;
      for (const lev of l.canal.levels) {
        dot(ctx, lev.medialEndosteal, 1.5 * k);
        dot(ctx, lev.lateralEndosteal, 1.5 * k);
      }
      const ax = l.canal.axis;
      const first = l.canal.levels[0].center;
      const last = l.canal.levels[l.canal.levels.length - 1].center;
      const t0 = (first.x - ax.point.x) * ax.dir.x + (first.y - ax.point.y) * ax.dir.y - 80 / (mmPerPx ?? 0.15);
      const t1 = (last.x - ax.point.x) * ax.dir.x + (last.y - ax.point.y) * ax.dir.y;
      line(ctx, add(ax.point, scale(ax.dir, t0)), add(ax.point, scale(ax.dir, t1)), C.canal, 1 * k, [6 * k, 4 * k]);
    }
    if (l.canalSeeds && (layers.canal || reviewingCanal || l.status?.canal === 'proposed')) {
      for (const sd of l.canalSeeds) point(ctx, sd, C.canal, k);
    }
  }

  // ---- Cup template (blue): shell outline, rim markers, inclination line, COR dot.
  if (layers.cup && plan?.cup && mmPerPx && m) {
    const f = m.pelvis;
    const cup = plan.cup;
    const center = toPx(fromFrame(f, cup.center));
    const r = cup.size.outerDiameter / 2 / mmPerPx;
    const rIn = Math.max(r * 0.5, (cup.size.outerDiameter / 2 - SHELL_MM) / mmPerPx);
    const rimA = toPx(fromFrame(f, cup.inferomedialRim));
    const rimB = toPx(fromFrame(f, cup.superolateralRim));
    const faceDir = norm(sub(rimB, rimA));
    // Dome lies on the superomedial side of the face line.
    const towardsDome = norm(sub(toPx(fromFrame(f, add(cup.center, { x: -Math.sin(rad(cup.inclination)), y: Math.cos(rad(cup.inclination)) }))), center));
    const start = Math.atan2(faceDir.y, faceDir.x);
    const ccw = isCcwDome(faceDir, towardsDome);
    ctx.save();
    ctx.strokeStyle = C.cup;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, start, start + Math.PI, ccw);
    ctx.arc(center.x, center.y, rIn, start + Math.PI, start, !ccw);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    // Inclination (face) line through the rim, extended.
    const ext = 0.45 * r;
    line(ctx, sub(rimA, scale(faceDir, ext)), add(rimB, scale(faceDir, ext)), C.measure, 1.2 * k);
    rimMarker(ctx, rimA, C.cup, k);
    rimMarker(ctx, rimB, C.cup, k);
    corDot(ctx, center, C.cup, k);
    mlabel('cup', rimB, `${cup.inclination}°`, C.cup, { x: 10, y: -4 });
  }

  // ---- Stem template (green): outline, axes, cut, head centre dot.
  if (layers.stem && plan?.stem && plan.femur && mmPerPx) {
    const fem = plan.femur;
    const ch = plan.stem.chosen;
    const toImg = (q: Vec2): Vec2 => toPx(fromFrame(fem, stemToFemur(ch.pose, q)));
    const outline = stemOutlineLocal(ch.size, ch.offset).map(toImg);
    ctx.save();
    ctx.strokeStyle = C.stem;
    ctx.lineWidth = 1.8 * k;
    ctx.beginPath();
    outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    const len = ch.size.profile[ch.size.profile.length - 1].d;
    const headLocal = neckHeadCenter(ch.offset);
    const hc = toImg(headLocal);
    // Stem axis and neck axis (dashed), meeting where the neck axis crosses the stem axis.
    const beta = rad(180 - ch.offset.neckShaftAngle);
    const neckBaseLocal = { x: 0, y: headLocal.y + headLocal.x / Math.tan(beta) };
    line(ctx, toImg({ x: 0, y: Math.min(neckBaseLocal.y, -8) }), toImg({ x: 0, y: len + 6 }), C.stem, 1 * k, [7 * k, 5 * k]);
    line(ctx, toImg(neckBaseLocal), hc, C.stem, 1 * k, [7 * k, 5 * k]);
    // Neck cut.
    const [cutA, cutB] = neckCutLocal(ch.size, ch.offset).map(toImg);
    line(ctx, cutA, cutB, C.stem, 1.4 * k, [4 * k, 3 * k]);
    if (showM) mlabel('cut', cutB, `Cut ${plan.stem.resectionAboveLT.toFixed(0)} mm above LT`, C.stem, { x: 6, y: -6 });
    // Tip handle (drag to tilt) and the head centre of rotation.
    const tip = toImg({ x: 0, y: len });
    rimMarker(ctx, tip, C.stem, k);
    corDot(ctx, hc, C.stem, k);

    // Reduction: stem head → cup centre, and where the LT ends up.
    if (showM && plan.cup && s.measurements && plan.reconstruction) {
      const pel = s.measurements.pelvis;
      const cupC = toPx(fromFrame(pel, plan.cup.center));
      line(ctx, hc, cupC, '#ffffff', 1 * k, [2 * k, 3 * k]);
      const lt = c.landmarks[op].lesserTrochanter;
      if (lt) {
        // Translate the LT by the reduction vector T = C − S (pelvic frame).
        const T = sub(plan.cup.center, plan.reconstruction.stemHead);
        const ghost = toPx(fromFrame(pel, add(toFrameXY(pel, scale(lt, mmPerPx)), T)));
        ctx.save();
        ctx.globalAlpha = 0.85;
        point(ctx, ghost, C.ghost, k);
        ctx.restore();
        mlabel('ltafter', ghost, 'LT after', C.ghost, { x: 10, y: 4 });
      }
    }
  }

  // ---- Proposed (unconfirmed) points: amber dashed ring; the one under review gets a target.
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
      for (const p of pts) circle(ctx, p, 13 * k, C.proposed, 1.5 * k, [3 * k, 3 * k]);
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
      circle(ctx, p, 22 * k, C.proposed, 2.5 * k);
      line(ctx, { x: p.x - 36 * k, y: p.y }, { x: p.x - 24 * k, y: p.y }, C.proposed, 2 * k);
      line(ctx, { x: p.x + 24 * k, y: p.y }, { x: p.x + 36 * k, y: p.y }, C.proposed, 2 * k);
      line(ctx, { x: p.x, y: p.y - 36 * k }, { x: p.x, y: p.y - 24 * k }, C.proposed, 2 * k);
      line(ctx, { x: p.x, y: p.y + 24 * k }, { x: p.x, y: p.y + 36 * k }, C.proposed, 2 * k);
    }
  }

  // Pending clicks for multi-click tools
  for (const p of s.pendingClicks) point(ctx, p, C.pending, k);

  // Contralateral mirrored COR target (visual check of cup position)
  if (showM && layers.cup && m && mmPerPx && m.contra.headCenter) {
    const mir = { x: -m.contra.headCenter.x, y: m.contra.headCenter.y };
    const p = toPx(fromFrame(m.pelvis, mir));
    ctx.save();
    ctx.globalAlpha = 0.7;
    cross(ctx, p, 5 * k, C.landmark, 1 * k);
    ctx.restore();
    mlabel('mirror', p, `mirrored ${otherSide(op)} COR`, C.landmark, { x: -40, y: 26 });
  }
}

/** Shell wall thickness drawn for the cup template (mm). */
const SHELL_MM = 4;

function signedMm(v: number): string {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? '0.0 mm' : `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} mm`;
}

/** Cyan ⊕ landmark marker with an optional movable caption. */
function target(
  ctx: CanvasRenderingContext2D,
  p: Vec2,
  color: string,
  k: number,
  text: string | undefined,
  mlabel: (id: string, anchor: Vec2, text: string, color: string, dflt?: Vec2) => void,
  id: string,
): void {
  const r = 7 * k;
  circle(ctx, p, r, color, 1.6 * k);
  line(ctx, { x: p.x - r, y: p.y }, { x: p.x + r, y: p.y }, color, 1.2 * k);
  line(ctx, { x: p.x, y: p.y - r }, { x: p.x, y: p.y + r }, color, 1.2 * k);
  if (text) mlabel(id, p, text, color, { x: -10, y: -14 });
}

/** ⊗ marker used at cup rim ends and the stem tip. */
function rimMarker(ctx: CanvasRenderingContext2D, p: Vec2, color: string, k: number): void {
  const r = 6 * k;
  circle(ctx, p, r, color, 1.6 * k);
  const d = r * 0.7;
  line(ctx, { x: p.x - d, y: p.y - d }, { x: p.x + d, y: p.y + d }, color, 1.2 * k);
  line(ctx, { x: p.x - d, y: p.y + d }, { x: p.x + d, y: p.y - d }, color, 1.2 * k);
}

/** Centre-of-rotation dot: filled centre inside a ring. */
function corDot(ctx: CanvasRenderingContext2D, p: Vec2, color: string, k: number): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  circle(ctx, p, 8.5 * k, color, 1.6 * k);
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

/** Label with a dark backing box; returns the box in image px. */
function tag(ctx: CanvasRenderingContext2D, p: Vec2, text: string, color: string, k: number): { x: number; y: number; w: number; h: number } {
  ctx.save();
  ctx.font = `600 ${12 * k}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10 * k;
  const h = 18 * k;
  const box = { x: p.x - 5 * k, y: p.y - 13 * k, w, h };
  ctx.fillStyle = 'rgba(5,7,10,0.72)';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 1;
  ctx.lineWidth = 0.8 * k;
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
  ctx.restore();
  return box;
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
