import type { Vec2 } from '../geometry/vec';
import type { LoadedImage } from '../imaging/load';
import { detectCanal, detectFemoralHead } from '../imaging/detect';
import { type CaseData, type LandmarkKey, type Side, type SideLandmarks, type StemPose, emptyCase } from '../planning/types';
import { type PlanResult, buildPlan } from '../planning/plan';
import { type ImplantLibrary, DEFAULT_LIBRARY } from '../planning/implants';
import { measure, type Measurements } from '../planning/measure';
import { type Step, type StepKind, STEPS, stepSide } from './steps';
import { autoDetectLandmarks } from '../imaging/autoLandmarks';

/** Fallback scale before calibration, only used to size search windows. */
const ASSUMED_MM_PER_PX = 0.15;

export type CalibrationTool = 'marker' | 'line';

export interface AppState {
  image: LoadedImage | null;
  case: CaseData;
  library: ImplantLibrary;
  /** Active landmark step id or calibration tool. */
  activeTool: { type: 'step'; step: Step } | { type: 'calibration'; tool: CalibrationTool } | null;
  /** Clicks collected so far for multi-click tools. */
  pendingClicks: Vec2[];
  plan: PlanResult | null;
  measurements: Measurements | null;
  status: string;
  window: [number, number] | null;
  /** Review of auto-proposed points, one at a time. */
  review: { items: ReviewItem[]; index: number } | null;
}

export type ReviewItem = { kind: 'marker' } | { kind: 'landmark'; side: Side; key: LandmarkKey };

const KEY_FOR_STEP: Record<StepKind, LandmarkKey> = {
  teardrop: 'teardrop',
  head: 'head',
  lt: 'lesserTrochanter',
  canal: 'canal',
  acetEdge: 'acetabularEdge',
  gt: 'greaterTrochanter',
};

type Listener = (s: AppState) => void;

export class Store {
  state: AppState = {
    image: null,
    case: emptyCase(),
    library: DEFAULT_LIBRARY,
    activeTool: null,
    pendingClicks: [],
    plan: null,
    measurements: null,
    status: 'Load an AP pelvis radiograph (PNG, JPEG or DICOM) or open the demo case.',
    window: null,
    review: null,
  };
  private listeners: Listener[] = [];
  /** Real sizes of the calibration objects, set from the calibration panel. */
  markerDiameterMm = 25;
  knownLengthMm = 100;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  setStatus(msg: string): void {
    this.state.status = msg;
    this.emit();
  }

  /** Recompute measurements and the automatic plan from the current case. */
  recompute(): void {
    const c = this.state.case;
    this.state.measurements = c.calibration ? measure(c) : null;
    // Implants are placed only once every landmark has been verified.
    this.state.plan = this.landmarksVerified() ? buildPlan(c, this.state.library) : null;
    this.emit();
  }

  /** True when calibration and all required landmarks are confirmed and no review is open. */
  landmarksVerified(): boolean {
    const c = this.state.case;
    if (!c.calibration || c.calibration.proposed || this.state.review) return false;
    if (this.unconfirmedCount() > 0) return false;
    return STEPS.filter((st) => st.required).every((st) => this.isStepDone(st));
  }

  /** Why implants are not shown yet (null when they are). */
  planBlockedReason(): string | null {
    if (this.landmarksVerified()) return null;
    const c = this.state.case;
    if (!c.calibration) return 'Calibrate the image to continue.';
    const left = this.unconfirmedCount();
    if (left > 0) return `Confirm the ${left} proposed point${left === 1 ? '' : 's'} (marked "?") to place the implants.`;
    const missing = STEPS.filter((st) => st.required && !this.isStepDone(st));
    if (missing.length) return `Place the remaining required landmarks to place the implants (${missing.length} left).`;
    if (this.state.review) return 'Finish the review to place the implants.';
    return null;
  }

  // ------------------------------------------------------------ auto-proposals & review

  statusOf(side: Side, key: LandmarkKey): 'proposed' | 'confirmed' | undefined {
    return this.landmarks(side).status?.[key];
  }

