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
  /** Prosthetic femoral head diameter (mm). */
  bearingDiameter: number;
  /** The requested head was larger than this cup accepts. */
  headClamped?: boolean;
  /** Lateral uncovered rim beyond the acetabular edge, mm (only when the edge was marked). */
  lateralUncoverage?: number;
  manual: boolean;
  /** Height of the inferomedial rim above the teardrop line (mm). */
  rimAboveTeardrop: number;
  placement: 'anatomic' | 'teardrop' | 'native' | 'manual';
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
  /** How far (mm) the stem sits above full cortical contact (negative = deeper). */
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
  /** Canal fit of the chosen size (the basis for the size choice). */
  fit: SizeFit;
  sizeReason: string;
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
  /** Tilt (deg, + = varus) the auto plan applies to the stem relative to the canal axis. */
  autoStemTilt?: number;
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
/** Seating range explored to meet the leg-length goal, relative to full cortical contact (mm). */
const MAX_PROUD_SEAT_MM = 8;
const MAX_DEEP_SEAT_MM = 2;
/** Warn when the stem has to sit more proud than this (mm). */
const PROUD_WARN_MM = 4;

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
    const pf = (p?: Vec2) => (p ? toFrame(m.pelvis, toMm(p, mmPerPx)) : undefined);
    result.cup = planCup(c, m, cupFamily, {
      teardrop: pf(opL.teardrop)!,
      edge: pf(opL.acetabularEdge),
      ilioischial: pf(opL.ilioischial),
      sourcil: pf(opL.sourcil),
    });
    if (o.cupPlacement === 'anatomic' && result.cup.placement === 'teardrop') {
      warnings.push('Mark the ilioischial line and the sourcil to place the cup anatomically; using the teardrop for now.');
    }
    if (result.cup.headClamped) {
      warnings.push(`A ${o.headDiameter} mm head does not fit a ${result.cup.size.outerDiameter} mm cup; using ${result.cup.bearingDiameter} mm.`);
    }
    if (result.cup.placement !== 'anatomic' && result.cup.size.outerDiameter !== result.cup.autoSize && o.cupSizeOverride === null) {
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
  // Auto stem orientation: upright to the inter-teardrop line (axis along the
  // pelvic vertical) or along the femoral canal axis.
  const pelvicDown = scale(m.pelvis.vAxis, -1);
  const autoTilt =
    o.stemAlignment === 'canal'
      ? 0
      : Math.max(-20, Math.min(20, (Math.atan2(-dot(pelvicDown, femur.uAxis), dot(pelvicDown, femur.vAxis)) * 180) / Math.PI));
  result.autoStemTilt = autoTilt;
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

  // ---- 1. Size: chosen by canal fit only (goals play no part).
  const manualPose = o.stemPose;
  const fits = stemFamily.sizes.map((z) => sizeFit(z, profile, maxResection, autoTilt));
  const seatOk = (f: SizeFit) => !f.engage.tooLarge && -f.engage.depth >= MIN_RESECTION_MM;
  let fit: SizeFit | undefined;
  let sizeReason: string;
  if (o.stemSizeOverride) {
    fit = fits.find((f) => f.size.size === o.stemSizeOverride);
    sizeReason = 'Size chosen manually.';
  } else {
    const good = fits.filter((f) => seatOk(f) && !f.potsDistally);
    fit = good[good.length - 1];
    sizeReason = fit
      ? 'Largest size that fills the metaphysis without locking distally.'
      : 'No size fills the metaphysis without distal fixation; using the largest that seats.';
    if (!fit) fit = fits.filter(seatOk)[0] ?? fits[0];
  }
  if (!fit) {
    warnings.push('No stem matches the selected size.');
    return result;
  }
  const chosenFit = fit;

  // ---- 2. Seat height (neck cut) and neck offset: chosen to meet the goals.
  const seat = (f: SizeFit, offsetIds: string[] | null): StemCandidate | null => {
    const offsets = f.size.offsets.filter((x) => !offsetIds || offsetIds.includes(x.id));
    const poses: Array<{ pose: StemPose; proud: number }> = [];
    if (manualPose) poses.push({ pose: manualPose, proud: 0 });
    else {
      const lo = Math.max(-maxResection, f.engage.depth - MAX_PROUD_SEAT_MM);
      const hi = Math.min(-MIN_RESECTION_MM, f.engage.depth + MAX_DEEP_SEAT_MM);
      for (let d = lo; d <= hi + 1e-9; d += 0.5) poses.push({ pose: centredPose(f.size, profile, d, autoTilt), proud: f.engage.depth - d });
      if (!poses.length) poses.push({ pose: centredPose(f.size, profile, f.engage.depth, autoTilt), proud: 0 });
    }
    let best: StemCandidate | null = null;
    for (const offset of offsets) {
      for (const { pose, proud } of poses) {
        const hc = stemToFemur(pose, neckHeadCenter(offset));
        const recon = reconstruct(hc);
        let score = (recon.total.ll - targetLL) ** 2 + 0.5 * (recon.total.off - targetOffset) ** 2;
        // Prefer full seating: small cost for sitting proud, larger for sinking past contact.
        score += proud >= 0 ? 0.02 * proud * proud : 0.5 * proud * proud;
        if (!best || score < best.score) {
          best = {
            size: f.size,
            offset,
            pose,
            proud,
            headCenter: hc,
            recon,
            score,
            beyondCanalData: f.engage.beyondData,
            plausibleSeat: manualPose ? true : seatOk(f),
          };
        }
      }
    }
    return best;
  };
  const offsetIds = o.offsetOverride ? [o.offsetOverride] : null;
  const chosen = seat(chosenFit, offsetIds);
  if (!chosen) {
    warnings.push('No stem matches the selected neck.');
    return result;
  }
  if (!chosen.plausibleSeat) {
    warnings.push(
      o.stemSizeOverride
        ? `Stem size ${o.stemSizeOverride} cannot seat with the neck cut between the lesser trochanter and the head. Choose another size or drag the stem.`
        : 'No stem size seats with the neck cut between the lesser trochanter and the head. The detected canal is probably too narrow: check the canal points and move the canal seeds into the medullary canal, or drag the stem into place.',
    );
  }
  if (!o.stemSizeOverride && chosenFit.potsDistally) warnings.push(sizeReason);
  if (!manualPose && chosen.proud > PROUD_WARN_MM) {
    warnings.push(`To meet the leg-length goal the stem sits ${chosen.proud.toFixed(1)} mm proud of full cortical contact; it may be undersized at that level.`);
  }
  // Alternatives: the other neck on the same size, and the neighbouring sizes at their best seat.
  const idx = fits.indexOf(chosenFit);
  const alternatives = manualPose
    ? []
    : [
        seat(chosenFit, chosenFit.size.offsets.filter((x) => x.id !== chosen.offset.id).map((x) => x.id)),
        idx > 0 ? seat(fits[idx - 1], offsetIds) : null,
        idx < fits.length - 1 ? seat(fits[idx + 1], offsetIds) : null,
      ].filter((x): x is StemCandidate => !!x && x.offset !== undefined);
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
    alternatives,
    fit: chosenFit,
    sizeReason,
  };
  result.reconstruction = chosen.recon;
  result.predictedLegLengthChange = chosen.recon.total.ll;
  result.predictedOffsetChange = chosen.recon.total.off;
  if (m.legLengthDifference !== undefined) result.postopLegLengthDifference = m.legLengthDifference + chosen.recon.total.ll;
  if (m.op.globalOffset !== undefined) result.postopGlobalOffset = m.op.globalOffset + chosen.recon.total.off;
  if (chosen.beyondCanalData) warnings.push('Stem extends beyond the detected canal. Move the distal canal seed further down for a reliable size.');
  if (!manualPose && Math.abs(chosen.recon.total.ll - targetLL) > 2) {
    warnings.push(`The leg-length goal can't be reached within this stem's seating range (misses by ${(chosen.recon.total.ll - targetLL).toFixed(1)} mm). Consider moving the cup or changing the goal.`);
  }
  return result;
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

