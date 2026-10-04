/**
 * Templating engine.
 *
 * Given calibrated landmarks it:
 *  1. sizes and positions the acetabular cup (teardrop-referenced, at the
 *     native centre of rotation, or where the user dragged it);
 *  2. for every stem size finds the depth at which the tapered stem engages
 *     the endosteal canal ("fit and fill"), unless the user placed it;
 *  3. picks the size × neck option (0 mm head) that best restores leg length
 *     and global offset with a neck cut between the LT and the head.
 *
 * Reconstruction (2D, exact for translation): the femur on the radiograph
 * sits with its native head in the native acetabulum. After reduction the
 * prosthetic head centre S moves to the cup centre C, so the femur is
 * translated by T = C − S (pelvic frame). Hence
 *   leg-length change   = −T_v  (femur moves distally → longer)
 *   global offset change = T_u  (femur moves laterally → more offset)
 * split into an acetabular part (C − native centre H) and a femoral part
 * (H − S).
 */
import { median } from '../geometry/fit';
import { type Vec2, type Frame, add, scale, sub, dot, perp, fromFrame, toFrame, rad, rotate } from '../geometry/vec';
import {
  type ImplantLibrary,
  type StemFamily,
  type StemSize,
  type StemOffsetOption,
  type CupFamily,
  type CupSize,
  stemWidthAt,
  stemLength,
  neckHeadCenter,
} from './implants';
import { type CaseData, type StemPose } from './types';
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
  manual: boolean;
}

/** Leg-length (+ = longer) and global-offset (+ = more) change, mm. */
export interface Change {
  ll: number;
  off: number;
}

export interface Reconstruction {
  /** Cup centre relative to the native head centre. */
  acetabular: Change;
  /** Native head centre relative to the prosthetic head on the femur. */
  femoral: Change;
  total: Change;
  /** Prosthetic head centre in the pelvic frame before reduction (mm). */
  stemHead: Vec2;
}

export interface StemCandidate {
  size: StemSize;
  offset: StemOffsetOption;
  pose: StemPose;
  /** How far (mm) the auto plan seats the stem above full cortical engagement. */
  proud: number;
  /** Prosthetic head centre (0 mm head) in the femoral frame (m medial, d distal), mm. */
  headCenter: Vec2;
  recon: Reconstruction;
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
  /** The stem edge crosses the endosteal border at this level. */
  breach: boolean;
}

export interface StemPlan {
  family: StemFamily;
  chosen: StemCandidate;
  manual: boolean;
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
  reconstruction?: Reconstruction;
  /** Operative minus contralateral leg length after surgery (mm). */
  postopLegLengthDifference?: number;
  postopGlobalOffset?: number;
  /** Shift of the centre of rotation, pelvic frame (u lateral, v superior), mm. */
  corShift?: Vec2;
  warnings: string[];
  missing: string[];
}

const ENGAGE_TOLERANCE_MM = 0.5;
const SIDE_TOLERANCE_MM = 2;
const BREACH_TOLERANCE_MM = 1;
/** Upper limit for the medial neck cut above the LT when the head does not constrain it further. */
const DEFAULT_MAX_RESECTION_MM = 30;
/** The medial cut may sit at most this far below the LT (deep cuts are rejected). */
const MIN_RESECTION_MM = 0;
/** Stem levels (mm below the resection) that are checked for cortical contact. */
const MIN_ENGAGE_STEM_LEVEL = 20;
/** Femoral levels (mm below the LT) from which the canal profile is trusted. */
const MIN_ENGAGE_FEMUR_LEVEL = 5;
/** Largest amount the auto plan may seat a stem proud of full engagement (mm). */
const MAX_PROUD_MM = 4;

/** Map a stem-local point (m medial, d distal from the resection level) into the femoral frame. */
export function stemToFemur(pose: StemPose, q: Vec2): Vec2 {
  return add({ x: pose.shift, y: pose.depth }, rotate(q, rad(pose.tilt)));
}