  stepStatus(step: Step): 'proposed' | 'confirmed' | undefined {
    if (!this.isStepDone(step)) return undefined;
    return this.statusOf(stepSide(step, this.state.case.operativeSide), KEY_FOR_STEP[step.kind]) ?? 'confirmed';
  }

  private setStatusOf(side: Side, key: LandmarkKey, st: 'proposed' | 'confirmed'): void {
    const l = this.landmarks(side);
    l.status = { ...(l.status ?? {}), [key]: st };
  }

  /** Propose every landmark automatically; points the user already confirmed are kept. */
  runAutoDetect(): void {
    const img = this.state.image;
    if (!img) return;
    const c = this.state.case;
    const res = autoDetectLandmarks(img.gray, {
      mmPerPx: c.calibration?.mmPerPx,
      standardOrientation: c.standardOrientation,
      markerDiameterMm: this.markerDiameterMm,
    });
    const items: ReviewItem[] = [];
    if (res.marker && !c.calibration) {
      c.calibration = {
        method: 'marker',
        mmPerPx: this.markerDiameterMm / (2 * res.marker.radius),
        marker: res.marker,
        markerDiameterMm: this.markerDiameterMm,
        proposed: true,
      };
      items.push({ kind: 'marker' });
    }
    const op = c.operativeSide;
    const ct = op === 'R' ? 'L' : 'R';
    let proposed = 0;
    const put = (side: Side, key: LandmarkKey, apply: () => void, at: Vec2): void => {
      if (this.statusOf(side, key) === 'confirmed') return;
      apply();
      const l = this.landmarks(side);
      l.proposals = { ...(l.proposals ?? {}), [key]: { ...at } };
      this.setStatusOf(side, key, 'proposed');
      proposed++;
    };
    for (const side of [op, ct] as Side[]) {
      const a = res.sides[side];
      const l = this.landmarks(side);
      if (a.teardrop) put(side, 'teardrop', () => (l.teardrop = a.teardrop), a.teardrop);
      if (a.head) put(side, 'head', () => (l.head = a.head), a.head.center);
      if (a.lesserTrochanter) put(side, 'lesserTrochanter', () => (l.lesserTrochanter = a.lesserTrochanter), a.lesserTrochanter);
      if (a.canalSeeds) {
        const seeds = a.canalSeeds;
        put(side, 'canal', () => {
          l.canalSeeds = seeds;
          this.detectCanal(side);
        }, seeds[0]);
      }
    }
    const order: Array<[Side, LandmarkKey]> = [
      [op, 'teardrop'], [ct, 'teardrop'], [op, 'head'], [op, 'lesserTrochanter'], [op, 'canal'],
      [ct, 'head'], [ct, 'lesserTrochanter'], [ct, 'canal'],
    ];
    for (const [side, key] of order) if (this.statusOf(side, key) === 'proposed') items.push({ kind: 'landmark', side, key });
    this.state.activeTool = null;
    this.state.pendingClicks = [];
    this.state.review = items.length ? { items, index: 0 } : null;
    const missed = res.notes.length ? ` ${res.notes.join(' ')}` : '';
    this.state.status = items.length
      ? `Proposed ${proposed} landmark${proposed === 1 ? '' : 's'}${res.marker ? ' and the calibration' : ''}. Check each one: press OK (Enter) or drag it first.${missed}`
      : `No landmarks could be proposed automatically. Place them by hand.${missed}`;
    this.recompute();
  }

  currentReviewItem(): ReviewItem | null {
    const r = this.state.review;
    return r ? r.items[r.index] ?? null : null;
  }

  private confirmItem(item: ReviewItem): void {
    if (item.kind === 'marker') {
      if (this.state.case.calibration) this.state.case.calibration.proposed = false;
    } else this.setStatusOf(item.side, item.key, 'confirmed');
  }

  private isConfirmed(item: ReviewItem): boolean {
    return item.kind === 'marker' ? !this.state.case.calibration?.proposed : this.statusOf(item.side, item.key) === 'confirmed';
  }

