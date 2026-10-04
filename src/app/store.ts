import type { Vec2 } from '../geometry/vec';
import type { LoadedImage } from '../imaging/load';
import { detectCanal, detectFemoralHead } from '../imaging/detect';
import { type CaseData, type Side, type SideLandmarks, emptyCase } from '../planning/types';
import { type PlanResult, buildPlan } from '../planning/plan';
import { type ImplantLibrary, DEFAULT_LIBRARY } from '../planning/implants';
import { measure, type Measurements } from '../planning/measure';
import { type Step, STEPS, stepSide } from './steps';

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
}

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
    this.state.plan = c.calibration ? buildPlan(c, this.state.library) : null;
    this.emit();
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
