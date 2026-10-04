/**
 * Implant template library.
 *
 * Stems are defined the way manufacturers publish them in the surgical
 * technique "technical specifications" tables, and the 2D template outline is
 * generated from those numbers:
 *
 *   per size:  stem length, ML width at resection, ML width distal
 *   per neck:  offset, neck length and leg length (with the 0 mm head)
 *   family:    neck-shaft angle
 *
 * Stem-local coordinates (mm):
 *   - origin: on the stem axis, level with the resection reference (the level
 *     that stem length and leg length are measured from)
 *   - x (m): distance MEDIAL from the stem axis (positive towards the head)
 *   - y (d): distance DISTAL along the stem axis (positive towards the tip)
 *
 * So the 0-head centre of a neck option sits at (offset, -legLength).
 */
import type { Vec2 } from '../geometry/vec';

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
  /** "Leg length": height of the head centre (0 mm head) above the resection level, mm. */
  height: number;
  /** Neck length along the neck axis to the head centre (0 mm head), mm. Used for drawing. */
  neckLength?: number;
  /** Neck-shaft angle in degrees. */
  neckShaftAngle: number;
}

/** One row of a manufacturer's stem dimension table (all mm, 0 mm head). */
export interface StemSizeSpec {
  size: string;
  length: number;
  mlResection: number;
  mlDistal: number;
  /** Neck options, e.g. standard and high offset. */
  necks: Array<{ id: string; label: string; offset: number; legLength: number; neckLength?: number }>;
}

export interface StemSize {
  size: string;
  /** Half-width profile used for canal fit, proximal → distal. */
  profile: StemProfilePoint[];
  /** Height of the lateral shoulder above the resection level (mm). */
  shoulderHeight: number;
  offsets: StemOffsetOption[];
  /** The dimension-table row this size was generated from, if any. */
  spec?: StemSizeSpec;
}

