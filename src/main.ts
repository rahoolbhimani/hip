import './styles.css';
import { Store } from './app/store';
import { STEPS, stepLabel } from './app/steps';
import { Viewer } from './ui/viewer';
import { renderResults } from './ui/results';
import { loadImageFile } from './imaging/load';
import { generatePhantom } from './imaging/synthetic';
import { type CaseData, type Side, DEFAULT_OPTIONS, emptyCase } from './planning/types';
import { parseLibrary } from './planning/implants';
import { add, scale } from './geometry/vec';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const store = new Store();
const viewer = new Viewer($('viewer'), store);

// ---------------------------------------------------------------- image I/O

function onImageLoaded(): void {
  const s = store.state;
  s.case = { ...emptyCase(), operativeSide: s.case.operativeSide, standardOrientation: s.case.standardOrientation, options: s.case.options };
  s.window = null;
  const img = s.image!;
  if (img.pixelSpacingMm) {
    const mag = img.spacingAtPatient ? 1 : img.magnification ?? 1.2;
    ($('mag-input') as HTMLInputElement).value = mag.toFixed(2);
    store.setSpacingCalibration(img.pixelSpacingMm, mag);
    s.status = `DICOM spacing ${img.pixelSpacingMm.toFixed(3)} mm with magnification ${mag.toFixed(2)} applied. A marker ball is more accurate if visible.`;
  }
  $('empty').hidden = true;
  store.activateStep(store.nextStep());
  if (img.pixelSpacingMm) store.setStatus(s.status);
  else store.setStatus('Calibrate first: use the marker ball or a known length (or enter a scale), then place landmarks.');
  store.recompute();
  requestAnimationFrame(() => viewer.fit());
}

$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  store.setStatus(`Loading ${file.name}…`);
  try {
    store.state.image = await loadImageFile(file);
    onImageLoaded();
  } catch (err) {
    store.setStatus(`Could not open ${file.name}: ${(err as Error).message}`);
  }
});

$('demo-btn').addEventListener('click', () => {
  store.setStatus('Generating synthetic demo radiograph…');
  setTimeout(() => {
    const ph = generatePhantom({ mmPerPx: 0.3, noise: 5, lldMm: 6 });
    store.state.image = { name: 'Synthetic demo (left THA, 6 mm short)', gray: ph.image, meta: {} };
    store.state.case.operativeSide = 'L';
    store.state.case.standardOrientation = true;
    onImageLoaded();
    const px = (p: { x: number; y: number }) => scale(p, 1 / ph.mmPerPx);
    const mc = px(ph.markerCenter);
    store.calibrateMarker(mc, add(mc, { x: ph.markerDiameterMm / 2 / ph.mmPerPx, y: 0 }), ph.markerDiameterMm);
    for (const side of ['R', 'L'] as Side[]) {
      const f = ph.femora[side];
      const l = store.landmarks(side);
      l.teardrop = px(ph.teardrops[side]);
      l.lesserTrochanter = px(f.lesserTrochanter);
      store.detectHead(side, px(add(f.head, { x: 2, y: -2 })));
      l.canalSeeds = [px(f.axisAtLT), px(add(f.axisAtLT, scale(f.axisDir, 140)))];
      store.detectCanal(side);
    }
    store.state.activeTool = null;
    store.state.status = 'Demo case loaded with landmarks pre-placed. Drag any handle or change options — the plan updates live.';
    store.recompute();
    syncControls();
  }, 20);
});

// ---------------------------------------------------------------- case setup

function syncSide(): void {
  for (const b of $('side-seg').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.side === store.state.case.operativeSide);
  }
  ($('orientation') as HTMLInputElement).checked = store.state.case.standardOrientation;
}

$('side-seg').addEventListener('click', (e) => {
  const side = (e.target as HTMLElement).dataset.side as Side | undefined;
  if (!side || side === store.state.case.operativeSide) return;
  store.state.case.operativeSide = side;
  // Keep the active step meaningful after the swap.
  if (store.state.activeTool?.type === 'step') store.activateStep(store.state.activeTool.step);
  store.recompute();
});
$('orientation').addEventListener('change', (e) => {
  store.state.case.standardOrientation = (e.target as HTMLInputElement).checked;
  store.recompute();
});

// ---------------------------------------------------------------- calibration

$('cal-marker').addEventListener('click', () => store.state.image && store.activateCalibration('marker'));
$('cal-line').addEventListener('click', () => store.state.image && store.activateCalibration('line'));
$('cal-spacing-apply').addEventListener('click', () => {
  const img = store.state.image;
  const mag = Number(($('mag-input') as HTMLInputElement).value);
  if (img?.pixelSpacingMm && mag > 0) store.setSpacingCalibration(img.pixelSpacingMm, mag);
});
$('cal-manual-apply').addEventListener('click', () => {
  const v = Number(($('manual-scale') as HTMLInputElement).value);
  if (v > 0 && store.state.image) store.setManualCalibration(v);
});

