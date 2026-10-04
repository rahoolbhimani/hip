/**
 * Automatic templating engine.
 *
 * Given calibrated landmarks it:
 *  1. sizes and positions the acetabular cup (teardrop-referenced or at the
 *     native centre of rotation) at the target inclination;
 *  2. for every stem size finds the depth at which the tapered stem engages
 *     the endosteal canal ("fit and fill");
 *  3. enumerates size × offset option × head length and picks the
 *     combination that best restores leg length and global offset with a
 *     plausible neck-resection level.
 *
 * Leg length and offset changes are computed with the standard 2D model:
 * the femur hangs from the centre of rotation, so moving the prosthetic head
 * relative to the femur, or the cup relative to the pelvis, shifts the leg.
 * The femoral anatomical axis is assumed parallel to the pelvic vertical when
 * combining the two contributions (cos error < 1% for typical 5–8° axes).
 */
import { median } from '../geometry/fit';
import { type Vec2, type Frame, add, scale, sub, dot, perp, fromFrame, toFrame, rad } from '../geometry/vec';
import {
  type ImplantLibrary,
  type StemFamily,
  type StemSize,
  type StemOffsetOption,
  type CupFamily,
  type CupSize,
  stemWidthAt,
  stemLength,
} from './implants';
import { type CaseData, otherSide } from './types';
import { type Measurements, measure, toMm, femoralAxisMm } from './measure';

export interface CanalProfileSample {
  /** Distal distance from the lesser-trochanter level along the femoral axis (mm). */
  d: number;
  /** Endosteal distance from the axis on the medial side (mm). */
  medial: number;
  /** Endosteal distance from the axis on the lateral side (mm). */
  lateral: number;
}

export interface CupPlan {
  family: CupFamily;
  size: CupSize;
  autoSize: number;
  /** Centre in the pelvic frame (mm). */
  center: Vec2;
  inclination: number;
  /** Rim endpoints in the pelvic frame (mm). */
  inferomedialRim: Vec2;
  superolateralRim: Vec2;
  bearingDiameter: number;
  /** Lateral uncovered rim beyond the acetabular edge, mm (only when the edge was marked). */
  lateralUncoverage?: number;
}

export interface StemCandidate {
  size: StemSize;
  offset: StemOffsetOption;
  headLength: number;
  /** Depth of the resection level below the lesser-trochanter level (mm, negative = above). */
  seatDepth: number;
  /** Prosthetic head centre in the femoral frame (m medial, d distal), mm. */
  headCenter: Vec2;
  legLengthChange: number;
  offsetChange: number;
  score: number;
  /** Stem fills beyond the detected canal (canal extrapolated). */
  beyondCanalData: boolean;
  /** Seats with the neck cut between the LT and the femoral head. */
  plausibleSeat: boolean;
}

export interface FillSample {
  d: number;
  stemWidth: number;
  canalWidth: number;
  fill: number;
}

export interface StemPlan {
  family: StemFamily;
  chosen: StemCandidate;
  /** Height of the medial resection point above the lesser trochanter (mm). */
  resectionAboveLT: number;
  fill: FillSample[];
  alternatives: StemCandidate[];
}

export interface PlanResult {
  measurements: Measurements;
  /** Femoral frame (mm): u = medial, v = distal, origin at LT level on the axis. */
  femur?: Frame;
  canalProfile?: CanalProfileSample[];
  cup?: CupPlan;
  stem?: StemPlan;
  targetLegLengthChange: number;
  targetOffsetChange: number;
  predictedLegLengthChange?: number;
  predictedOffsetChange?: number;
  /** Shift of the centre of rotation, pelvic frame (u lateral, v superior), mm. */
  corShift?: Vec2;
  warnings: string[];
  missing: string[];
}

