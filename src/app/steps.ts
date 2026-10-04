import { type Side, otherSide } from '../planning/types';

export type StepKind = 'teardrop' | 'head' | 'lt' | 'canal' | 'acetEdge' | 'ilio' | 'sourcil' | 'gt';

export interface Step {
  id: string;
  kind: StepKind;
  /** 'op' = operative side, 'contra' = contralateral. */
  which: 'op' | 'contra';
  required: boolean;
  /** Number of clicks the tool needs. */
  clicks: number;
  title: string;
  hint: string;
}

export const STEPS: Step[] = [
  { id: 'td-op', kind: 'teardrop', which: 'op', required: true, clicks: 1, title: 'Teardrop', hint: 'Click the inferior tip of the radiographic teardrop.' },
  { id: 'td-contra', kind: 'teardrop', which: 'contra', required: true, clicks: 1, title: 'Teardrop', hint: 'Click the inferior tip of the radiographic teardrop.' },
  { id: 'head-op', kind: 'head', which: 'op', required: true, clicks: 1, title: 'Femoral head', hint: 'Click near the centre of the femoral head — the contour is detected automatically.' },
  { id: 'ilio-op', kind: 'ilio', which: 'op', required: true, clicks: 1, title: 'Ilioischial line', hint: 'Click the ilioischial (Köhler\'s) line at the level of the acetabulum — the cup\'s medial limit.' },
  { id: 'sourcil-op', kind: 'sourcil', which: 'op', required: true, clicks: 1, title: 'Sourcil', hint: 'Click the top of the sclerotic sourcil (superior acetabular rim) — the cup dome sits here.' },
  { id: 'edge-op', kind: 'acetEdge', which: 'op', required: true, clicks: 1, title: 'Lateral acetabular edge', hint: 'Click the lateral edge of the acetabulum (lateral end of the sourcil) — the cup\'s lateral limit.' },
  { id: 'lt-op', kind: 'lt', which: 'op', required: true, clicks: 1, title: 'Lesser trochanter', hint: 'Click the most prominent (medial) point of the lesser trochanter.' },
  { id: 'canal-op', kind: 'canal', which: 'op', required: true, clicks: 2, title: 'Femoral canal', hint: 'Click inside the canal at the lesser-trochanter level, then ~15 cm further down the shaft.' },
  { id: 'head-contra', kind: 'head', which: 'contra', required: false, clicks: 1, title: 'Femoral head', hint: 'Click near the centre of the contralateral femoral head.' },
  { id: 'lt-contra', kind: 'lt', which: 'contra', required: false, clicks: 1, title: 'Lesser trochanter', hint: 'Click the most prominent point of the contralateral lesser trochanter (needed for leg-length difference).' },
  { id: 'canal-contra', kind: 'canal', which: 'contra', required: false, clicks: 2, title: 'Femoral canal', hint: 'Contralateral canal: click at the LT level, then further down the shaft (needed for offset comparison).' },
  { id: 'gt-op', kind: 'gt', which: 'op', required: false, clicks: 1, title: 'Greater trochanter tip', hint: 'Click the tip of the greater trochanter (reported relative to the head centre).' },
];

export const stepSide = (s: Step, operative: Side): Side => (s.which === 'op' ? operative : otherSide(operative));

export function stepLabel(s: Step, operative: Side): string {
  const side = stepSide(s, operative);
  return `${s.title} (${side === 'R' ? 'right' : 'left'}${s.which === 'op' ? ', operative' : ''})`;
}
