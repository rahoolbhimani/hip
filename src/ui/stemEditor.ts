/**
 * Stem dimension-table editor: paste a manufacturer's table, preview the
 * generated template, save it as a stem family. Saved stems are kept in this
 * browser's local storage.
 */
import type { Store } from '../app/store';
import {
  type StemFamily,
  type StemSizeSpec,
  DEFAULT_LIBRARY,
  buildStemFamily,
  parseStemTable,
  specsToTable,
  stemLength,
  neckHeadCenter,
} from '../planning/implants';
import { stemOutlineLocal, neckCutLocal } from '../planning/plan';

const STORAGE_KEY = 'hip-templater.stems.v1';

interface StoredFamily {
  id: string;
  name: string;
  neckShaftAngle: number;
  specs: StemSizeSpec[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function loadStoredStems(): StemFamily[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredFamily[];
    return list.map((f) => buildStemFamily(f.id, f.name, f.neckShaftAngle, f.specs));
  } catch {
    return [];
  }
}

function persist(families: StemFamily[]): void {
  const builtIn = new Set(DEFAULT_LIBRARY.stems.map((s) => s.id));
  const stored: StoredFamily[] = families
    .filter((f) => !builtIn.has(f.id) || f !== DEFAULT_LIBRARY.stems.find((b) => b.id === f.id))
    .filter((f) => f.sizes.every((z) => z.spec))
    .map((f) => ({ id: f.id, name: f.name, neckShaftAngle: f.neckShaftAngle ?? 131, specs: f.sizes.map((z) => z.spec!) }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable: stems last for this session only */
  }
}

/** Merge stored stems into the library (stored versions replace built-ins with the same id). */
export function withStoredStems(families: StemFamily[]): StemFamily[] {
  const stored = loadStoredStems();
  return [...families.filter((f) => !stored.some((s) => s.id === f.id)), ...stored];
}

export class StemEditor {
  private editingId = '';
  private draft: StemFamily | null = null;

  constructor(
    private store: Store,
    private onChange: () => void,
  ) {
    $('se-close').addEventListener('click', () => this.close());
    $('stem-editor').addEventListener('click', (e) => {
      if (e.target === $('stem-editor')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('stem-editor').hidden) this.close();
    });
    $('se-family').addEventListener('change', () => this.load(($('se-family') as HTMLSelectElement).value));
    for (const id of ['se-table', 'se-ccd', 'se-name']) $(id).addEventListener('input', () => this.parse());
    $('se-preview-size').addEventListener('change', () => this.drawPreview());
    $('se-save').addEventListener('click', () => this.save());
    $('se-new').addEventListener('click', () => this.newStem());
    $('se-delete').addEventListener('click', () => this.remove());
  }

  open(): void {
    $('stem-editor').hidden = false;
    this.load(this.store.state.case.options.stemFamilyId);
  }

  close(): void {
    $('stem-editor').hidden = true;
  }

  private families(): StemFamily[] {
    return this.store.state.library.stems;
  }

  private fillFamilySelect(selected: string): void {
    const sel = $<HTMLSelectElement>('se-family');
    const fams = this.families();
    sel.innerHTML = fams.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    if (!fams.some((f) => f.id === selected)) sel.insertAdjacentHTML('beforeend', `<option value="${selected}">(new stem)</option>`);
    sel.value = selected;
  }

  private load(id: string): void {
    const fam = this.families().find((f) => f.id === id) ?? this.families()[0];
    this.editingId = fam.id;
    this.fillFamilySelect(fam.id);
    ($('se-name') as HTMLInputElement).value = fam.name;
    ($('se-ccd') as HTMLInputElement).value = String(fam.neckShaftAngle ?? fam.sizes[0].offsets[0].neckShaftAngle);
    const specs = fam.sizes.map((z) => z.spec).filter((x): x is StemSizeSpec => !!x);
    ($('se-table') as HTMLTextAreaElement).value = specs.length === fam.sizes.length ? specsToTable(specs) : '';
    ($('se-delete') as HTMLButtonElement).disabled = !loadStoredStems().some((f) => f.id === fam.id);
    this.parse();
  }

  private newStem(): void {
    this.editingId = `custom-${Date.now().toString(36)}`;
    this.fillFamilySelect(this.editingId);
    ($('se-name') as HTMLInputElement).value = 'New stem';
    ($('se-ccd') as HTMLInputElement).value = '131';
    ($('se-table') as HTMLTextAreaElement).value = specsToTable([]);
    ($('se-delete') as HTMLButtonElement).disabled = true;
    this.parse();
  }

  private parse(): void {
    const err = $('se-error');
    const name = ($('se-name') as HTMLInputElement).value.trim() || 'Unnamed stem';
    const ccd = Number(($('se-ccd') as HTMLInputElement).value);
    try {
      if (!(ccd > 100 && ccd < 150)) throw new Error('Neck-shaft angle should be between 100° and 150°.');
      const specs = parseStemTable(($('se-table') as HTMLTextAreaElement).value);
      this.draft = buildStemFamily(this.editingId, name, ccd, specs);
      err.hidden = true;
    } catch (e) {
      this.draft = null;
      err.textContent = (e as Error).message;
      err.hidden = false;
    }
    ($('se-save') as HTMLButtonElement).disabled = !this.draft;
    const sizeSel = $<HTMLSelectElement>('se-preview-size');
    const prev = sizeSel.value;
    const sizes = this.draft?.sizes ?? [];
    sizeSel.innerHTML = sizes.map((z) => `<option value="${escapeHtml(z.size)}">Size ${escapeHtml(z.size)}</option>`).join('');
    if (sizes.some((z) => z.size === prev)) sizeSel.value = prev;
    else if (sizes.length) sizeSel.value = sizes[Math.floor(sizes.length / 2)].size;
    this.drawPreview();
  }

  private drawPreview(): void {
    const canvas = $<HTMLCanvasElement>('se-preview');
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const size = this.draft?.sizes.find((z) => z.size === ($('se-preview-size') as HTMLSelectElement).value);
    if (!size) return;
    // Fit stem-local mm into the canvas (medial to the right).
    const len = stemLength(size);
    const top = -Math.max(...size.offsets.map((o) => o.height)) - 30;
    const k = Math.min((canvas.height - 40) / (len - top), (canvas.width - 40) / 110);
    const ox = canvas.width * 0.38;
    const oy = 20 - top * k;
    const P = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#2a3441';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(...P(0, top));
    ctx.lineTo(...P(0, len + 5));
    ctx.moveTo(...P(-30, 0));
    ctx.lineTo(...P(70, 0));
    ctx.stroke();
    ctx.setLineDash([]);

    size.offsets.forEach((off, i) => {
      const color = i === 0 ? '#c77dff' : '#4cc9f0';
      const poly = stemOutlineLocal(size, off);
      ctx.beginPath();
      poly.forEach((p, j) => (j ? ctx.lineTo(...P(p.x, p.y)) : ctx.moveTo(...P(p.x, p.y))));
      ctx.closePath();
      ctx.fillStyle = i === 0 ? 'rgba(199,125,255,0.14)' : 'rgba(76,201,240,0.06)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = i === 0 ? 2 : 1.2;
      ctx.setLineDash(i === 0 ? [] : [5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const hc = neckHeadCenter(off);
      ctx.beginPath();
      ctx.arc(...P(hc.x, hc.y), 14 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${off.label}: offset ${off.offset}, leg length ${off.height}`, 8, canvas.height - 26 + i * 14);
    });
    const [a, b] = neckCutLocal(size, size.offsets[0]);
    ctx.strokeStyle = '#ffbe0b';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(...P(a.x, a.y));
    ctx.lineTo(...P(b.x, b.y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8b98a8';
    ctx.fillText(`Size ${size.size} · length ${len} mm · resection level`, 8, 14);
  }

  private save(): void {
    if (!this.draft) return;
    const lib = this.store.state.library;
    const idx = lib.stems.findIndex((f) => f.id === this.draft!.id);
    if (idx >= 0) lib.stems[idx] = this.draft;
    else lib.stems.push(this.draft);
    persist(lib.stems);
    const o = this.store.state.case.options;
    o.stemFamilyId = this.draft.id;
    o.stemSizeOverride = null;
    o.offsetOverride = null;
    o.stemPose = null;
    this.store.state.status = `Saved stem "${this.draft.name}" (${this.draft.sizes.length} sizes) and selected it.`;
    this.load(this.draft.id);
    this.onChange();
  }

  private remove(): void {
    const lib = this.store.state.library;
    const builtIn = DEFAULT_LIBRARY.stems.find((s) => s.id === this.editingId);
    const idx = lib.stems.findIndex((f) => f.id === this.editingId);
    if (idx < 0) return;
    if (builtIn) lib.stems[idx] = builtIn;
    else lib.stems.splice(idx, 1);
    persist(lib.stems);
    const o = this.store.state.case.options;
    if (!lib.stems.some((f) => f.id === o.stemFamilyId)) o.stemFamilyId = lib.stems[0].id;
    this.store.state.status = builtIn ? 'Restored the built-in table.' : 'Deleted the stem.';
    this.load(o.stemFamilyId);
    this.onChange();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
