/**
 * The case summary box drawn on top of the image (and into exports):
 * cup size, stem size, pre-/post-operative leg-length difference and
 * pre-/post-operative offset difference.
 *
 * Sign convention (operative side relative to the other side):
 *   LLD     − = operative leg shorter, + = longer
 *   Offset  − = less offset on the operative side, + = more
 */
import type { AppState } from '../app/store';

export interface SummaryRow {
  label: string;
  value: string;
  /** 'ok' | 'warn' colours the value; undefined = neutral. */
  state?: 'ok' | 'warn';
}

const signed = (v: number | undefined): string => {
  if (v === undefined || Number.isNaN(v)) return '—';
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0 mm';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} mm`;
};

export function summaryRows(s: AppState): SummaryRow[] {
  const m = s.measurements;
  const p = s.plan;
  const ctOffset = m?.contra.globalOffset;
  const preOff = m?.op.globalOffset !== undefined && ctOffset !== undefined ? m.op.globalOffset - ctOffset : undefined;
  const postOff = p?.postopGlobalOffset !== undefined && ctOffset !== undefined ? p.postopGlobalOffset - ctOffset : undefined;
  const postLLD = p?.postopLegLengthDifference;
  const judge = (v: number | undefined, tol: number): 'ok' | 'warn' | undefined => (v === undefined ? undefined : Math.abs(v) <= tol ? 'ok' : 'warn');
  const stem = p?.stem ? `${p.stem.chosen.size.size} ${p.stem.chosen.offset.id === 'high' ? 'high offset' : 'standard'}` : '—';
  return [
    { label: 'Cup size', value: p?.cup ? `${p.cup.size.outerDiameter} mm` : '—' },
    { label: 'Stem size', value: stem },
    { label: 'Pre-op LLD', value: signed(m?.legLengthDifference) },
    { label: 'Pre-op offset', value: signed(preOff) },
    { label: 'Post-op LLD', value: signed(postLLD), state: judge(postLLD, 2) },
    { label: 'Post-op offset', value: signed(postOff), state: judge(postOff, 3) },
  ];
}

/**
 * Draw the summary box with its top edge centred at (cx, top), in the
 * context's current coordinates. `u` is the size of one CSS pixel.
 * Returns the box rectangle.
 */
export function drawSummary(ctx: CanvasRenderingContext2D, s: AppState, cx: number, top: number, u: number): { x: number; y: number; w: number; h: number } {
  const rows = summaryRows(s);
  const pad = 12 * u;
  const rowH = 21 * u;
  const titleH = 22 * u;
  const colGap = 18 * u;
  ctx.save();
  ctx.font = `500 ${13 * u}px system-ui, sans-serif`;
  const labelW = Math.max(...rows.map((r) => ctx.measureText(r.label).width));
  ctx.font = `700 ${14 * u}px system-ui, sans-serif`;
  const valueW = Math.max(...rows.map((r) => ctx.measureText(r.value).width), 90 * u);
  const w = pad * 2 + labelW + colGap + valueW;
  const h = pad * 2 + titleH + rows.length * rowH;
  const x = cx - w / 2;
  const y = top;

  ctx.fillStyle = 'rgba(13,17,23,0.9)';
  ctx.strokeStyle = 'rgba(199,125,255,0.85)';
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8 * u);
  ctx.fill();
  ctx.stroke();

  const side = s.case.operativeSide === 'R' ? 'Right' : 'Left';
  ctx.fillStyle = '#8b98a8';
  ctx.font = `600 ${11 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(`${side.toUpperCase()} THA PLAN`, x + pad, y + pad + titleH / 2 - 3 * u);

  rows.forEach((r, i) => {
    const ry = y + pad + titleH + i * rowH + rowH / 2;
    if (i === 2 || i === 4) {
      ctx.strokeStyle = 'rgba(139,152,168,0.25)';
      ctx.lineWidth = u;
      ctx.beginPath();
      ctx.moveTo(x + pad, ry - rowH / 2);
      ctx.lineTo(x + w - pad, ry - rowH / 2);
      ctx.stroke();
    }
    ctx.font = `500 ${13 * u}px system-ui, sans-serif`;
    ctx.fillStyle = '#c9d4df';
    ctx.textAlign = 'left';
    ctx.fillText(r.label, x + pad, ry);
    ctx.font = `700 ${14 * u}px system-ui, sans-serif`;
    ctx.fillStyle = r.state === 'ok' ? '#80ed99' : r.state === 'warn' ? '#ffbe0b' : '#e6edf3';
    ctx.textAlign = 'right';
    ctx.fillText(r.value, x + w - pad, ry);
  });
  ctx.restore();
  return { x, y, w, h };
}

/**
 * Implant legend in the top corner on the operative side: cup lines in the
 * cup colour, stem lines in the stem colour.
 */
export function drawLegend(
  ctx: CanvasRenderingContext2D,
  s: AppState,
  width: number,
  top: number,
  u: number,
  colors: { cup: string; stem: string },
  operativeOnLeft: boolean,
): void {
  const p = s.plan;
  if (!p?.cup && !p?.stem) return;
  const side = s.case.operativeSide === 'R' ? 'Right' : 'Left';
  const lines: Array<[string, string]> = [];
  if (p.cup) {
    lines.push([`${p.cup.family.name} (${side})`, colors.cup]);
    lines.push([`Size: ${p.cup.size.outerDiameter} mm · ${p.cup.inclination}°`, colors.cup]);
  }
  if (p.stem) {
    const ch = p.stem.chosen;
    lines.push([`${p.stem.family.name.replace(/\s*\(.*\)$/, '')} ${ch.offset.id === 'high' ? 'High' : 'Std'} Offset (${side})`, colors.stem]);
    lines.push([`Size: ${ch.size.size}`, colors.stem]);
    lines.push(['Head: +0', colors.stem]);
  }
  ctx.save();
  ctx.font = `700 ${15 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = operativeOnLeft ? 'left' : 'right';
  const x = operativeOnLeft ? 12 * u : width - 12 * u;
  lines.forEach(([text, color], i) => {
    const y = top + i * 19 * u;
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  });
  ctx.restore();
}
