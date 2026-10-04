/**
 * Pre-operative radiographic measurements on an AP pelvis.
 *
 * Coordinates: everything is converted to millimetres in image orientation
 * (x right, y down) and then expressed in a PELVIC frame:
 *   u — along the inter-teardrop line, positive towards the operative side
 *   v — perpendicular, positive superior
 * Origin: midpoint between the teardrops.
 */
import {
  type Vec2,
  type Frame,
  scale,
  sub,
  norm,
  mid,
  toFrame,
  deg,
  dot,
  perp,
  signedDistanceToLine,
} from '../geometry/vec';
import type { Line } from '../geometry/fit';
import { type CaseData, type Side, type SideLandmarks, otherSide } from './types';

export interface SideMeasurements {
  side: Side;
  /** Lesser trochanter distance BELOW the inter-teardrop line (mm). */
  ltBelowLine?: number;
  /** Head centre in the pelvic frame (mm). */
  headCenter?: Vec2;
  headDiameter?: number;
  /** Horizontal distance from the teardrop to the head centre (mm). */
  acetabularOffset?: number;
  /** Perpendicular distance from head centre to the femoral anatomical axis (mm). */
  femoralOffset?: number;
  globalOffset?: number;
  /** Height of the head centre above the teardrop line (mm). */
  corHeight?: number;
  canalIsthmusWidth?: number;
  /** Anatomical axis angle relative to the pelvic vertical (deg, + = adducted). */
  femoralAxisAngle?: number;
}

export interface Measurements {
  pelvis: Frame;
  /** Pelvic obliquity: inter-teardrop line vs image horizontal (deg). */
  obliquity: number;
  interTeardropDistance: number;
  op: SideMeasurements;
  contra: SideMeasurements;
  /** Operative leg length minus contralateral (mm; negative = operative leg short). */
  legLengthDifference?: number;
  warnings: string[];
}

export const toMm = (p: Vec2, mmPerPx: number): Vec2 => scale(p, mmPerPx);

/** Patient-side → whether that side is on the viewer's left. */
export function isOnImageLeft(side: Side, standardOrientation: boolean): boolean {
  return standardOrientation ? side === 'R' : side === 'L';
}

/** Build the pelvic frame (in mm). Requires both teardrops. */
export function pelvicFrame(c: CaseData, mmPerPx: number): Frame | null {
  const op = c.landmarks[c.operativeSide].teardrop;
  const ct = c.landmarks[otherSide(c.operativeSide)].teardrop;
  if (!op || !ct) return null;
  const a = toMm(op, mmPerPx);
  const b = toMm(ct, mmPerPx);
  const u = norm(sub(a, b));
  // v must point superior, i.e. towards negative image y.
  let v = perp(u);
  if (v.y > 0) v = scale(v, -1);
  return { origin: mid(a, b), uAxis: u, vAxis: v };
}

/** Femoral axis line converted to mm, directed distally. */
export function femoralAxisMm(l: SideLandmarks, mmPerPx: number): Line | null {
  if (!l.canal) return null;
  return { point: toMm(l.canal.axis.point, mmPerPx), dir: l.canal.axis.dir };
}

function measureSide(
  c: CaseData,
  side: Side,
  frame: Frame,
  mmPerPx: number,
  sideSign: number,
): SideMeasurements {
  const l = c.landmarks[side];
  const m: SideMeasurements = { side };
  // In the pelvic frame, "lateral" for this side is sideSign * u.
  const teardrop = l.teardrop ? toFrame(frame, toMm(l.teardrop, mmPerPx)) : undefined;
  if (l.lesserTrochanter) {
    // Distance below the teardrop line (the u-axis passes through both teardrops).
    m.ltBelowLine = -toFrame(frame, toMm(l.lesserTrochanter, mmPerPx)).y;
  }
  if (l.head) {
    const hc = toFrame(frame, toMm(l.head.center, mmPerPx));
    m.headCenter = hc;
    m.headDiameter = 2 * l.head.radius * mmPerPx;
    m.corHeight = hc.y;
    if (teardrop) m.acetabularOffset = sideSign * (hc.x - teardrop.x);
  }
  const axis = femoralAxisMm(l, mmPerPx);
  if (axis && l.head) {
    m.femoralOffset = Math.abs(signedDistanceToLine(toMm(l.head.center, mmPerPx), axis.point, axis.dir));
    if (m.acetabularOffset !== undefined) m.globalOffset = m.acetabularOffset + m.femoralOffset;
  }
  if (axis) {
    // Angle between the distal axis and the pelvic inferior direction; positive
    // when the shaft runs distally towards the midline (adduction).
    const down = scale(frame.vAxis, -1);
    const medial = scale(frame.uAxis, -sideSign);
    m.femoralAxisAngle = deg(Math.atan2(dot(axis.dir, medial), dot(axis.dir, down)));
  }
  if (l.canal?.isthmus) m.canalIsthmusWidth = l.canal.isthmus.canalWidth * mmPerPx;
  return m;
}

export function measure(c: CaseData): Measurements | null {
  const mmPerPx = c.calibration?.mmPerPx;
  if (!mmPerPx) return null;
  const frame = pelvicFrame(c, mmPerPx);
  if (!frame) return null;
  const warnings: string[] = [];
  const opSide = c.operativeSide;
  const ctSide = otherSide(opSide);
  const op = measureSide(c, opSide, frame, mmPerPx, 1);
  const contra = measureSide(c, ctSide, frame, mmPerPx, -1);

  const obliquity = deg(Math.atan2(frame.uAxis.y, Math.abs(frame.uAxis.x)));
  const tdOp = toMm(c.landmarks[opSide].teardrop!, mmPerPx);
  const tdCt = toMm(c.landmarks[ctSide].teardrop!, mmPerPx);
  const interTeardropDistance = Math.hypot(tdOp.x - tdCt.x, tdOp.y - tdCt.y);

  // Sanity: is the operative teardrop on the expected side of the image?
  const opOnLeft = isOnImageLeft(opSide, c.standardOrientation);
  if (opOnLeft !== tdOp.x < tdCt.x) {
    warnings.push('Operative-side landmarks lie on the unexpected side of the image — check side / orientation settings.');
  }
  if (Math.abs(obliquity) > 5) warnings.push(`Pelvic obliquity of ${obliquity.toFixed(1)}° — check patient positioning.`);

  let legLengthDifference: number | undefined;
  if (op.ltBelowLine !== undefined && contra.ltBelowLine !== undefined) {
    legLengthDifference = op.ltBelowLine - contra.ltBelowLine;
  }
  return { pelvis: frame, obliquity, interTeardropDistance, op, contra, legLengthDifference, warnings };
}