const ENGAGE_TOLERANCE_MM = 0.5;
const SIDE_TOLERANCE_MM = 2;
/** Upper limit for the medial neck cut above the LT when the head does not constrain it further. */
const DEFAULT_MAX_RESECTION_MM = 30;
/** The medial cut may sit at most this far below the LT (deep cuts are rejected). */
const MIN_RESECTION_MM = 0;
/** Stem levels (mm below the resection) that are checked for cortical contact. */
const MIN_ENGAGE_STEM_LEVEL = 20;
/** Femoral levels (mm below the LT) from which the canal profile is trusted. */
const MIN_ENGAGE_FEMUR_LEVEL = 5;

export function buildPlan(c: CaseData, lib: ImplantLibrary): PlanResult | null {
  const m = measure(c);
  if (!m) return null;
  const mmPerPx = c.calibration!.mmPerPx;
  const opL = c.landmarks[c.operativeSide];
  const ctL = c.landmarks[otherSide(c.operativeSide)];
  const o = c.options;
  const warnings = [...m.warnings];
  const missing: string[] = [];

  if (!opL.head) missing.push('operative femoral head');
  if (!opL.lesserTrochanter) missing.push('operative lesser trochanter');
  if (!opL.canal) missing.push('operative femoral canal');
  if (!ctL.lesserTrochanter) warnings.push('Contralateral lesser trochanter not marked — leg length difference unknown; planning to keep current length.');
  if (!ctL.head || !ctL.canal) warnings.push('Contralateral head/canal not marked — restoring the operative side\'s own offset.');

  let targetLL = o.extraLengthening;
  if (o.correctLLD && m.legLengthDifference !== undefined) targetLL += -m.legLengthDifference;
  let targetOffset = 0;
  if (m.contra.globalOffset !== undefined && m.op.globalOffset !== undefined) {
    targetOffset = m.contra.globalOffset - m.op.globalOffset;
  }

  const result: PlanResult = {
    measurements: m,
    targetLegLengthChange: targetLL,
    targetOffsetChange: targetOffset,
    warnings,
    missing,
  };

  // ---- Cup -------------------------------------------------------------
  const cupFamily = lib.cups.find((f) => f.id === o.cupFamilyId) ?? lib.cups[0];
  if (opL.head && opL.teardrop && cupFamily) {
    result.cup = planCup(c, m, cupFamily, toFrame(m.pelvis, toMm(opL.teardrop, mmPerPx)), opL.acetabularEdge ? toFrame(m.pelvis, toMm(opL.acetabularEdge, mmPerPx)) : undefined);
    if (result.cup.size.outerDiameter !== result.cup.autoSize && o.cupSizeOverride === null) {
      warnings.push(`Cup size clamped to library range (${result.cup.size.outerDiameter} mm).`);
    }
  }

  // ---- Stem ------------------------------------------------------------
  const stemFamily = lib.stems.find((f) => f.id === o.stemFamilyId) ?? lib.stems[0];
  const axis = femoralAxisMm(opL, mmPerPx);
  if (!opL.head || !opL.lesserTrochanter || !axis || !stemFamily || !result.cup || !m.op.headCenter) {
    return result;
  }
  const headMm = toMm(opL.head.center, mmPerPx);
  const ltMm = toMm(opL.lesserTrochanter, mmPerPx);
  const origin = add(axis.point, scale(axis.dir, dot(sub(ltMm, axis.point), axis.dir)));
  let medialDir = perp(axis.dir);
  if (dot(sub(headMm, origin), medialDir) < 0) medialDir = scale(medialDir, -1);
  const femur: Frame = { origin, uAxis: medialDir, vAxis: axis.dir };
  result.femur = femur;

  const profile = canalProfile(c, femur);
  result.canalProfile = profile;
  if (profile.length < 3) {
    warnings.push('Too few canal levels detected to size the stem.');
    return result;
  }

  const nativeHeadF = toFrame(femur, headMm);
  const corShift = sub(result.cup.center, m.op.headCenter); // pelvic frame: u lateral, v superior
  result.corShift = corShift;

  // The medial neck cut must lie below the femoral head: at most the height
  // of the head's inferior margin above the LT.
  const headRadiusMm = opL.head.radius * mmPerPx;
  const maxResection = Math.max(5, Math.min(DEFAULT_MAX_RESECTION_MM, -nativeHeadF.y - headRadiusMm));

  const candidates: StemCandidate[] = [];
  const sizes = o.stemSizeOverride ? stemFamily.sizes.filter((s) => s.size === o.stemSizeOverride) : stemFamily.sizes;
  for (const size of sizes) {
    const engage = engagementDepth(size, profile, maxResection);
    const offsets = o.offsetOverride ? size.offsets.filter((x) => x.id === o.offsetOverride) : size.offsets;
    const heads = o.headLengthOverride !== null ? [o.headLengthOverride] : stemFamily.headLengths;
    for (const offset of offsets) {
      for (const headLength of heads) {
        const hc = stemHeadCenter(offset, headLength, engage.depth);
        // Femoral contribution: head higher on the femur (more negative d) lengthens.
        const llFemoral = nativeHeadF.y - hc.y;
        const offFemoral = hc.x - nativeHeadF.x;
        const legLengthChange = llFemoral - corShift.y;
        const offsetChange = offFemoral + corShift.x;
        const resectionAbove = -engage.depth;
        let score = (legLengthChange - targetLL) ** 2 + 0.5 * (offsetChange - targetOffset) ** 2;
        score += Math.abs(headLength) / 3.5; // prefer the neutral head
        if (resectionAbove < 5) score += 2 * (5 - resectionAbove) ** 2;
        if (resectionAbove > 20) score += 0.5 * (resectionAbove - 20) ** 2;
        if (engage.beyondData) score += 4;
        candidates.push({
          size,
          offset,
          headLength,
          seatDepth: engage.depth,
          headCenter: hc,
          legLengthChange,
          offsetChange,
          score,
          beyondCanalData: engage.beyondData,
          plausibleSeat: !engage.tooLarge && resectionAbove >= MIN_RESECTION_MM,
        });
      }
    }
  }
  if (candidates.length === 0) {
    warnings.push('No stem candidates match the selected overrides.');
    return result;
  }
  candidates.sort((a, b) => a.score - b.score);
  const plausible = candidates.filter((x) => x.plausibleSeat);
  const pool = plausible.length ? plausible : candidates;
  const chosen = pool[0];
  if (!chosen.plausibleSeat) {
    warnings.push(
      o.stemSizeOverride
        ? `Stem size ${o.stemSizeOverride} cannot seat with the neck cut between the lesser trochanter and the head — choose another size.`
        : 'No stem size seats with the neck cut between the lesser trochanter and the head. The detected canal is probably too narrow: check the green canal points and move the canal seeds into the medullary canal.',
    );
  }
  const fill: FillSample[] = [];
  const len = stemLength(chosen.size);
  for (const ds of [10, 20, 40, 60, 80, len - 10]) {
    if (ds > len) continue;
    const w = stemWidthAt(chosen.size, ds);
    const cw = canalAt(profile, chosen.seatDepth + ds);
    if (!w || !cw) continue;
    const stemWidth = w.medial + w.lateral;
    const canalWidth = cw.medial + cw.lateral;
    fill.push({ d: ds, stemWidth, canalWidth, fill: stemWidth / canalWidth });
  }
  result.stem = {
    family: stemFamily,
    chosen,
    resectionAboveLT: -chosen.seatDepth,
    fill,
    alternatives: uniqueBySize(pool).slice(1, 4),
  };
  result.predictedLegLengthChange = chosen.legLengthChange;
  result.predictedOffsetChange = chosen.offsetChange;
  if (chosen.beyondCanalData) warnings.push('Stem extends beyond the detected canal — extend the distal canal seed for a reliable size.');
  if (Math.abs(chosen.legLengthChange - targetLL) > 3) {
    warnings.push(`Best combination misses the leg-length target by ${(chosen.legLengthChange - targetLL).toFixed(1)} mm.`);
  }
  return result;
}

