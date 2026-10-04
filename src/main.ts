import './styles.css';
import { Store } from './app/store';
import { STEPS, stepLabel, stepSide } from './app/steps';
import { Viewer } from './ui/viewer';
import { renderResults } from './ui/results';
import { StemEditor, withStoredStems } from './ui/stemEditor';
import { saveFile } from './ui/save';
import { loadImageFile } from './imaging/load';
import { generatePhantom } from './imaging/synthetic';
import { type CaseData, type LandmarkKey, type Side, DEFAULT_OPTIONS, emptyCase } from './planning/types';
import { parseLibrary } from './planning/implants';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const store = new Store();
store.state.library = { stems: withStoredStems(store.state.library.stems), cups: store.state.library.cups };
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
  store.state.activeTool = null;
  store.setStatus('Detecting landmarks…');
  requestAnimationFrame(() => {
    viewer.fit();
    // Let the image paint before the (≈0.5 s) detection runs.
    setTimeout(() => store.runAutoDetect(), 30);
  });
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
    syncControls();
    onImageLoaded();
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

$('cal-marker').addEventListener('click', () => {
  store.markerDiameterMm = Number(($('marker-mm') as HTMLInputElement).value);
  if (store.state.image) store.activateCalibration('marker');
});
$('marker-mm').addEventListener('change', () => {
  const d = Number(($('marker-mm') as HTMLInputElement).value);
  store.markerDiameterMm = d > 0 ? d : 25;
  const cal = store.state.case.calibration;
  if (cal?.method === 'marker' && cal.marker && d > 0) {
    cal.markerDiameterMm = d;
    cal.mmPerPx = d / (2 * cal.marker.radius);
    store.redetectAll();
    store.recompute();
  }
});
$('cal-line').addEventListener('click', () => {
  store.knownLengthMm = Number(($('line-mm') as HTMLInputElement).value);
  if (store.state.image) store.activateCalibration('line');
});

// Hosted (sandboxed) builds cannot download files or print, so hide those controls.
if (import.meta.env.VITE_EMBED) {
  for (const el of document.querySelectorAll<HTMLElement>('.file-io')) el.hidden = true;
}
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

const STEP_KEY: Record<string, LandmarkKey> = {
  teardrop: 'teardrop',
  head: 'head',
  lt: 'lesserTrochanter',
  canal: 'canal',
  acetEdge: 'acetabularEdge',
  gt: 'greaterTrochanter',
};

function renderSteps(): void {
  const s = store.state;
  const op = s.case.operativeSide;
  const ol = $('steps');
  ol.innerHTML = '';
  const cur = store.currentReviewItem();
  for (const step of STEPS) {
    const li = document.createElement('li');
    const status = store.stepStatus(step);
    const side = stepSide(step, op);
    const key = STEP_KEY[step.kind];
    const active = s.activeTool?.type === 'step' && s.activeTool.step.id === step.id;
    const reviewing = cur?.kind === 'landmark' && cur.side === side && cur.key === key;
    li.className = `${status ? 'done' : ''} ${status === 'proposed' ? 'proposed' : ''} ${active ? 'active' : ''} ${reviewing ? 'reviewing' : ''}`;
    li.tabIndex = 0;
    const mark = status === 'confirmed' ? '✓' : status === 'proposed' ? '?' : '';
    li.innerHTML = `<span class="dot">${mark}</span><span class="name">${stepLabel(step, op)}${step.required ? '' : ' <span class="opt">optional</span>'}${status === 'proposed' ? ' <span class="opt">check</span>' : ''}</span>`;
    li.title = status ? 'Show this point to check or adjust it' : step.hint;
    li.addEventListener('click', () => {
      if (!s.image) return;
      if (status) store.reviewGoTo(side, key);
      else store.activateStep(active ? null : step);
    });
    if (status) {
      const clr = document.createElement('button');
      clr.className = 'clear';
      clr.textContent = '×';
      clr.title = 'Remove and place again';
      clr.addEventListener('click', (e) => {
        e.stopPropagation();
        store.clearStep(step);
        store.activateStep(step);
      });
      li.appendChild(clr);
    }
    ol.appendChild(li);
  }
}

// ---------------------------------------------------------------- review of proposed points