function syncCalibration(): void {
  const cal = store.state.case.calibration;
  const el = $('cal-status');
  el.className = `cal-status ${cal ? 'ok' : 'no'}`;
  const names = { marker: 'marker ball', line: 'known length', spacing: 'DICOM spacing', manual: 'manual' };
  el.textContent = cal ? `${cal.mmPerPx.toFixed(4)} mm/px · ${names[cal.method]}` : 'Not calibrated';
  const img = store.state.image;
  $('cal-spacing').hidden = !img?.pixelSpacingMm;
  if (img?.pixelSpacingMm) $('spacing-val').textContent = `${img.pixelSpacingMm.toFixed(4)} mm${img.spacingAtPatient ? ' (patient plane)' : ''}`;
  for (const id of ['cal-marker', 'cal-line']) {
    const active = store.state.activeTool?.type === 'calibration' && `cal-${store.state.activeTool.tool}` === id;
    $(id).classList.toggle('primary', active);
  }
}

// ---------------------------------------------------------------- landmarks

function renderSteps(): void {
  const s = store.state;
  const op = s.case.operativeSide;
  const ol = $('steps');
  ol.innerHTML = '';
  for (const step of STEPS) {
    const li = document.createElement('li');
    const done = store.isStepDone(step);
    const active = s.activeTool?.type === 'step' && s.activeTool.step.id === step.id;
    li.className = `${done ? 'done' : ''} ${active ? 'active' : ''}`;
    li.innerHTML = `<span class="dot">${done ? '✓' : ''}</span><span class="name">${stepLabel(step, op)}${step.required ? '' : ' <span class="opt">optional</span>'}</span>`;
    li.title = step.hint;
    li.addEventListener('click', () => {
      if (!s.image) return;
      store.activateStep(active ? null : step);
    });
    if (done) {
      const clr = document.createElement('button');
      clr.className = 'clear';
      clr.textContent = '×';
      clr.title = 'Remove';
      clr.addEventListener('click', (e) => {
        e.stopPropagation();
        store.clearStep(step);
      });
      li.appendChild(clr);
    }
    ol.appendChild(li);
  }
}

$('next-step').addEventListener('click', () => {
  if (store.state.image) store.activateStep(store.nextStep());
});

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    store.state.activeTool = null;
    store.state.pendingClicks = [];
    store.setStatus('Tool cancelled. Drag handles to adjust, or pick a landmark to place.');
  } else if (e.key === 'f') viewer.fit();
  else if (e.key === 'n' && store.state.image) store.activateStep(store.nextStep());
});

// ---------------------------------------------------------------- display

$('brightness').addEventListener('input', (e) => {
  viewer.brightness = Number((e.target as HTMLInputElement).value);
  viewer.render();
});
$('contrast').addEventListener('input', (e) => {
  viewer.contrast = Number((e.target as HTMLInputElement).value);
  viewer.render();
});
$('invert').addEventListener('change', (e) => {
  viewer.invert = (e.target as HTMLInputElement).checked;
  viewer.render();
});
for (const el of document.querySelectorAll<HTMLInputElement>('[data-layer]')) {
  el.addEventListener('change', () => {
    viewer.layers[el.dataset.layer as keyof typeof viewer.layers] = el.checked;
    viewer.render();
  });
}
$('zoom-fit').addEventListener('click', () => viewer.fit());
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));

// ---------------------------------------------------------------- plan options

function fillSelect(id: string, options: Array<[string, string]>, value: string): void {
  const sel = $<HTMLSelectElement>(id);
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = value;
}

function syncControls(): void {
  const o = store.state.case.options;
  const lib = store.state.library;
  const stem = lib.stems.find((x) => x.id === o.stemFamilyId) ?? lib.stems[0];
  const cup = lib.cups.find((x) => x.id === o.cupFamilyId) ?? lib.cups[0];
  ($('opt-incl') as HTMLInputElement).value = String(o.cupInclination);
  $('opt-incl-val').textContent = `${o.cupInclination}°`;
  ($('opt-placement') as HTMLSelectElement).value = o.cupPlacement;
  ($('opt-oversize') as HTMLInputElement).value = String(o.cupOversize);
  ($('opt-medial') as HTMLInputElement).value = String(o.cupMedialWallOffset);
  ($('opt-lld') as HTMLInputElement).checked = o.correctLLD;
  ($('opt-extra') as HTMLInputElement).value = String(o.extraLengthening);
  fillSelect('ovr-cup', [['', 'Auto'], ...cup.sizes.map((z): [string, string] => [String(z.outerDiameter), `${z.outerDiameter} mm`])], o.cupSizeOverride === null ? '' : String(o.cupSizeOverride));
  fillSelect('ovr-stem', [['', 'Auto'], ...stem.sizes.map((z): [string, string] => [z.size, `Size ${z.size}`])], o.stemSizeOverride ?? '');
  const offs = stem.sizes[0].offsets;
  fillSelect('ovr-offset', [['', 'Auto'], ...offs.map((z): [string, string] => [z.id, z.label])], o.offsetOverride ?? '');
  fillSelect('ovr-head', [['', 'Auto'], ...stem.headLengths.map((h): [string, string] => [String(h), `${h >= 0 ? '+' : ''}${h} mm`])], o.headLengthOverride === null ? '' : String(o.headLengthOverride));
  syncSide();
}