  reviewOK(): void {
    const item = this.currentReviewItem();
    if (!item) return;
    this.confirmItem(item);
    this.advanceReview();
  }

  reviewSkip(): void {
    this.advanceReview();
  }

  reviewOKAll(): void {
    const r = this.state.review;
    if (!r) return;
    for (const it of r.items) this.confirmItem(it);
    this.endReview('All proposed points confirmed.');
  }

  reviewGoTo(side: Side, key: LandmarkKey): void {
    const r = this.state.review ?? { items: [], index: 0 };
    let idx = r.items.findIndex((it) => it.kind === 'landmark' && it.side === side && it.key === key);
    if (idx < 0) {
      r.items.push({ kind: 'landmark', side, key });
      idx = r.items.length - 1;
    }
    this.state.review = { items: r.items, index: idx };
    this.state.activeTool = null;
    this.emit();
  }

  endReview(msg = 'Review closed. Unconfirmed points stay marked with "?".'): void {
    this.state.review = null;
    this.state.status = msg;
    this.recompute();
  }

  /** Move to the next unconfirmed item after the current one; finish when none is left. */
  private advanceReview(): void {
    const r = this.state.review;
    if (!r) return;
    const n = r.items.length;
    for (let step = 1; step < n; step++) {
      const i = (r.index + step) % n;
      if (!this.isConfirmed(r.items[i])) {
        this.state.review = { items: r.items, index: i };
        this.recompute();
        return;
      }
    }
    this.endReview(this.unconfirmedCount() ? 'Review done. Skipped points stay marked with "?".' : 'All points confirmed. Drag any implant or point to fine-tune.');
  }

  /**
   * Detector error on this film: for every confirmed point that was
   * auto-proposed, how far (mm) the user moved it before confirming.
   */
  detectionErrors(): Array<{ side: Side; key: LandmarkKey; mm: number }> {
    const mmPerPx = this.state.case.calibration?.mmPerPx;
    if (!mmPerPx) return [];
    const out: Array<{ side: Side; key: LandmarkKey; mm: number }> = [];
    for (const side of ['R', 'L'] as Side[]) {
      const l = this.landmarks(side);
      for (const [key, at] of Object.entries(l.proposals ?? {}) as Array<[LandmarkKey, Vec2]>) {
        if (l.status?.[key] !== 'confirmed') continue;
        const now = finalPoint(l, key);
        if (now) out.push({ side, key, mm: Math.hypot(now.x - at.x, now.y - at.y) * mmPerPx });
      }
    }
    return out;
  }

  unconfirmedCount(): number {
    let n = this.state.case.calibration?.proposed ? 1 : 0;
    for (const side of ['R', 'L'] as Side[]) for (const v of Object.values(this.landmarks(side).status ?? {})) if (v === 'proposed') n++;
    return n;
  }

  /** Manual stem placement; locks the current size and neck so dragging doesn't swap them. */
  setStemPose(pose: StemPose, size: string, offsetId: string): void {
    const o = this.state.case.options;
    o.stemPose = pose;
    o.stemSizeOverride = size;
    o.offsetOverride = offsetId;
    this.recompute();
  }

  resetStem(): void {
    const o = this.state.case.options;
    o.stemPose = null;
    o.stemSizeOverride = null;
    o.offsetOverride = null;
    this.recompute();
  }

  resetCup(): void {
    this.state.case.options.cupCenter = null;
    this.recompute();
  }

  mmPerPx(): number {
    return this.state.case.calibration?.mmPerPx ?? ASSUMED_MM_PER_PX;
  }

  landmarks(side: Side): SideLandmarks {
    return this.state.case.landmarks[side];
  }

  activateStep(step: Step | null): void {
    this.state.activeTool = step ? { type: 'step', step } : null;
    this.state.pendingClicks = [];
    if (step) this.state.status = step.hint;
    this.emit();
  }