const REVIEW_TEXT: Record<LandmarkKey, [string, string]> = {
  teardrop: ['Teardrop', 'Should sit on the inferior tip of the radiographic teardrop.'],
  head: ['Femoral head', 'The circle should follow the femoral head outline. Drag the centre or the edge dot.'],
  lesserTrochanter: ['Lesser trochanter', 'Should sit on the most prominent medial point of the lesser trochanter.'],
  canal: ['Femoral canal', 'Green dots should sit on the inner cortex. Drag either seed to move the search.'],
  acetabularEdge: ['Acetabular edge', 'Superolateral edge of the sourcil.'],
  greaterTrochanter: ['Greater trochanter', 'Tip of the greater trochanter.'],
};

function renderReviewCard(): void {
  const r = store.state.review;
  const item = store.currentReviewItem();
  const card = $('review-card');
  card.hidden = !r || !item;
  if (!r || !item) return;
  const left = store.unconfirmedCount();
  $('rc-count').textContent = `${left} to check`;
  if (item.kind === 'marker') {
    const cal = store.state.case.calibration;
    $('rc-title').textContent = `Calibration marker (${cal?.markerDiameterMm ?? 25} mm)`;
    $('rc-hint').textContent = 'The dashed circle should match the marker ball. Drag its edge dot if needed; change the diameter in the Calibration panel.';
  } else {
    const [title, hint] = REVIEW_TEXT[item.key];
    const isOp = item.side === store.state.case.operativeSide;
    $('rc-title').textContent = `${title}, ${item.side === 'R' ? 'right' : 'left'}${isOp ? ' (operative)' : ''}`;
    $('rc-hint').textContent = hint;
  }
}

$('rc-ok').addEventListener('click', () => store.reviewOK());
$('rc-skip').addEventListener('click', () => store.reviewSkip());
$('rc-all').addEventListener('click', () => store.reviewOKAll());
$('rc-stop').addEventListener('click', () => store.endReview());
$('auto-detect').addEventListener('click', () => {
  if (!store.state.image) return;
  store.setStatus('Detecting landmarks…');
  setTimeout(() => store.runAutoDetect(), 20);
});
$('review-start').addEventListener('click', () => {
  const op = store.state.case.operativeSide;
  for (const step of STEPS) {
    if (store.stepStatus(step) === 'proposed') {
      store.reviewGoTo(stepSide(step, op), STEP_KEY[step.kind]);
      return;
    }
  }
  store.setStatus('Nothing left to check.');
});

$('next-step').addEventListener('click', () => {
  if (store.state.image) store.activateStep(store.nextStep());
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
  if (store.state.review && e.key === 'Enter') {
    e.preventDefault();
    store.reviewOK();
    return;
  }
  if (e.key === 'Escape' && store.state.review) {
    store.endReview();
    return;
  }
  if (e.key === 'Escape') {
    store.state.activeTool = null;
    store.state.pendingClicks = [];
    store.setStatus('Tool cancelled. Drag handles to adjust, or pick a landmark to place.');
  } else if (e.key === 'f') viewer.fit();
  else if (e.key === 'm' || e.key === 'M') setMeasurementsVisible(!viewer.layers.measurements);
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
$('level-td').addEventListener('change', (e) => {
  viewer.levelTeardrops = (e.target as HTMLInputElement).checked;
  viewer.render();
});
$('invert').addEventListener('change', (e) => {
  viewer.invert = (e.target as HTMLInputElement).checked;
  viewer.render();
});
for (const el of document.querySelectorAll<HTMLInputElement>('[data-layer]')) {
  el.addEventListener('change', () => {
    if (el.dataset.layer === 'measurements') return setMeasurementsVisible(el.checked);
    viewer.layers[el.dataset.layer as keyof typeof viewer.layers] = el.checked;
    viewer.render();
  });
}
function setMeasurementsVisible(on: boolean): void {
  viewer.layers.measurements = on;
  const cb = document.querySelector<HTMLInputElement>('[data-layer="measurements"]');
  if (cb) cb.checked = on;
  $('tg-measure').classList.toggle('on', on);
  $('tg-measure').setAttribute('aria-pressed', String(on));
  viewer.render();
}
$('tg-measure').addEventListener('click', () => setMeasurementsVisible(!viewer.layers.measurements));
$('tg-summary').addEventListener('click', () => {
  viewer.summaryVisible = !viewer.summaryVisible;
  $('tg-summary').classList.toggle('on', viewer.summaryVisible);
  $('tg-summary').setAttribute('aria-pressed', String(viewer.summaryVisible));
  viewer.render();
});
$('reset-labels').addEventListener('click', () => viewer.resetLabels());
$('zoom-fit').addEventListener('click', () => viewer.fit());
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));