function uniqueBySize(cands: StemCandidate[]): StemCandidate[] {
  const seen = new Set<string>();
  const out: StemCandidate[] = [];
  for (const cnd of cands) {
    if (seen.has(cnd.size.size)) continue;
    seen.add(cnd.size.size);
    out.push(cnd);
  }
  return out;
}

export function planCup(
  c: CaseData,
  m: Measurements,
  family: CupFamily,
  teardrop: Vec2,
  acetabularEdge?: Vec2,
): CupPlan {
  const o = c.options;
  const headDiameter = m.op.headDiameter ?? 50;
  const desired = headDiameter + o.cupOversize;
  const sizes = family.sizes;
  let size: CupSize =
    o.cupSizeOverride !== null
      ? sizes.reduce((best, s) => (Math.abs(s.outerDiameter - o.cupSizeOverride!) < Math.abs(best.outerDiameter - o.cupSizeOverride!) ? s : best))
      : sizes.find((s) => s.outerDiameter >= desired) ?? sizes[sizes.length - 1];
  const autoSize = Math.ceil(desired / 2) * 2;
  const r = size.outerDiameter / 2;
  const incl = rad(o.cupInclination);
  let center: Vec2;
  if (o.cupPlacement === 'native' && m.op.headCenter) {
    center = m.op.headCenter;
  } else {
    // Medial wall abuts the teardrop; inferomedial rim level with its inferior tip.
    center = { x: teardrop.x + o.cupMedialWallOffset + r, y: teardrop.y + r * Math.sin(incl) };
  }
  const rimDir = { x: Math.cos(incl), y: Math.sin(incl) };
  const superolateralRim = add(center, scale(rimDir, r));
  const inferomedialRim = sub(center, scale(rimDir, r));
  return {
    family,
    size,
    autoSize,
    center,
    inclination: o.cupInclination,
    inferomedialRim,
    superolateralRim,
    bearingDiameter: size.maxHeadDiameter,
    lateralUncoverage: acetabularEdge ? superolateralRim.x - acetabularEdge.x : undefined,
  };
}