export interface StemFamily {
  id: string;
  name: string;
  fixation: 'cementless' | 'cemented';
  sizes: StemSize[];
  /** Modular head length adjustments along the neck axis (mm). Templating uses 0. */
  headLengths: number[];
  neckShaftAngle?: number;
  /** Fraction of the ML width at resection lying lateral to the stem axis. */
  lateralFraction?: number;
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

// ------------------------------------------------------------------ generator

/** Level (fraction of stem length) at which "ML distal" is measured. */
const DISTAL_LEVEL = 0.8;
const DEFAULT_LATERAL_FRACTION = 0.3;

/**
 * Generate the 2D template (fit profile) for one size from its table row.
 *
 * Shape model of a tapered-wedge stem in the AP plane:
 *  - lateral border: straight taper from the resection level to the distal
 *    measuring level, then a short rounded tip
 *  - medial border: the mirror of the lateral taper plus a calcar flare that
 *    fades out over the proximal 40 % of the stem
 * The widths at resection and at the distal level match the table exactly.
 */
export function buildStemSize(spec: StemSizeSpec, neckShaftAngle: number, lateralFraction = DEFAULT_LATERAL_FRACTION): StemSize {
  const L = spec.length;
  const dDist = DISTAL_LEVEL * L;
  const halfDist = spec.mlDistal / 2;
  const latRes = Math.max(halfDist, lateralFraction * spec.mlResection);
  const medRes = spec.mlResection - latRes;
  const dFlare = 0.45 * L;
  const lateralAt = (d: number): number => {
    if (d <= dDist) return latRes + (halfDist - latRes) * (d / dDist);
    const t = (d - dDist) / (L - dDist);
    return halfDist * Math.sqrt(Math.max(0, 1 - t * t * 0.85));
  };
  const medialAt = (d: number): number => {
    if (d > dDist) return lateralAt(d);
    const taper = latRes + (halfDist - latRes) * (d / dDist);
    const flare = d < dFlare ? (medRes - latRes) * (1 - d / dFlare) ** 2 : 0;
    return taper + flare;
  };
  const profile: StemProfilePoint[] = [];
  for (let d = 0; d < L; d += 2) profile.push({ d, medial: medialAt(d), lateral: lateralAt(d) });
  for (const d of [L - 1, L - 0.4, L]) profile.push({ d, medial: medialAt(d), lateral: lateralAt(d) });
  const std = spec.necks[0];
  return {
    size: spec.size,
    profile,
    shoulderHeight: Math.max(10, 0.6 * std.legLength),
    offsets: spec.necks.map((n) => ({
      id: n.id,
      label: n.label,
      offset: n.offset,
      height: n.legLength,
      neckLength: n.neckLength,
      neckShaftAngle,
    })),
    spec,
  };
}

export function buildStemFamily(
  id: string,
  name: string,
  neckShaftAngle: number,
  specs: StemSizeSpec[],
  lateralFraction = DEFAULT_LATERAL_FRACTION,
): StemFamily {
  return {
    id,
    name,
    fixation: 'cementless',
    neckShaftAngle,
    lateralFraction,
    headLengths: [0],
    sizes: specs.map((s) => buildStemSize(s, neckShaftAngle, lateralFraction)),
  };
}

// ------------------------------------------------------------------ tables

/** Column order used by the table import and the built-in data. */
export const STEM_TABLE_COLUMNS = [
  'size',
  'length',
  'mlResection',
  'mlDistal',
  'stdOffset',
  'stdNeckLength',
  'stdLegLength',
  'highOffset',
  'highNeckLength',
  'highLegLength',
] as const;

/**
 * CATALYSTEM tapered-wedge stem, 131° neck-shaft angle, standard and high
 * offset necks, from the surgical technique's technical specifications
 * (0 mm head). Columns as STEM_TABLE_COLUMNS.
 */
const CATALYSTEM: number[][] = [
  [0, 93, 25, 7, 32, 28, 26, 38, 32, 26],
  [1, 95, 25, 8, 32, 28, 26, 38, 32, 26],
  [2, 97, 26, 8, 33, 29, 27, 39, 33, 27],
  [3, 99, 27, 9, 33, 30, 28, 40, 34, 28],
  [4, 101, 28, 10, 34, 30, 28, 40, 34, 28],
  [5, 103, 29, 11, 35, 31, 29, 41, 35, 29],
  [6, 105, 31, 12, 36, 31, 29, 42, 35, 29],
  [7, 107, 32, 12, 38, 32, 30, 46, 37, 30],
  [8, 109, 33, 13, 39, 33, 31, 47, 38, 31],
  [9, 111, 35, 14, 41, 34, 31, 49, 39, 31],
  [10, 113, 36, 15, 42, 35, 32, 50, 40, 32],
  [11, 115, 37, 16, 43, 36, 33, 51, 41, 33],
  [12, 117, 39, 17, 44, 36, 34, 52, 42, 34],
];

export function specsFromRows(rows: Array<Array<string | number>>): StemSizeSpec[] {
  return rows.map((r) => {
    const n = (i: number): number => Number(r[i]);
    const spec: StemSizeSpec = {
      size: String(r[0]).trim(),
      length: n(1),
      mlResection: n(2),
      mlDistal: n(3),
      necks: [{ id: 'std', label: 'Standard offset', offset: n(4), neckLength: n(5) || undefined, legLength: n(6) }],
    };
    if (r.length >= 10 && r[7] !== '' && Number.isFinite(n(7))) {
      spec.necks.push({ id: 'high', label: 'High offset', offset: n(7), neckLength: n(8) || undefined, legLength: n(9) });
    }
    return spec;
  });
}

/**
 * Parse a pasted dimension table (CSV or tab-separated, e.g. copied from a
 * spreadsheet). A header row is optional. Throws with a readable message.
 */
export function parseStemTable(text: string): StemSizeSpec[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = lines.map((l) => l.split(/\t|,|;/).map((c) => c.trim()));
  const data = rows.filter((r) => r.slice(1).some((c) => c !== '') && Number.isFinite(Number(r[1])));
  if (data.length === 0) throw new Error('No size rows found. Each row needs: size, length, ML at resection, ML distal, std offset, std neck length, std leg length[, high offset, high neck length, high leg length].');
  data.forEach((r, i) => {
    if (r.length < 7) throw new Error(`Row ${i + 1} (size ${r[0]}) has ${r.length} columns; at least 7 are needed.`);
    for (const k of [1, 2, 3, 4, 6]) {
      if (!(Number(r[k]) > 0)) throw new Error(`Row ${i + 1} (size ${r[0]}): "${STEM_TABLE_COLUMNS[k]}" must be a positive number.`);
    }
  });
  return specsFromRows(data);
}

export function specsToTable(specs: StemSizeSpec[]): string {
  const head = STEM_TABLE_COLUMNS.join('\t');
  const body = specs.map((s) => {
    const std = s.necks[0];
    const high = s.necks[1];
    return [s.size, s.length, s.mlResection, s.mlDistal, std.offset, std.neckLength ?? '', std.legLength, high?.offset ?? '', high?.neckLength ?? '', high?.legLength ?? ''].join('\t');
  });
  return [head, ...body].join('\n');
}

function genericShell(): CupFamily {
  const sizes: CupSize[] = [];
  for (let od = 44; od <= 66; od += 2) {
    sizes.push({ outerDiameter: od, maxHeadDiameter: od <= 46 ? 28 : od <= 50 ? 32 : 36 });
  }
  return {
    id: 'generic-hemi-shell',
    name: 'Hemispherical shell (press-fit)',
    fixation: 'cementless',
    sizes,
  };
}

export const DEFAULT_STEM_ID = 'catalystem';

export const DEFAULT_LIBRARY: ImplantLibrary = {
  stems: [buildStemFamily(DEFAULT_STEM_ID, 'CATALYSTEM (131°)', 131, specsFromRows(CATALYSTEM))],
  cups: [genericShell()],
};

// ------------------------------------------------------------------ geometry helpers

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

/** 0-head centre of a neck option in stem-local coordinates. */
export function neckHeadCenter(o: StemOffsetOption): Vec2 {
  return { x: o.offset, y: -o.height };
}

/** Validate and normalise a user-supplied library (JSON). Throws on bad input. */
export function parseLibrary(json: unknown): ImplantLibrary {
  type FamilyInput = StemFamily & { specs?: StemSizeSpec[] };
  const lib = json as { stems: FamilyInput[]; cups: CupFamily[] };
  if (!lib || !Array.isArray(lib.stems) || !Array.isArray(lib.cups)) {
    throw new Error('Library must contain "stems" and "cups" arrays');
  }
  const stems = lib.stems.map((s): StemFamily => {
    if (!s.id) throw new Error('Every stem family needs an "id"');
    // Table form: { id, name, neckShaftAngle, specs: StemSizeSpec[] }
    if (Array.isArray(s.specs)) return buildStemFamily(s.id, s.name ?? s.id, s.neckShaftAngle ?? 131, s.specs, s.lateralFraction);
    if (!Array.isArray(s.sizes) || s.sizes.length === 0) throw new Error(`Stem family ${s.id} has no sizes`);
    s.headLengths = [0];
    s.sizes = s.sizes.map((z) => {
      if (z.spec) return buildStemSize(z.spec, s.neckShaftAngle ?? z.offsets?.[0]?.neckShaftAngle ?? 131, s.lateralFraction);
      if (!Array.isArray(z.profile) || z.profile.length < 2) throw new Error(`Stem ${s.id} size ${z.size}: profile needs >= 2 points`);
      z.profile.sort((a, b) => a.d - b.d);
      if (!Array.isArray(z.offsets) || z.offsets.length === 0) throw new Error(`Stem ${s.id} size ${z.size}: no offset options`);
      return z;
    });
    return s;
  });
  for (const c of lib.cups) {
    if (!c.id || !Array.isArray(c.sizes) || c.sizes.length === 0) throw new Error(`Cup family ${c.id ?? '?'} has no sizes`);
    c.sizes.sort((a, b) => a.outerDiameter - b.outerDiameter);
  }
  return { stems, cups: lib.cups };
}