// ---------------------------------------------------------------- plan options

function fillSelect(id: string, options: Array<[string, string]>, value: string): void {
  const sel = $<HTMLSelectElement>(id);
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = value;
}

function syncGoalLabels(): void {
  const o = store.state.case.options;
  $('goal-ll-label').textContent = o.legLengthGoal.mode === 'match' ? 'Plus extra' : 'Change';
  $('goal-off-label').textContent = o.offsetGoal.mode === 'match' ? 'Plus extra' : 'Change';
}

function syncControls(): void {
  const o = store.state.case.options;
  const lib = store.state.library;
  const stem = lib.stems.find((x) => x.id === o.stemFamilyId) ?? lib.stems[0];
  const cup = lib.cups.find((x) => x.id === o.cupFamilyId) ?? lib.cups[0];
  ($('goal-ll-mode') as HTMLSelectElement).value = o.legLengthGoal.mode;
  ($('goal-ll-mm') as HTMLInputElement).value = String(o.legLengthGoal.mm);
  ($('goal-off-mode') as HTMLSelectElement).value = o.offsetGoal.mode;
  ($('goal-off-mm') as HTMLInputElement).value = String(o.offsetGoal.mm);
  syncGoalLabels();
  ($('opt-incl') as HTMLInputElement).value = String(o.cupInclination);
  $('opt-incl-val').textContent = `${o.cupInclination}°`;
  ($('opt-placement') as HTMLSelectElement).value = o.cupPlacement;
  ($('opt-align') as HTMLSelectElement).value = o.stemAlignment;
  ($('opt-oversize') as HTMLInputElement).value = String(o.cupOversize);
  ($('opt-medial') as HTMLInputElement).value = String(o.cupMedialWallOffset);
  fillSelect('opt-stem-family', lib.stems.map((f): [string, string] => [f.id, f.name]), stem.id);
  fillSelect('ovr-cup', [['', 'Auto'], ...cup.sizes.map((z): [string, string] => [String(z.outerDiameter), `${z.outerDiameter} mm`])], o.cupSizeOverride === null ? '' : String(o.cupSizeOverride));
  fillSelect('ovr-stem', [['', 'Auto'], ...stem.sizes.map((z): [string, string] => [z.size, `Size ${z.size}`])], o.stemSizeOverride ?? '');
  const offs = stem.sizes[0].offsets;
  fillSelect('ovr-offset', [['', 'Auto'], ...offs.map((z): [string, string] => [z.id, z.label])], o.offsetOverride ?? '');
  syncSide();
}

/** Keep the size/neck selects and the auto/manual labels in step with the plan. */
function syncPlanState(): void {
  const o = store.state.case.options;
  ($('ovr-stem') as HTMLSelectElement).value = o.stemSizeOverride ?? '';
  ($('ovr-offset') as HTMLSelectElement).value = o.offsetOverride ?? '';
  $('stem-mode').textContent = o.stemPose ? 'Manual' : 'Auto';
  $('cup-mode').textContent = o.cupCenter ? 'Manual' : 'Auto';
  ($('reset-stem') as HTMLButtonElement).disabled = !o.stemPose && !o.stemSizeOverride && !o.offsetOverride;
  ($('reset-cup') as HTMLButtonElement).disabled = !o.cupCenter;
}

