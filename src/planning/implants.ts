/**
 * Implant template library.
 *
 * The bundled library is GENERIC: dimensions are representative of a
 * collarless tapered-wedge cementless stem and a hemispherical press-fit
 * shell, chosen to be anatomically plausible. They are NOT any
 * manufacturer's specifications. For clinical use, replace them with the
 * vendor's published template dimensions (see `parseLibrary`).
 *
 * Stem-local coordinates (mm):
 *   - origin: the point on the stem axis level with the medial neck-cut
 *     (resection) point
 *   - d: distance DISTAL along the stem axis (positive = towards the tip)
 *   - m: distance MEDIAL from the stem axis (positive = towards the head)
 */

export interface StemProfilePoint {
  /** Distal distance from the resection level (mm). */
  d: number;
  /** Medial half-width at this level (mm from axis). */
  medial: number;
  /** Lateral half-width at this level (mm from axis). */
  lateral: number;
}

export interface StemOffsetOption {
  id: string;
  label: string;
  /** Horizontal distance from stem axis to head centre (0 mm head), mm. */
  offset: number;
  /** Height of head centre (0 mm head) above the resection level, mm. */
  height: number;
  /** Neck-shaft angle in degrees. */
  neckShaftAngle: number;
}

export interface StemSize {
  size: string;
  profile: StemProfilePoint[];
  /** Height of the lateral shoulder above the resection level (mm). */
  shoulderHeight: number;
  offsets: StemOffsetOption[];
}

export interface StemFamily {
  id: string;
  name: string;
  fixation: 'cementless' | 'cemented';
  sizes: StemSize[];
  /** Available modular head length adjustments along the neck axis (mm). */
  headLengths: number[];
}

export interface CupSize {
  /** Outer shell diameter (mm). */
  outerDiameter: number;
  /** Largest bearing (head) diameter supported by this shell (mm). */
  maxHeadDiameter: number;
}

export interface CupFamily {
  id: string;
  name: string;
  fixation: 'cementless' | 'cemented';
  sizes: CupSize[];
}

export interface ImplantLibrary {
  stems: StemFamily[];
  cups: CupFamily[];
}

function genericTaperedWedge(): StemFamily {
  const sizes: StemSize[] = [];
  for (let i = 0; i < 12; i++) {
    const length = 110 + 4 * i;
    // Total mediolateral width at each level; the proximal medial side flares
    // into the calcar curve, the lateral border is nearly straight.
    const levels: Array<[number, number, number]> = [
      // d, medial half-width, lateral half-width
      [0, 13 + 0.6 * i, 7 + 0.35 * i],
      [10, 10.2 + 0.55 * i, 6.6 + 0.33 * i],
      [20, 8.4 + 0.55 * i, 6.2 + 0.32 * i],
      [40, 6.4 + 0.47 * i, 5.4 + 0.3 * i],
      [60, 5.2 + 0.42 * i, 4.8 + 0.28 * i],
      [80, 4.5 + 0.38 * i, 4.3 + 0.26 * i],
      [length - 8, 3.9 + 0.3 * i, 3.8 + 0.25 * i],
      [length, 2.2 + 0.15 * i, 2.2 + 0.15 * i],
    ];
    sizes.push({
      size: String(i + 1),
      profile: levels.map(([d, medial, lateral]) => ({ d, medial, lateral })),
      shoulderHeight: 12 + 0.4 * i,
      offsets: [
        {
          id: 'std',
          label: 'Standard offset',
          offset: 37 + 0.8 * i,
          height: 36 + 0.6 * i,
          neckShaftAngle: 132,
        },
        {
          id: 'high',
          label: 'High offset',
          offset: 44 + 0.8 * i,
          height: 36 + 0.6 * i,
          neckShaftAngle: 132,
        },
      ],
    });
  }
  return {
    id: 'generic-taper-wedge',
    name: 'Generic tapered-wedge stem (cementless)',
    fixation: 'cementless',
    sizes,
    headLengths: [-3.5, 0, 3.5, 7],
  };
}

function genericShell(): CupFamily {
  const sizes: CupSize[] = [];
  for (let od = 44; od <= 66; od += 2) {
    sizes.push({ outerDiameter: od, maxHeadDiameter: od <= 46 ? 28 : od <= 50 ? 32 : 36 });
  }
  return {
    id: 'generic-hemi-shell',
    name: 'Generic hemispherical shell (press-fit)',
    fixation: 'cementless',
    sizes,
  };
}

export const DEFAULT_LIBRARY: ImplantLibrary = {
  stems: [genericTaperedWedge()],
  cups: [genericShell()],
};

/** Half-widths of a stem at distal distance d (linear interpolation; null outside). */
export function stemWidthAt(size: StemSize, d: number): { medial: number; lateral: number } | null {
  const p = size.profile;
  if (d < p[0].d || d > p[p.length - 1].d) return null;
  for (let i = 1; i < p.length; i++) {
    if (d <= p[i].d) {
      const a = p[i - 1];
      const b = p[i];
      const t = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
      return {
        medial: a.medial + (b.medial - a.medial) * t,
        lateral: a.lateral + (b.lateral - a.lateral) * t,
      };
    }
  }
  return null;
}

export function stemLength(size: StemSize): number {
  return size.profile[size.profile.length - 1].d;
}

/** Validate and normalise a user-supplied library (JSON). Throws on bad input. */
export function parseLibrary(json: unknown): ImplantLibrary {
  const lib = json as ImplantLibrary;
  if (!lib || !Array.isArray(lib.stems) || !Array.isArray(lib.cups)) {
    throw new Error('Library must contain "stems" and "cups" arrays');
  }
  for (const s of lib.stems) {
    if (!s.id || !Array.isArray(s.sizes) || s.sizes.length === 0) throw new Error(`Stem family ${s.id ?? '?'} has no sizes`);
    if (!Array.isArray(s.headLengths) || s.headLengths.length === 0) s.headLengths = [0];
    for (const z of s.sizes) {
      if (!Array.isArray(z.profile) || z.profile.length < 2) throw new Error(`Stem ${s.id} size ${z.size}: profile needs >= 2 points`);
      z.profile.sort((a, b) => a.d - b.d);
      if (!Array.isArray(z.offsets) || z.offsets.length === 0) throw new Error(`Stem ${s.id} size ${z.size}: no offset options`);
    }
  }
  for (const c of lib.cups) {
    if (!c.id || !Array.isArray(c.sizes) || c.sizes.length === 0) throw new Error(`Cup family ${c.id ?? '?'} has no sizes`);
    c.sizes.sort((a, b) => a.outerDiameter - b.outerDiameter);
  }
  return lib;
}