/** Prosthetic head centre in the femoral frame for a stem seated at `depth`. */
export function stemHeadCenter(offset: StemOffsetOption, headLength: number, depth: number): Vec2 {
  const beta = rad(180 - offset.neckShaftAngle);
  return {
    x: offset.offset + headLength * Math.sin(beta),
    y: depth - offset.height - headLength * Math.cos(beta),
  };
}

/** Canal endosteal profile in the femoral frame, sorted proximal → distal. */
export function canalProfile(c: CaseData, femur: Frame): CanalProfileSample[] {
  const l = c.landmarks[c.operativeSide];
  const mmPerPx = c.calibration!.mmPerPx;
  if (!l.canal) return [];
  return l.canal.levels
    .map((lev) => {
      const a = toFrame(femur, toMm(lev.medialEndosteal, mmPerPx));
      const b = toFrame(femur, toMm(lev.lateralEndosteal, mmPerPx));
      const ctr = toFrame(femur, toMm(lev.center, mmPerPx));
      return { d: ctr.y, medial: Math.max(a.x, b.x), lateral: -Math.min(a.x, b.x) };
    })
    .filter((s) => s.medial > 0 && s.lateral > 0)
    .sort((p, q) => p.d - q.d)
    .map((s, i, all) => {
      // Running median over 5 levels: one falsely narrow level (trabecular
      // edge, overlapping shadow) must not block every stem size.
      const win = all.slice(Math.max(0, i - 2), i + 3);
      return { d: s.d, medial: median(win.map((w) => w.medial)), lateral: median(win.map((w) => w.lateral)) };
    });
}

/** Interpolated canal half-widths at femoral depth d; null above the detected range. */
export function canalAt(profile: CanalProfileSample[], d: number): { medial: number; lateral: number } | null {
  if (profile.length === 0 || d < profile[0].d) return null;
  const last = profile[profile.length - 1];
  if (d >= last.d) return { medial: last.medial, lateral: last.lateral };
  for (let i = 1; i < profile.length; i++) {
    if (d <= profile[i].d) {
      const a = profile[i - 1];
      const b = profile[i];
      const t = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
      return { medial: a.medial + (b.medial - a.medial) * t, lateral: a.lateral + (b.lateral - a.lateral) * t };
    }
  }
  return null;
}