/** Acetabular landmarks for cup placement, in the pelvic frame (mm; u lateral, v superior). */
export interface AcetabularRefs {
  teardrop: Vec2;
  edge?: Vec2;
  ilioischial?: Vec2;
  sourcil?: Vec2;
}

export function planCup(c: CaseData, m: Measurements, family: CupFamily, refs: AcetabularRefs): CupPlan {
  const o = c.options;
  const sizes = family.sizes;
  const incl = rad(o.cupInclination);
  const anatomic = o.cupPlacement === 'anatomic' && !!refs.ilioischial && !!refs.sourcil;

  // Size. Anatomic: the largest cup that spans from the ilioischial line to the
  // lateral acetabular edge (dome on the line, superolateral rim at the edge):
  //   medial dome at I + R, rim at centre + R·cos(i)  →  2R = 2(E − I)/(1 + cos i).
  // Otherwise: native head diameter plus the oversize allowance.
  let desired: number;
  if (anatomic && refs.edge) {
    desired = (2 * (refs.edge.x - refs.ilioischial!.x - o.cupMedialWallOffset)) / (1 + Math.cos(incl));
  } else {
    desired = (m.op.headDiameter ?? 50) + o.cupOversize;
  }
  const autoSize = Math.round(desired / 2) * 2;
  let size: CupSize;
  if (o.cupSizeOverride !== null) {
    size = sizes.reduce((best, s) => (Math.abs(s.outerDiameter - o.cupSizeOverride!) < Math.abs(best.outerDiameter - o.cupSizeOverride!) ? s : best));
  } else if (anatomic && refs.edge) {
    // Largest size that stays within the lateral edge (1 mm leeway).
    size = [...sizes].reverse().find((s) => s.outerDiameter <= desired + 1) ?? sizes[0];
  } else {
    size = sizes.find((s) => s.outerDiameter >= desired) ?? sizes[sizes.length - 1];
  }
  const r = size.outerDiameter / 2;

  let center: Vec2;
  if (o.cupCenter) {
    center = o.cupCenter;
  } else if (anatomic) {
    // Dome against the ilioischial line medially and the sclerotic sourcil superiorly.
    center = { x: refs.ilioischial!.x + o.cupMedialWallOffset + r, y: refs.sourcil!.y - r };
  } else if (o.cupPlacement === 'native' && m.op.headCenter) {
    center = m.op.headCenter;
  } else {
    // Medial wall abuts the teardrop; inferomedial rim level with its inferior tip.
    center = { x: refs.teardrop.x + o.cupMedialWallOffset + r, y: refs.teardrop.y + r * Math.sin(incl) };
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
    bearingDiameter: o.headDiameter !== null ? Math.min(o.headDiameter, size.maxHeadDiameter) : size.maxHeadDiameter,
    headClamped: o.headDiameter !== null && o.headDiameter > size.maxHeadDiameter,
    lateralUncoverage: refs.edge ? superolateralRim.x - refs.edge.x : undefined,
    rimAboveTeardrop: inferomedialRim.y - refs.teardrop.y,
    placement: o.cupCenter ? 'manual' : anatomic ? 'anatomic' : o.cupPlacement === 'native' ? 'native' : 'teardrop',
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
 * Pose of a stem seated at `depth` with axis tilt `tilt` (deg, + = varus),
 * centred in the canal at mid-stem.
 */
export function centredPose(size: StemSize, profile: CanalProfileSample[], depth: number, tilt: number): StemPose {
  const half = stemLength(size) / 2;
  const t = rad(tilt);
  const c = canalAt(profile, depth + half * Math.cos(t));
  const centre = c ? (c.medial - c.lateral) / 2 : 0;
  return { depth, tilt, shift: centre + half * Math.sin(t) };
}

/**
 * Deepest seat (resection level depth relative to the LT, mm) at which the
 * stem does not breach the endosteal cortex in the meta-diaphyseal region —
 * i.e. where a tapered wedge would lock. The stem keeps the given axis tilt
 * relative to the canal and stays centred in it.
 *
 * The search starts at the highest anatomically possible resection
 * (`maxResectionAboveLT`, below the femoral head). If the stem already
 * breaches the canal there it is too large for this femur (`tooLarge`).
 */
export interface Engagement {
  /** Seat depth at full cortical contact (resection level below the LT, mm). */
  depth: number;
  beyondData: boolean;
  /** Breaches the canal even at the highest allowed seat. */
  tooLarge: boolean;
  /** Stem level (mm below the cut) where cortical contact first occurs; null if never. */
  bindLevel: number | null;
}

export function engagementDepth(
  size: StemSize,
  profile: CanalProfileSample[],
  maxResectionAboveLT = DEFAULT_MAX_RESECTION_MM,
  tilt = 0,
): Engagement {
  const len = stemLength(size);
  const lastD = profile[profile.length - 1].d;
  const cosT = Math.cos(rad(tilt));
  /** Returns the first stem level that breaches the canal, or null if the stem fits. */
  const breachAt = (depth: number): number | null => {
    const pose = centredPose(size, profile, depth, tilt);
    for (let ds = MIN_ENGAGE_STEM_LEVEL; ds <= len; ds += 2) {
      const ctr = stemToFemur(pose, { x: 0, y: ds });
      // Above the lesser trochanter the medial endosteum flares into the
      // calcar and is not captured by the canal profile.
      if (ctr.y < MIN_ENGAGE_FEMUR_LEVEL) continue;
      const w = stemWidthAt(size, ds);
      if (!w) continue;
      const med = stemToFemur(pose, { x: w.medial, y: ds });
      const lat = stemToFemur(pose, { x: -w.lateral, y: ds });
      const cc = canalAt(profile, ctr.y);
      const cm = canalAt(profile, med.y);
      const cl = canalAt(profile, lat.y);
      if (!cc || !cm || !cl) continue;
      // Total mediolateral width is the primary criterion; the per-side check
      // is looser because it depends on the fitted axis position.
      if ((med.x - lat.x) * cosT > cc.medial + cc.lateral + ENGAGE_TOLERANCE_MM) return ds;
      if (med.x > cm.medial + SIDE_TOLERANCE_MM || -lat.x > cl.lateral + SIDE_TOLERANCE_MM) return ds;
    }
    return null;
  };
  let depth = -maxResectionAboveLT;
  const first = breachAt(depth);
  if (first !== null) return { depth, beyondData: false, tooLarge: true, bindLevel: first };
  let bindLevel: number | null = null;
  while (depth < 60) {
    const b = breachAt(depth + 0.5);
    if (b !== null) {
      bindLevel = b;
      break;
    }
    depth += 0.5;
  }
  return { depth, beyondData: depth + len * cosT > lastD, tooLarge: false, bindLevel };
}

/** How a size fits the canal at full engagement — the basis for choosing the size. */
export interface SizeFit {
  size: StemSize;
  engage: Engagement;
  /** Where along the stem it first contacts cortex, as a fraction of stem length. */
  bindFraction: number | null;
  /** Stem / canal width in the metaphysis (20 mm below the cut). */
  metaphysealFill: number | null;
  /** Stem / canal width in the distal stem (80 % of its length). */
  distalFill: number | null;
  /** Locks distally before filling the metaphysis. */
  potsDistally: boolean;
}

/** Contact beyond this fraction of the stem length counts as distal (diaphyseal) fixation. */
const DISTAL_BIND_FRACTION = 0.6;
/** Distal fill above this means the stem is too big distally. */
const MAX_DISTAL_FILL = 0.92;

export function sizeFit(size: StemSize, profile: CanalProfileSample[], maxResection: number, tilt: number): SizeFit {
  const engage = engagementDepth(size, profile, maxResection, tilt);
  const len = stemLength(size);
  const pose = centredPose(size, profile, engage.depth, tilt);
  const fillAt = (ds: number): number | null => {
    const w = stemWidthAt(size, ds);
    const c = canalAt(profile, stemToFemur(pose, { x: 0, y: ds }).y);
    return w && c ? (w.medial + w.lateral) / (c.medial + c.lateral) : null;
  };
  const bindFraction = engage.bindLevel === null ? null : engage.bindLevel / len;
  const distalFill = fillAt(0.8 * len);
  const potsDistally = (bindFraction !== null && bindFraction > DISTAL_BIND_FRACTION) || (distalFill !== null && distalFill > MAX_DISTAL_FILL);
  return { size, engage, bindFraction, metaphysealFill: fillAt(20), distalFill, potsDistally };
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