export function buildPlan(c: CaseData, lib: ImplantLibrary): PlanResult | null {
  const m = measure(c);
  if (!m) return null;
  const mmPerPx = c.calibration!.mmPerPx;
  const opL = c.landmarks[c.operativeSide];
    const o = c.options;
  const warnings = [...m.warnings];
  const missing: string[] = [];

  if (!opL.head) missing.push('operative femoral head');
  if (!opL.lesserTrochanter) missing.push('operative lesser trochanter');
  if (!opL.canal) missing.push('operative femoral canal');

  let targetLL = o.legLengthGoal.mm;
  if (o.legLengthGoal.mode === 'match') {
    if (m.legLengthDifference !== undefined) targetLL += -m.legLengthDifference;
    else warnings.push('Leg-length goal "equal to the other side" needs both lesser trochanters; planning a change of ' + `${targetLL} mm instead.`);
  }
  let targetOffset = o.offsetGoal.mm;
  if (o.offsetGoal.mode === 'match') {
    if (m.contra.globalOffset !== undefined && m.op.globalOffset !== undefined) targetOffset += m.contra.globalOffset - m.op.globalOffset;
    else warnings.push('Offset goal "match the other side" needs the contralateral head and canal; planning a change of ' + `${targetOffset} mm instead.`);
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
  const nativeHeadP = m.op.headCenter;
  const cupCenter = result.cup.center;
  result.corShift = sub(cupCenter, nativeHeadP);

  const reconstruct = (headF: Vec2): Reconstruction => {
    const stemHead = toFrame(m.pelvis, fromFrame(femur, headF));
    const acet = sub(cupCenter, nativeHeadP);
    const fem = sub(nativeHeadP, stemHead);
    return {
      acetabular: { ll: -acet.y, off: acet.x },
      femoral: { ll: -fem.y, off: fem.x },
      total: { ll: -(acet.y + fem.y), off: acet.x + fem.x },
      stemHead,
    };
  };

  // The medial neck cut must lie below the femoral head: at most the height
  // of the head's inferior margin above the LT.
  const headRadiusMm = opL.head.radius * mmPerPx;
  const maxResection = Math.max(5, Math.min(DEFAULT_MAX_RESECTION_MM, -nativeHeadF.y - headRadiusMm));

  const candidates: StemCandidate[] = [];
  const manualPose = o.stemPose;
  const sizes = o.stemSizeOverride ? stemFamily.sizes.filter((s) => s.size === o.stemSizeOverride) : stemFamily.sizes;
  for (const size of sizes) {
    const engage = engagementDepth(size, profile, maxResection);
    // Auto: from full cortical engagement up to MAX_PROUD_MM proud, so the
    // leg-length goal can be met between discrete sizes.
    const seats: Array<{ pose: StemPose; proud: number }> = manualPose
      ? [{ pose: manualPose, proud: 0 }]
      : [];
    if (!manualPose) {
      for (let proud = 0; proud <= MAX_PROUD_MM + 1e-9; proud += 0.5) {
        const depth = engage.depth - proud;
        if (proud > 0 && (engage.tooLarge || depth < -maxResection)) break;
        seats.push({ pose: { depth, shift: 0, tilt: 0 }, proud });
      }
    }
    const offsets = o.offsetOverride ? size.offsets.filter((x) => x.id === o.offsetOverride) : size.offsets;
    for (const { pose, proud } of seats) {
      for (const offset of offsets) {
        const hc = stemToFemur(pose, neckHeadCenter(offset));
        const recon = reconstruct(hc);
        const resectionAbove = -pose.depth;
        let score = (recon.total.ll - targetLL) ** 2 + 0.5 * (recon.total.off - targetOffset) ** 2;
        score += 0.15 * proud * proud; // prefer a fully seated stem
        if (resectionAbove < 5) score += 2 * (5 - resectionAbove) ** 2;
        if (resectionAbove > 20) score += 0.5 * (resectionAbove - 20) ** 2;
        if (engage.beyondData) score += 4;
        candidates.push({
          size,
          offset,
          pose,
          proud,
          headCenter: hc,
          recon,
          score,
          beyondCanalData: engage.beyondData,
          plausibleSeat: manualPose ? true : !engage.tooLarge && resectionAbove >= MIN_RESECTION_MM,
        });
      }
    }
  }
  if (candidates.length === 0) {
    warnings.push('No stem matches the selected size and neck.');
    return result;
  }
  candidates.sort((a, b) => a.score - b.score);
  const plausible = candidates.filter((x) => x.plausibleSeat);
  const pool = plausible.length ? plausible : candidates;
  const chosen = pool[0];
  if (!chosen.plausibleSeat) {
    warnings.push(
      o.stemSizeOverride
        ? `Stem size ${o.stemSizeOverride} cannot seat with the neck cut between the lesser trochanter and the head. Choose another size or drag the stem.`
        : 'No stem size seats with the neck cut between the lesser trochanter and the head. The detected canal is probably too narrow: check the green canal points and move the canal seeds into the medullary canal, or drag the stem into place.',
    );
  }
  const fill = fillSamples(chosen.size, chosen.pose, profile);
  const breaches = fill.filter((f) => f.breach);
  if (breaches.length) {
    warnings.push(`Stem crosses the endosteal cortex at ${breaches.map((b) => `${b.d.toFixed(0)} mm`).join(', ')} below the cut. Choose a smaller size or adjust the position.`);
  }
  result.stem = {
    family: stemFamily,
    chosen,
    manual: !!manualPose,
    resectionAboveLT: -chosen.pose.depth,
    fill,
    alternatives: manualPose ? [] : uniqueBySize(pool).slice(1, 4),
  };
  result.reconstruction = chosen.recon;
  result.predictedLegLengthChange = chosen.recon.total.ll;
  result.predictedOffsetChange = chosen.recon.total.off;
  if (m.legLengthDifference !== undefined) result.postopLegLengthDifference = m.legLengthDifference + chosen.recon.total.ll;
  if (m.op.globalOffset !== undefined) result.postopGlobalOffset = m.op.globalOffset + chosen.recon.total.off;
  if (chosen.beyondCanalData) warnings.push('Stem extends beyond the detected canal. Move the distal canal seed further down for a reliable size.');
  if (!manualPose && Math.abs(chosen.recon.total.ll - targetLL) > 3) {
    warnings.push(`Best combination misses the leg-length target by ${(chosen.recon.total.ll - targetLL).toFixed(1)} mm.`);
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

/** Stem vs canal width at standard levels below the cut, for any pose. */
export function fillSamples(size: StemSize, pose: StemPose, profile: CanalProfileSample[]): FillSample[] {
  const out: FillSample[] = [];
  const len = stemLength(size);
  for (const ds of [20, 40, 60, 80, len - 10]) {
    if (ds > len || ds < 0) continue;
    const w = stemWidthAt(size, ds);
    if (!w) continue;
    const med = stemToFemur(pose, { x: w.medial, y: ds });
    const lat = stemToFemur(pose, { x: -w.lateral, y: ds });
    const ctr = stemToFemur(pose, { x: 0, y: ds });
    const cm = canalAt(profile, med.y);
    const cl = canalAt(profile, lat.y);
    const cc = canalAt(profile, ctr.y);
    if (!cm || !cl || !cc) continue;
    const stemWidth = w.medial + w.lateral;
    const canalWidth = cc.medial + cc.lateral;
    const breach = med.x > cm.medial + BREACH_TOLERANCE_MM || -lat.x > cl.lateral + BREACH_TOLERANCE_MM;
    out.push({ d: ds, stemWidth, canalWidth, fill: stemWidth / canalWidth, breach });
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
  if (o.cupCenter) {
    center = o.cupCenter;
  } else if (o.cupPlacement === 'native' && m.op.headCenter) {
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
    manual: !!o.cupCenter,
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

/**
 * Stem template outline in stem-local coordinates (mm), 0 mm head:
 * body from the generated profile plus neck and trunnion drawn from the
 * table's offset, leg length and neck length.
 */
export function stemOutlineLocal(size: StemSize, offset: StemOffsetOption): Vec2[] {
  const hc = neckHeadCenter(offset);
  const beta = rad(180 - offset.neckShaftAngle);
  const dir = { x: Math.sin(beta), y: -Math.cos(beta) }; // neck axis towards the head
  const inf = { x: -dir.y, y: dir.x }; // perpendicular, inferomedial side
  const at = (p: Vec2, half: number): [Vec2, Vec2] => [sub(p, scale(inf, half)), add(p, scale(inf, half))];
  // Trunnion (taper) and neck just below it.
  const [trSup, trInf] = at(sub(hc, scale(dir, 1)), 5);
  const [neckSup, neckInf] = at(sub(hc, scale(dir, 14)), 6);
  const lat0 = size.profile[0].lateral;
  const med0 = size.profile[0].medial;
  // Lateral shoulder, rounded.
  const sh = size.shoulderHeight;
  const shoulder = [
    { x: -lat0, y: -sh + 5 },
    { x: -lat0 + 1.5, y: -sh + 1.5 },
    { x: -lat0 + 5, y: -sh },
  ];
  // Inferior neck border curving concavely into the calcar (quadratic Bézier).
  const calcarTop = { x: med0, y: 0 };
  const midChord = scale(add(neckInf, calcarTop), 0.5);
  const chord = sub(calcarTop, neckInf);
  const len = Math.hypot(chord.x, chord.y) || 1;
  const towardAxis = { x: chord.y / len, y: -chord.x / len }; // left normal of the chord
  const ctrl = add(midChord, scale(towardAxis.x < 0 ? towardAxis : scale(towardAxis, -1), 0.18 * len));
  const calcar: Vec2[] = [];
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const a = scale(neckInf, (1 - t) ** 2);
    const b = scale(ctrl, 2 * t * (1 - t));
    const c = scale(calcarTop, t * t);
    calcar.push(add(add(a, b), c));
  }
  const medial = size.profile.map((p) => ({ x: p.medial, y: p.d }));
  const lateral = size.profile.map((p) => ({ x: -p.lateral, y: p.d })).reverse();
  return [...shoulder, neckSup, trSup, trInf, neckInf, ...calcar, ...medial, ...lateral];
}

/** Neck-cut line in stem-local coordinates: from the medial resection point, perpendicular to the neck, superolaterally. */
export function neckCutLocal(size: StemSize, offset: StemOffsetOption): [Vec2, Vec2] {
  const beta = rad(180 - offset.neckShaftAngle);
  const dir = { x: -Math.cos(beta), y: -Math.sin(beta) };
  const start = { x: size.profile[0].medial + 2, y: 0 };
  const ml = size.profile[0].medial + size.profile[0].lateral;
  return [start, add(start, scale(dir, 1.5 * ml))];
}