  activateCalibration(tool: CalibrationTool | null): void {
    this.state.activeTool = tool ? { type: 'calibration', tool } : null;
    this.state.pendingClicks = [];
    if (tool === 'marker') this.state.status = 'Click the centre of the calibration marker ball, then a point on its edge.';
    if (tool === 'line') this.state.status = 'Click both ends of an object of known length.';
    this.emit();
  }

  /** The next required (then optional) step that has not been completed. */
  nextStep(): Step | null {
    const op = this.state.case.operativeSide;
    return STEPS.find((s) => s.required && !this.isStepDone(s, op)) ?? STEPS.find((s) => !this.isStepDone(s, op)) ?? null;
  }

  isStepDone(s: Step, op: Side = this.state.case.operativeSide): boolean {
    const l = this.landmarks(stepSide(s, op));
    switch (s.kind) {
      case 'teardrop':
        return !!l.teardrop;
      case 'head':
        return !!l.head;
      case 'lt':
        return !!l.lesserTrochanter;
      case 'canal':
        return !!l.canal;
      case 'acetEdge':
        return !!l.acetabularEdge;
      case 'gt':
        return !!l.greaterTrochanter;
    }
  }

  clearStep(s: Step): void {
    const l = this.landmarks(stepSide(s, this.state.case.operativeSide));
    if (l.status) delete l.status[KEY_FOR_STEP[s.kind]];
    switch (s.kind) {
      case 'teardrop':
        delete l.teardrop;
        break;
      case 'head':
        delete l.head;
        break;
      case 'lt':
        delete l.lesserTrochanter;
        break;
      case 'canal':
        delete l.canal;
        delete l.canalSeeds;
        break;
      case 'acetEdge':
        delete l.acetabularEdge;
        break;
      case 'gt':
        delete l.greaterTrochanter;
        break;
    }
    this.recompute();
  }

  /** Handle a click on the image for the active tool. Returns true if consumed. */
  handleClick(p: Vec2): boolean {
    const t = this.state.activeTool;
    if (!t || !this.state.image) return false;
    this.state.pendingClicks.push(p);
    const clicks = this.state.pendingClicks;
    if (t.type === 'calibration') {
      if (clicks.length < 2) {
        this.emit();
        return true;
      }
      if (t.tool === 'marker') this.calibrateMarker(clicks[0], clicks[1], this.markerDiameterMm);
      else this.calibrateLine(clicks[0], clicks[1], this.knownLengthMm);
      this.state.pendingClicks = [];
      const next = this.state.case.calibration ? this.nextStep() : null;
      this.state.activeTool = next ? { type: 'step', step: next } : null;
      if (next) this.state.status = `${this.state.status} Next: ${next.hint}`;
      this.recompute();
      return true;
    }
    const step = t.step;
    if (clicks.length < step.clicks) {
      this.state.status = step.kind === 'canal' ? 'Now click inside the canal further down the shaft (≈15 cm).' : step.hint;
      this.emit();
      return true;
    }
    const side = stepSide(step, this.state.case.operativeSide);
    const l = this.landmarks(side);
    let ok = true;
    switch (step.kind) {
      case 'teardrop':
        l.teardrop = clicks[0];
        break;
      case 'lt':
        l.lesserTrochanter = clicks[0];
        break;
      case 'gt':
        l.greaterTrochanter = clicks[0];
        break;
      case 'acetEdge':
        l.acetabularEdge = clicks[0];
        break;
      case 'head':
        ok = this.detectHead(side, clicks[0]);
        break;
      case 'canal':
        l.canalSeeds = [clicks[0], clicks[1]];
        ok = this.detectCanal(side);
        break;
    }
    this.state.pendingClicks = [];
    if (ok) this.setStatusOf(side, KEY_FOR_STEP[step.kind], 'confirmed');
    if (ok) {
      const next = this.nextStep();
      this.state.activeTool = next ? { type: 'step', step: next } : null;
      this.state.status = next ? next.hint : 'All landmarks placed. Drag any handle to fine-tune; the plan updates live.';
    }
    this.recompute();
    return true;
  }

