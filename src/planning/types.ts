import type { Vec2 } from '../geometry/vec';
import type { Circle } from '../geometry/fit';
import type { CanalDetection } from '../imaging/detect';

export type Side = 'R' | 'L';

export const otherSide = (s: Side): Side => (s === 'R' ? 'L' : 'R');

export type CalibrationMethod = 'marker' | 'line' | 'spacing' | 'manual';

export interface Calibration {
  method: CalibrationMethod;
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
  /** Additional leg-length change requested on top of the LLD correction (mm, + = lengthen). */
  extraLengthening: number;
  /** Whether to correct the measured LLD at all. */
  correctLLD: boolean;
  /** Manual overrides (null = automatic). */
  cupSizeOverride: number | null;
  stemSizeOverride: string | null;
  offsetOverride: string | null;
  headLengthOverride: number | null;
}

export const DEFAULT_OPTIONS: PlanOptions = {
  stemFamilyId: 'generic-taper-wedge',
  cupFamilyId: 'generic-hemi-shell',
  cupInclination: 40,
  cupOversize: 4,
  cupMedialWallOffset: 2,
  cupPlacement: 'teardrop',
  extraLengthening: 0,
  correctLLD: true,
  cupSizeOverride: null,
  stemSizeOverride: null,
  offsetOverride: null,
  headLengthOverride: null,
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
