import type { AppState } from '../app/store';
import type { SideMeasurements } from '../planning/measure';

const f1 = (v: number | undefined, unit = ' mm'): string => (v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(1)}${unit}`);
const signed = (v: number | undefined, unit = ' mm'): string => (v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}${unit}`);
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const sideName = (s: 'R' | 'L'): string => (s === 'R' ? 'Right' : 'Left');

export function renderResults(s: AppState): string {
  const m = s.measurements;
  const p = s.plan;
  if (!s.image) return '<p class="hint">Open an image to begin.</p>';
  if (!s.case.calibration) return '<p class="hint">Calibrate the image (marker ball, known length, DICOM spacing or manual scale).</p>';
  if (!m) return '<p class="hint">Place both teardrops to establish the pelvic reference line.</p>';

  const out: string[] = [];
  if (p?.missing.length) out.push(`<div class="missing">To complete the plan, place: ${p.missing.map(esc).join(', ')}.</div>`);

  if (p?.cup || p?.stem) {
    out.push('<div class="big">');
    if (p.cup) {
      out.push(`<div class="card cup"><div class="t">Cup</div><div class="v">${p.cup.size.outerDiameter} mm</div>
        <div class="s">${p.cup.inclination}° · ${p.cup.bearingDiameter} mm head</div></div>`);
    }
    if (p.stem) {
      const c = p.stem.chosen;
      out.push(`<div class="card stem"><div class="t">Stem</div><div class="v">Size ${esc(c.size.size)}</div>
        <div class="s">${esc(c.offset.label)} · head ${c.headLength >= 0 ? '+' : ''}${c.headLength}</div></div>`);
    }
    out.push('</div>');
  }

  if (p?.stem && p.predictedLegLengthChange !== undefined) {
    const llErr = p.predictedLegLengthChange - p.targetLegLengthChange;
    const offErr = (p.predictedOffsetChange ?? 0) - p.targetOffsetChange;
    const cls = (e: number, tol: number) => (Math.abs(e) <= tol ? 'delta-ok' : 'delta-warn');
    out.push('<h3>Predicted reconstruction</h3><table class="kv">');
    out.push(row('Leg length change', `<span class="${cls(llErr, 3)}">${signed(p.predictedLegLengthChange)}</span> (target ${signed(p.targetLegLengthChange)})`));
    out.push(row('Global offset change', `<span class="${cls(offErr, 4)}">${signed(p.predictedOffsetChange)}</span> (target ${signed(p.targetOffsetChange)})`));
    out.push(row('Neck cut above LT', f1(p.stem.resectionAboveLT)));
    if (p.corShift) {
      out.push(row('COR shift', `${p.corShift.x <= 0 ? 'medial' : 'lateral'} ${Math.abs(p.corShift.x).toFixed(1)}, ${p.corShift.y <= 0 ? 'inferior' : 'superior'} ${Math.abs(p.corShift.y).toFixed(1)} mm`));
    }
    if (p.cup?.lateralUncoverage !== undefined) {
      const u = p.cup.lateralUncoverage;
      out.push(row('Lateral cup uncoverage', u > 0 ? `<span class="${u > 8 ? 'delta-warn' : ''}">${u.toFixed(1)} mm</span>` : 'covered'));
    }
    out.push('</table>');

    if (p.stem.fill.length) {
      out.push('<h3>Canal fill (stem / endosteal width)</h3><table class="kv">');
      for (const f of p.stem.fill) {
        out.push(row(`${f.d.toFixed(0)} mm below cut`, `${f.stemWidth.toFixed(1)} / ${f.canalWidth.toFixed(1)} mm · ${(f.fill * 100).toFixed(0)}%`));
      }
      out.push('</table>');
    }
    if (p.stem.alternatives.length) {
      out.push('<h3>Alternatives</h3><table class="kv">');
      for (const a of p.stem.alternatives) {
        out.push(row(`Size ${esc(a.size.size)} ${esc(a.offset.id)} ${a.headLength >= 0 ? '+' : ''}${a.headLength}`, `LL ${signed(a.legLengthChange)}, off ${signed(a.offsetChange)}`));
      }
      out.push('</table>');
    }
  }

  out.push('<h3>Pre-operative measurements</h3><table class="kv">');
  out.push(row('Leg length difference', m.legLengthDifference === undefined ? '—' : `${Math.abs(m.legLengthDifference).toFixed(1)} mm ${m.legLengthDifference < 0 ? 'short' : m.legLengthDifference > 0 ? 'long' : ''} (op. side)`));
  out.push(row('Pelvic obliquity', f1(m.obliquity, '°')));
  out.push(row('Inter-teardrop distance', f1(m.interTeardropDistance)));
  out.push('</table>');
  out.push(sideTable('Operative', m.op));
  out.push(sideTable('Contralateral', m.contra));

  const warnings = [...(p?.warnings ?? m.warnings)];
  for (const w of warnings) out.push(`<div class="warn">${esc(w)}</div>`);
  out.push('<p class="disclaimer">Research / educational tool — not a medical device. Generic implant dimensions; load vendor templates before clinical use and verify every plan.</p>');
  return out.join('');
}

function sideTable(title: string, sm: SideMeasurements): string {
  return `<h3>${title} (${sideName(sm.side)})</h3><table class="kv">
    ${row('Head diameter', f1(sm.headDiameter))}
    ${row('COR height above teardrops', f1(sm.corHeight))}
    ${row('Acetabular offset', f1(sm.acetabularOffset))}
    ${row('Femoral offset', f1(sm.femoralOffset))}
    ${row('Global offset', f1(sm.globalOffset))}
    ${row('LT below teardrop line', f1(sm.ltBelowLine))}
    ${row('Canal isthmus width', f1(sm.canalIsthmusWidth))}
    ${row('Femoral shaft angle', f1(sm.femoralAxisAngle, '°'))}
  </table>`;
}

function row(k: string, v: string): string {
  return `<tr><td class="k">${k}</td><td>${v}</td></tr>`;
}