  detectHead(side: Side, seed: Vec2): boolean {
    const img = this.state.image!.gray;
    const s = this.mmPerPx();
    const det = detectFemoralHead(img, seed, 15 / s, 34 / s);
    if (!det || det.confidence < 0.25) {
      this.state.status = 'Could not detect the head contour automatically — a default circle was placed; drag its edge handle to fit.';
      this.landmarks(side).head = { center: seed, radius: 24 / s };
      return true;
    }
    this.landmarks(side).head = det.circle;
    this.state.status = `Head detected (Ø ${(2 * det.circle.radius * s).toFixed(1)} mm, ${(det.confidence * 100).toFixed(0)}% edge support).`;
    return true;
  }

  detectCanal(side: Side): boolean {
    const l = this.landmarks(side);
    if (!l.canalSeeds || !this.state.image) return false;
    const s = this.mmPerPx();
    const det = detectCanal(this.state.image.gray, l.canalSeeds[0], l.canalSeeds[1], {
      stepPx: 2 / s,
      halfWidthPx: 30 / s,
      minCanalPx: 5 / s,
    });
    if (!det) {
      delete l.canal;
      this.state.status = 'Canal detection failed — place the seeds inside the medullary canal and try again.';
      return false;
    }
    l.canal = det;
    return true;
  }

  calibrateMarker(center: Vec2, edge: Vec2, diameter: number): void {
    const img = this.state.image!.gray;
    const rGuess = Math.hypot(edge.x - center.x, edge.y - center.y);
    const det = detectFemoralHead(img, center, rGuess * 0.7, rGuess * 1.3);
    const circle = det && det.confidence > 0.3 ? det.circle : { center, radius: rGuess };
    if (!diameter || diameter <= 0) {
      this.state.status = 'Enter the marker diameter in mm in the Calibration panel, then try again.';
      return;
    }
    this.state.case.calibration = {
      method: 'marker',
      mmPerPx: diameter / (2 * circle.radius),
      marker: circle,
      markerDiameterMm: diameter,
    };
    this.state.status = `Calibrated from marker: ${(diameter / (2 * circle.radius)).toFixed(4)} mm/px${det ? '' : ' (edge not detected — used your clicks)'}.`;
    this.redetectAll();
  }

  calibrateLine(a: Vec2, b: Vec2, mm: number): void {
    if (!mm || mm <= 0) {
      this.state.status = 'Enter the known length in mm in the Calibration panel, then try again.';
      return;
    }
    const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
    this.state.case.calibration = { method: 'line', mmPerPx: mm / lenPx, line: [a, b], lineLengthMm: mm };
    this.state.status = `Calibrated from line: ${(mm / lenPx).toFixed(4)} mm/px.`;
    this.redetectAll();
  }

  setSpacingCalibration(pixelSpacingMm: number, magnification: number): void {
    this.state.case.calibration = {
      method: 'spacing',
      mmPerPx: pixelSpacingMm / magnification,
      pixelSpacingMm,
      magnification,
    };
    this.redetectAll();
    this.recompute();
  }

  setManualCalibration(mmPerPx: number): void {
    this.state.case.calibration = { method: 'manual', mmPerPx };
    this.redetectAll();
    this.recompute();
  }

  /** Re-run canal detection (scale-dependent search windows) after calibration changes. */
  redetectAll(): void {
    for (const side of ['R', 'L'] as const) {
      if (this.landmarks(side).canalSeeds) this.detectCanal(side);
    }
  }
}

/** The point that represents a landmark (same convention as `proposals`). */
export function finalPoint(l: SideLandmarks, key: LandmarkKey): Vec2 | undefined {
  switch (key) {
    case 'head':
      return l.head?.center;
    case 'canal':
      return l.canalSeeds?.[0];
    case 'teardrop':
      return l.teardrop;
    case 'lesserTrochanter':
      return l.lesserTrochanter;
    case 'acetabularEdge':
      return l.acetabularEdge;
    case 'greaterTrochanter':
      return l.greaterTrochanter;
  }
}
