import type { Vec2 } from '../geometry/vec';
import type { Circle } from '../geometry/fit';
import type { CanalDetection } from '../imaging/detect';

export type Side = 'R' | 'L';

export const otherSide = (s: Side): Side => (s === 'R' ? 'L' : 'R');

export type CalibrationMethod = 'marker' | 'line' | 'spacing' | 'manual';

export interface Calibration {
  method: CalibrationMethod;
  /** Proposed automatically (marker found) and not yet confirmed by the user. */
  proposed?: boolean;
  /** Final scale in millimetres per image pixel (at the plane of the hip). */
  mmPerPx: number;
  /** Marker ball circle in px (method 'marker'). */
  marker?: Circle;
  markerDiameterMm?: number;
  /** Line endpoints in px and real length (method 'line'). */
  line?: [Vec2, Vec2];
  lineLengthMm?: number;
  /** Detector pixel spacing in mm (from DICOM) and assumed magnification (method 'spacing'). */
  pixelSpacingMm?: number;
  magnification?: number;
}

/** Per-side anatomical landmarks, all in image pixel coordinates. */
export interface SideLandmarks {
  /** Inferior tip of the radiographic teardrop. */
  teardrop?: Vec2;
  /** Most prominent point of the lesser trochanter. */
  lesserTrochanter?: Vec2;
  /** Tip of the greater trochanter (optional, for reporting). */
  greaterTrochanter?: Vec2;
  /** Superolateral edge of the acetabular sourcil (optional, for cup coverage). */
  acetabularEdge?: Vec2;
  /** Femoral head contour. */
  head?: Circle;
  /** Two seed points inside the medullary canal (proximal, distal). */
  canalSeeds?: [Vec2, Vec2];
  /** Result of automatic canal detection (cached, derived from seeds). */
  canal?: CanalDetection;
  /** Review state per landmark: auto-proposed points wait for the user's OK. */
  status?: Partial<Record<LandmarkKey, LandmarkStatus>>;
  /**
   * Where the automatic detector originally proposed each point (image px;
   * head centre, proximal canal seed). Comparing it with the confirmed
   * position measures the detector's error on this film.
   */
  proposals?: Partial<Record<LandmarkKey, Vec2>>;
}

export type LandmarkKey = 'teardrop' | 'lesserTrochanter' | 'greaterTrochanter' | 'acetabularEdge' | 'head' | 'canal';
export type LandmarkStatus = 'proposed' | 'confirmed';

/**
 * Manual stem placement in the femoral frame: the stem axis origin (resection
 * level) sits `shift` mm medial of the femoral axis and `depth` mm below the
 * LT level, rotated `tilt` degrees (positive = varus, tip moving laterally).
 */
export interface StemPose {
  depth: number;
  shift: number;
  tilt: number;
}

/**
 * A reconstruction goal. 'match' = equal to the contralateral side (plus `mm`
 * if non-zero); 'change' = change the operative side by `mm` (+ = longer /
 * more offset).
 */
export interface Goal {
  mode: 'match' | 'change';
  mm: number;
}

export interface PlanOptions {
  stemFamilyId: string;
  cupFamilyId: string;
  /** Target cup abduction / inclination angle (deg). */
  cupInclination: number;
  /** Cup outer diameter = acetabular diameter estimate rounded up; added to head diameter (mm). */
  cupOversize: number;
  /** Extra lateral shift of the cup's medial wall from the teardrop (mm). */
  cupMedialWallOffset: number;
  /** Cup placement strategy. */
  cupPlacement: 'teardrop' | 'native';
  /** Leg-length goal: equalise with the contralateral side, or change by a set amount. */
  legLengthGoal: Goal;
  /** Offset goal: match the contralateral global offset, or change by a set amount. */
  offsetGoal: Goal;
  /**
   * Automatic stem orientation: 'pelvis' = template upright to the
   * inter-teardrop line; 'canal' = along the femoral anatomical axis.
   */
  stemAlignment: 'pelvis' | 'canal';
  /** Manual overrides (null = automatic). */
  cupSizeOverride: number | null;
  stemSizeOverride: string | null;
  offsetOverride: string | null;
  /** Prosthetic femoral head diameter (mm); null = largest the cup accepts. */
  headDiameter: number | null;
  /** Manual stem position; null = automatic fit-and-fill seating. */
  stemPose: StemPose | null;
  /** Manual cup centre in the pelvic frame (mm); null = automatic placement. */
  cupCenter: Vec2 | null;
}

export const DEFAULT_OPTIONS: PlanOptions = {
  stemFamilyId: 'catalystem',
  cupFamilyId: 'generic-hemi-shell',
  cupInclination: 40,
  cupOversize: 4,
  cupMedialWallOffset: 2,
  cupPlacement: 'teardrop',
  legLengthGoal: { mode: 'match', mm: 0 },
  offsetGoal: { mode: 'match', mm: 0 },
  stemAlignment: 'canal',
  cupSizeOverride: null,
  stemSizeOverride: null,
  offsetOverride: null,
  headDiameter: null,
  stemPose: null,
  cupCenter: null,
};

export interface CaseData {
  operativeSide: Side;
  /**
   * True when the patient's right side appears on the viewer's left
   * (standard radiographic display convention).
   */
  standardOrientation: boolean;
  calibration?: Calibration;
  landmarks: Record<Side, SideLandmarks>;
  options: PlanOptions;
}

export function emptyCase(): CaseData {
  return {
    operativeSide: 'R',
    standardOrientation: true,
    landmarks: { R: {}, L: {} },
    options: { ...DEFAULT_OPTIONS },
  };
}