function bindOption(id: string, apply: (el: HTMLInputElement & HTMLSelectElement) => void, evt = 'change'): void {
  const el = $<HTMLInputElement & HTMLSelectElement>(id);
  el.addEventListener(evt, () => {
    apply(el);
    if (id === 'opt-incl') $('opt-incl-val').textContent = `${el.value}°`;
    store.recompute();
  });
}
const o = () => store.state.case.options;
bindOption('opt-incl', (el) => (o().cupInclination = Number(el.value)), 'input');
bindOption('opt-placement', (el) => (o().cupPlacement = el.value as 'teardrop' | 'native'));
bindOption('opt-oversize', (el) => (o().cupOversize = Number(el.value) || 0));
bindOption('opt-medial', (el) => (o().cupMedialWallOffset = Number(el.value) || 0));
bindOption('opt-lld', (el) => (o().correctLLD = el.checked));
bindOption('opt-extra', (el) => (o().extraLengthening = Number(el.value) || 0));
bindOption('ovr-cup', (el) => (o().cupSizeOverride = el.value ? Number(el.value) : null));
bindOption('ovr-stem', (el) => (o().stemSizeOverride = el.value || null));
bindOption('ovr-offset', (el) => (o().offsetOverride = el.value || null));
bindOption('ovr-head', (el) => (o().headLengthOverride = el.value ? Number(el.value) : null));

// ---------------------------------------------------------------- persistence & export

function download(name: string, href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

function baseName(): string {
  return (store.state.image?.name ?? 'case').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
}

$('save-case').addEventListener('click', () => {
  const c = structuredClone(store.state.case);
  for (const side of ['R', 'L'] as Side[]) delete c.landmarks[side].canal; // derived; re-detected on load
  const blob = new Blob([JSON.stringify({ format: 'hip-templater-case', version: 1, image: store.state.image?.name, case: c }, null, 2)], { type: 'application/json' });
  download(`${baseName()}.plan.json`, URL.createObjectURL(blob));
});

$('load-case').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.format !== 'hip-templater-case') throw new Error('not a Hip Templater case file');
    const c = json.case as CaseData;
    c.options = { ...DEFAULT_OPTIONS, ...c.options };
    store.state.case = c;
    if (store.state.image) store.redetectAll();
    store.state.activeTool = null;
    store.state.status = store.state.image
      ? `Loaded case ${file.name}.`
      : `Loaded case ${file.name} — open the matching image (${json.image ?? 'unknown'}) to see it.`;
    syncControls();
    store.recompute();
  } catch (err) {
    store.setStatus(`Could not load case: ${(err as Error).message}`);
  }
});

$('export-png').addEventListener('click', () => {
  const url = viewer.exportPNG();
  if (url) download(`${baseName()}.template.png`, url);
});

$('print-report').addEventListener('click', () => {
  const url = viewer.exportPNG();
  if (!url) return;
  const s = store.state;
  const side = s.case.operativeSide === 'R' ? 'Right' : 'Left';
  $('print-area').innerHTML = `<h1>THA template — ${side} hip</h1>
    <p>Image: ${s.image?.name ?? ''} · Generated ${new Date().toLocaleString()}</p>
    <img src="${url}" alt="Templated radiograph" />
    ${renderResults(s)}`;
  setTimeout(() => window.print(), 50);
});

$('load-library').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const lib = parseLibrary(JSON.parse(await file.text()));
    store.state.library = lib;
    const opts = store.state.case.options;
    opts.stemFamilyId = lib.stems[0].id;
    opts.cupFamilyId = lib.cups[0].id;
    opts.stemSizeOverride = null;
    opts.cupSizeOverride = null;
    opts.offsetOverride = null;
    opts.headLengthOverride = null;
    syncControls();
    store.state.status = `Implant library loaded: ${lib.stems[0].name} / ${lib.cups[0].name}.`;
    store.recompute();
  } catch (err) {
    store.setStatus(`Invalid implant library: ${(err as Error).message}`);
  }
});

$('export-library').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.state.library, null, 2)], { type: 'application/json' });
  download('implant-library.json', URL.createObjectURL(blob));
});

// ---------------------------------------------------------------- render loop

store.subscribe((s) => {
  $('status').textContent = s.status;
  $('status').hidden = !s.status;
  renderSteps();
  syncCalibration();
  syncSide();
  $('results').innerHTML = renderResults(s);
});

syncControls();
store.emit();