/**
 * Deepest seat (resection level depth relative to the LT, mm) at which the
 * stem does not breach the endosteal cortex in the meta-diaphyseal region —
 * i.e. where a tapered wedge would lock.
 *
 * The search starts at the highest anatomically possible resection
 * (`maxResectionAboveLT`, below the femoral head). If the stem already
 * breaches the canal there it is too large for this femur (`tooLarge`).
 */
export function engagementDepth(
  size: StemSize,
  profile: CanalProfileSample[],
  maxResectionAboveLT = DEFAULT_MAX_RESECTION_MM,
): { depth: number; beyondData: boolean; tooLarge: boolean } {
  const len = stemLength(size);
  const lastD = profile[profile.length - 1].d;
  const fits = (depth: number): boolean => {
    for (let ds = MIN_ENGAGE_STEM_LEVEL; ds <= len; ds += 2) {
      // Above the lesser trochanter the medial endosteum flares into the
      // calcar and is not captured by the canal profile.
      if (depth + ds < MIN_ENGAGE_FEMUR_LEVEL) continue;
      const w = stemWidthAt(size, ds);
      const cw = canalAt(profile, depth + ds);
      if (!w || !cw) continue;
      // Total mediolateral width is the primary criterion; the per-side check
      // is looser because it depends on the fitted axis position.
      if (w.medial + w.lateral > cw.medial + cw.lateral + ENGAGE_TOLERANCE_MM) return false;
      if (w.medial > cw.medial + SIDE_TOLERANCE_MM || w.lateral > cw.lateral + SIDE_TOLERANCE_MM) return false;
    }
    return true;
  };
  let depth = -maxResectionAboveLT;
  if (!fits(depth)) return { depth, beyondData: false, tooLarge: true };
  while (depth < 60 && fits(depth + 0.5)) depth += 0.5;
  return { depth, beyondData: depth + len > lastD, tooLarge: false };
}

/** Stem outline polygon in the femoral frame (mm) for drawing. */
export function stemOutline(size: StemSize, offset: StemOffsetOption, headLength: number, depth: number): Vec2[] {
  const medialEdge = size.profile.map((p) => ({ x: p.medial, y: depth + p.d }));
  const lateralEdge = size.profile.map((p) => ({ x: -p.lateral, y: depth + p.d })).reverse();
  const hc = stemHeadCenter(offset, 0, depth);
  const beta = rad(180 - offset.neckShaftAngle);
  const neckDir = { x: Math.sin(beta), y: -Math.cos(beta) };
  // Points inferomedially (towards the calcar side of the neck).
  const neckPerp = { x: -neckDir.y, y: neckDir.x };
  const trunnionBase = sub(hc, scale(neckDir, 14 - Math.min(headLength, 0)));
  const neckHalf = 6;
  const shoulder = { x: -size.profile[0].lateral, y: depth - size.shoulderHeight };
  return [
    shoulder,
    add(trunnionBase, scale(neckPerp, -neckHalf)),
    add(trunnionBase, scale(neckPerp, neckHalf)),
    ...medialEdge,
    ...lateralEdge,
  ];
}

/** Neck-cut line endpoints in the femoral frame (mm): medial point → lateral. */
export function neckCutLine(size: StemSize, offset: StemOffsetOption, depth: number): [Vec2, Vec2] {
  const beta = rad(180 - offset.neckShaftAngle);
  // Perpendicular to the neck axis, running superolaterally.
  const dir = { x: -Math.cos(beta), y: -Math.sin(beta) };
  const start = { x: size.profile[0].medial + 4, y: depth };
  return [start, add(start, scale(dir, 45))];
}

export const femurToImageMm = fromFrame;