function bindOption(id: string, apply: (el: HTMLInputElement & HTMLSelectElement) => void, evt = 'change'): void {
  const el = $<HTMLInputElement & HTMLSelectElement>(id);
  el.addEventListener(evt, () => {
    apply(el);
    if (id === 'opt-incl') $('opt-incl-val').textContent = `${el.value}°`;
    syncGoalLabels();
    store.recompute();
  });
}
const o = () => store.state.case.options;
bindOption('goal-ll-mode', (el) => (o().legLengthGoal = { mode: el.value as 'match' | 'change', mm: o().legLengthGoal.mm }));
bindOption('goal-ll-mm', (el) => (o().legLengthGoal = { ...o().legLengthGoal, mm: Number(el.value) || 0 }));
bindOption('goal-off-mode', (el) => (o().offsetGoal = { mode: el.value as 'match' | 'change', mm: o().offsetGoal.mm }));
bindOption('goal-off-mm', (el) => (o().offsetGoal = { ...o().offsetGoal, mm: Number(el.value) || 0 }));
bindOption('opt-incl', (el) => (o().cupInclination = Number(el.value)), 'input');
bindOption('opt-placement', (el) => {
  o().cupPlacement = el.value as 'teardrop' | 'native';
  o().cupCenter = null;
});
bindOption('opt-oversize', (el) => (o().cupOversize = Number(el.value) || 0));
bindOption('opt-medial', (el) => (o().cupMedialWallOffset = Number(el.value) || 0));
bindOption('ovr-cup', (el) => (o().cupSizeOverride = el.value ? Number(el.value) : null));
bindOption('ovr-stem', (el) => (o().stemSizeOverride = el.value || null));
bindOption('ovr-offset', (el) => (o().offsetOverride = el.value || null));
bindOption('opt-align', (el) => {
  o().stemAlignment = el.value as 'pelvis' | 'canal';
  o().stemPose = null;
});
bindOption('opt-stem-family', (el) => {
  o().stemFamilyId = el.value;
  o().stemSizeOverride = null;
  o().offsetOverride = null;
  o().stemPose = null;
  syncControls();
});
$('reset-stem').addEventListener('click', () => store.resetStem());
$('reset-cup').addEventListener('click', () => store.resetCup());

// ---------------------------------------------------------------- stem tables

const stemEditor = new StemEditor(store, () => {
  syncControls();
  store.recompute();
});
$('edit-stem-table').addEventListener('click', () => stemEditor.open());

// ---------------------------------------------------------------- persistence & export

function baseName(): string {
  return (store.state.image?.name ?? 'case').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
}

async function offerFile(filename: string, data: Blob): Promise<void> {
  const r = await saveFile(filename, data);
  if (r === 'declined') store.setStatus('Download cancelled.');
  else if (r === 'unavailable') store.setStatus('Downloads are not available in this view.');
  else store.setStatus(`Saved ${filename}.`);
}

$('save-case').addEventListener('click', () => {
  const c = structuredClone(store.state.case);
  for (const side of ['R', 'L'] as Side[]) delete c.landmarks[side].canal; // derived; re-detected on load
  const json = JSON.stringify({ format: 'hip-templater-case', version: 2, image: store.state.image?.name, case: c }, null, 2);
  void offerFile(`${baseName()}.plan.json`, new Blob([json], { type: 'application/json' }));
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
      : `Loaded case ${file.name}. Open the matching image (${json.image ?? 'unknown'}) to see it.`;
    syncControls();
    store.recompute();
  } catch (err) {
    store.setStatus(`Could not load case: ${(err as Error).message}`);
  }
});

$('export-jpeg').addEventListener('click', async () => {
  const blob = await viewer.exportBlob('image/jpeg');
  if (blob) await offerFile(`${baseName()}.template.jpg`, blob);
  else store.setStatus('Open an image first.');
});

$('print-report').addEventListener('click', () => {
  const url = viewer.exportImage('image/png');
  if (!url) return;
  const s = store.state;
  const side = s.case.operativeSide === 'R' ? 'Right' : 'Left';
  $('print-area').innerHTML = `<h1>THA template, ${side} hip</h1>
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
    store.state.library = { stems: [...lib.stems, ...store.state.library.stems.filter((s) => !lib.stems.some((x) => x.id === s.id))], cups: lib.cups };
    const opts = store.state.case.options;
    opts.stemFamilyId = lib.stems[0].id;
    opts.cupFamilyId = lib.cups[0].id;
    opts.stemSizeOverride = null;
    opts.cupSizeOverride = null;
    opts.offsetOverride = null;
    opts.stemPose = null;
    syncControls();
    store.state.status = `Implant library loaded: ${lib.stems[0].name} / ${lib.cups[0].name}.`;
    store.recompute();
  } catch (err) {
    store.setStatus(`Invalid implant library: ${(err as Error).message}`);
  }
});

// ---------------------------------------------------------------- render loop

store.subscribe((s) => {
  $('status').textContent = s.status;
  $('status').hidden = !s.status;
  renderSteps();
  renderReviewCard();
  syncCalibration();
  syncSide();
  $('results').innerHTML = renderResults(s, store.detectionErrors(), store.planBlockedReason());
  syncPlanState();
});

syncControls();
store.emit();
