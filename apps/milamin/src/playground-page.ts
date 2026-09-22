// Model playground: write a model definition (geometry + viscosity + boundary
// conditions) in the editor, run it through the full MilAMin pipeline in a
// worker, and render the pressure and max-shear-stress fields. The panels
// behave like the million page: colormap and quantization selectable,
// wheel/drag pan-zoom, mesh overlay, PNG export.
import './site';
import { triEvaluator, StokesTriCore } from '@fem/stokesfem-tri';
import { COLORMAPS, quantize } from '@viz/colormap';
import { colormapLut, fieldRanges, niceNum, Extent, FieldRange } from '@viz/render';
import { attachPanZoom } from '@viz/panzoom';
import type { PlaygroundMessage, Outline } from './playground-worker';
import { initThreadInput, readThreads } from './threads';
import { initColorRange } from './color-range';
import { unknowns2008 } from '@fem/unknowns';
import { createRunSummary, StageTime, STAGE_LABELS } from './run-summary';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const presetSel = $<HTMLSelectElement>('in-preset');
const threadsIn = $<HTMLSelectElement>('in-threads');
const cmapSelect = $<HTMLSelectElement>('in-cmap');
const levelsSelect = $<HTMLSelectElement>('in-levels');
const meshToggle = $<HTMLInputElement>('in-mesh');
const runBtn = $<HTMLButtonElement>('run');
const status = $('status');
const summary = createRunSummary($('summary'));
const editor = $<HTMLTextAreaElement>('editor');
const errorEl = $('model-error');
const cvP = $<HTMLCanvasElement>('cv-p');
const cvTau = $<HTMLCanvasElement>('cv-tau');

// playground models are mostly small; two threads is the phone's optimum and
// costs nothing on desktops (see threads.ts)
const THREAD_CAP = 2;
initThreadInput(threadsIn, THREAD_CAP);

for (const [key, { label }] of Object.entries(COLORMAPS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = label;
  cmapSelect.appendChild(opt);
}
cmapSelect.value = 'turbo';

// --- presets -----------------------------------------------------------------

const PRESETS: Record<string, { label: string; code: string }> = {
  inclusion: {
    label: 'Circular inclusion (the benchmark)',
    code: `// A viscous circular inclusion in simple shear - the MILAMIN benchmark.
// Every model returns { mesh, mu, bc }. Units are dimensionless.
// Helpers in scope: rect(x0,y0,x1,y1), circle(cx,cy,r,n), ellipse(cx,cy,rx,ry,n,angleDeg).
const box = 10; // half-width of the outer box: ten radii, so the walls
                // hardly disturb the inclusion (at 2.5 they double its pressure)
const R = 1;    // inclusion radius

return {
  mesh: {
    // closed polylines; the marker tags their nodes for the bc function
    boundaries: [
      { pts: rect(-box, -box, box, box), marker: 1 },
      { pts: circle(0, 0, R, 96), marker: 2 },
    ],
    // region seeds: [x, y, attribute, maxArea] - one per enclosed region
    regions: [
      [-box + 0.05, -box + 0.05, 1, 0.08],
      [0, 0, 2, 0.02],
    ],
  },
  // viscosity per region attribute
  mu: (attr) => (attr === 2 ? 1000 : 1),
  // Dirichlet velocity per boundary marker; null = unconstrained,
  // a NaN component leaves that component free (free slip)
  bc: (marker, x, y) => (marker === 1 ? [y, 0] : null), // simple shear
  // initial view [cx, cy, halfWidth]; zoom out to see the whole box
  view: [0, 0, 3],
};
`,
  },
  swarm: {
    label: 'Swarm of stiff ellipses',
    code: `// A swarm of stiff, randomly rotated ellipses in simple shear.
const box = 2.5;
const boundaries = [{ pts: rect(-box, -box, box, box), marker: 1 }];
const regions = [[-box + 0.05, -box + 0.05, 1, 0.01]];

// seeded pseudo-random placement, reproducible run to run
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// keep drawing until 16 ellipses are placed; each new one must clear the
// existing ones by a gap (bounding circles, radius = long semi-axis)
const want = 16, gap = 0.15;
const placed = []; // [x, y, rx]
let tries = 0;
while (placed.length < want && tries++ < 20000) {
  const rx = 0.2 + 0.2 * rand();
  const ry = 0.08 + 0.08 * rand();
  const x = (2 * rand() - 1) * (box - rx - gap);
  const y = (2 * rand() - 1) * (box - rx - gap);
  if (placed.some(([px, py, pr]) => Math.hypot(x - px, y - py) < rx + pr + gap)) continue;
  placed.push([x, y, rx]);
  boundaries.push({ pts: ellipse(x, y, rx, ry, 48, 360 * rand()), marker: 2 });
  regions.push([x, y, 2, 0.02]);
}
if (placed.length < want) throw new Error('placed only ' + placed.length + ' of ' + want + ' ellipses');

return {
  mesh: { boundaries, regions },
  mu: (attr) => (attr === 2 ? 1000 : 1),
  bc: (marker, x, y) => (marker === 1 ? [y, 0] : null),
};
`,
  },
  multilayer: {
    label: 'Multilayer under pure shear',
    code: `// A perturbed multilayer shortening under pure shear - the folding setup.
// Built from explicit points + segments: interfaces span the box, so the
// side walls are split at the interface endpoints.
const W = 3, H = 1.5;
const layers = [[-0.55, -0.35], [-0.1, 0.1], [0.35, 0.55]]; // stiff [yBottom, yTop]
const nx = 121;   // points per interface
const A = 0.03;   // interface perturbation amplitude

const points = [[-W, -H], [W, -H], [W, H], [-W, H]];
const segments = [[0, 1, 1], [2, 3, 1]]; // bottom and top wall
const wallLeft = [0], wallRight = [1];   // wall point indices, bottom to top

const pert = (x, y0) =>
  y0 + A * Math.cos((Math.PI * x) / W) + 0.008 * Math.sin(7 * x + 5 * y0);

for (const y0 of layers.flat()) {
  let prev = -1;
  for (let i = 0; i < nx; i++) {
    const x = -W + (2 * W * i) / (nx - 1);
    points.push([x, pert(x, y0)]);
    const idx = points.length - 1;
    if (i === 0) wallLeft.push(idx);
    if (i === nx - 1) wallRight.push(idx);
    if (prev >= 0) segments.push([prev, idx, 0]); // internal interface
    prev = idx;
  }
}
wallLeft.push(3);
wallRight.push(2);
for (let i = 0; i + 1 < wallLeft.length; i++) segments.push([wallLeft[i], wallLeft[i + 1], 1]);
for (let i = 0; i + 1 < wallRight.length; i++) segments.push([wallRight[i], wallRight[i + 1], 1]);

// region seeds: stiff inside each layer, matrix in the gaps
const regions = [[0, -H + 0.05, 1, 0.008], [0, H - 0.05, 1, 0.008]];
for (const [yb, yt] of layers) regions.push([0, (yb + yt) / 2 + A, 2, 0.004]);
for (let i = 0; i + 1 < layers.length; i++)
  regions.push([0, (layers[i][1] + layers[i + 1][0]) / 2 + A, 1, 0.008]);

return {
  mesh: { points, segments, regions },
  mu: (attr) => (attr === 2 ? 100 : 1),
  // pure shear shortening: vx = -x, vy = +y on the outer boundary
  bc: (marker, x, y) => (marker === 1 ? [-x, y] : null),
};
`,
  },
};

for (const [key, { label }] of Object.entries(PRESETS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = label;
  presetSel.appendChild(opt);
}

// --- persistence: localStorage + shareable #model= URLs ----------------------

const LS_KEY = 'milamin-playground-model';

const encodeModel = (code: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(code)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

function decodeModel(b64url: string): string | null {
  try {
    const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/');
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function savedModel(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function saveModel() {
  try {
    localStorage.setItem(LS_KEY, editor.value);
  } catch {
    /* storage full or unavailable — persistence is best effort */
  }
}

const isPreset = (code: string) => Object.values(PRESETS).some((p) => p.code === code);
const savedIsCustom = () => {
  const saved = savedModel();
  return saved !== null && !isPreset(saved);
};

// One saved slot, never overwritten silently. Autosave is on while the editor
// holds the saved model (or edits of it, or there is nothing custom to lose);
// it is suspended when a preset or a shared link is edited while a different
// custom model is saved — those edits stay in the editor, marked "unsaved",
// until "Save as my model" replaces the saved one on purpose.
let autosave = true;
const saveNote = $('save-note');
const saveNoteText = $('save-note-text');

function setOption(id: string, value: string, text: string, present: boolean, first: boolean) {
  const opt = document.getElementById(id);
  if (present && !opt) {
    const o = document.createElement('option');
    o.id = id;
    o.value = value;
    o.textContent = text;
    first ? presetSel.prepend(o) : presetSel.append(o);
  } else if (!present && opt) {
    opt.remove();
  }
}

/** keep the dropdown's "My model" / "Unsaved edits" entries and the save
 *  notice in sync with the editor and the saved slot */
function syncPresetSelect() {
  const saved = savedModel();
  setOption('opt-custom', 'custom', 'My model (saved locally)', savedIsCustom(), true);
  const match = Object.entries(PRESETS).find(([, p]) => p.code === editor.value);
  const unsaved = !match && editor.value !== saved;
  setOption('opt-unsaved', 'unsaved', 'Unsaved edits', unsaved, false);
  presetSel.value = match ? match[0] : unsaved ? 'unsaved' : 'custom';
  saveNote.hidden = !(unsaved && !autosave);
  if (!saveNote.hidden) {
    saveNoteText.textContent =
      'These edits are not saved; your locally saved model is kept as it was.';
  }
}

// load order: #model= in the URL wins, then the locally saved model, then the
// default preset. A shared model is saved only when there is no custom model
// to lose; otherwise it opens as unsaved edits next to the saved one.
const rawHash = new URLSearchParams(location.hash.slice(1)).get('model');
const hashModel = rawHash ? decodeModel(rawHash) : null;
editor.value = hashModel ?? savedModel() ?? PRESETS.inclusion.code;
if (hashModel !== null) {
  autosave = !savedIsCustom() || hashModel === savedModel();
  if (autosave) saveModel();
}
syncPresetSelect();

editor.addEventListener('input', () => {
  if (autosave) saveModel();
  syncPresetSelect();
});

presetSel.addEventListener('change', () => {
  if (presetSel.value === 'unsaved') return;
  if (presetSel.value === 'custom') {
    editor.value = savedModel() ?? editor.value;
    autosave = true;
  } else {
    editor.value = PRESETS[presetSel.value].code;
    // editing a preset must not clobber a saved custom model
    autosave = !savedIsCustom();
  }
  syncPresetSelect();
});

$('save-model').addEventListener('click', () => {
  saveModel();
  autosave = true;
  syncPresetSelect();
});

const shareNote = $('share-note');
$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#model=${encodeModel(editor.value)}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    shareNote.textContent = 'link copied';
  } catch {
    shareNote.textContent = 'link is in the address bar';
  }
  setTimeout(() => (shareNote.textContent = ''), 4000);
});

// tab indents, Ctrl/Cmd+Enter runs
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t, value } = editor;
    editor.value = `${value.slice(0, s)}  ${value.slice(t)}`;
    editor.selectionStart = editor.selectionEnd = s + 2;
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runBtn.click();
  }
});

const FULL = 560;
const HOME: Extent = { cx: 0, cy: 0, halfWidth: 2.5 };
const ext: Extent = { ...HOME };

const LUT_N = 1024;
let lut = buildLut();

function buildLut(): Uint8Array {
  const map = COLORMAPS[cmapSelect.value].map;
  const n = Number(levelsSelect.value);
  return colormapLut(n > 0 ? quantize(map, n) : map);
}

// --- solve results (kept for redraws) ---------------------------------------

let core: StokesTriCore | null = null;
let evalAt: ReturnType<typeof triEvaluator> | null = null;
let outlines: Outline[] = [];
let pShift = 0;
let autoRange: FieldRange | null = null;
let range: FieldRange | null = null;
const colorRange = initColorRange(() => {
  if (!autoRange) return;
  range = colorRange.apply(autoRange);
  drawColorbars();
  drawFields();
});
let threadNote = '';

let worker: Worker | null = null;

function fmtTick(v: number): string {
  return String(Number(v.toPrecision(2)));
}

// --- rendering ---------------------------------------------------------------

function fieldsAt(x: number, y: number): { p: number; tau: number } | null {
  const s = evalAt!(x, y);
  return s ? { p: s.p - pShift, tau: s.tau } : null;
}

function drawFields(settled = true) {
  if (!core || !evalAt || !range) return;
  const res = settled ? FULL : FULL / 2;
  const pBuf = new Uint8ClampedArray(res * res * 4);
  const tauBuf = new Uint8ClampedArray(res * res * 4);
  const scale = (2 * ext.halfWidth) / res;
  const clampIdx = (t: number) => Math.max(0, Math.min(LUT_N - 1, Math.round(t * (LUT_N - 1))));
  const pSpan = range.pMax - range.pMin || 1e-12;
  const tauSpan = range.tauMax - range.tauMin || 1e-12;
  for (let j = 0; j < res; j++) {
    const y = ext.cy + (res / 2 - (j + 0.5)) * scale;
    for (let i = 0; i < res; i++) {
      const x = ext.cx + (i + 0.5 - res / 2) * scale;
      const s = fieldsAt(x, y);
      const k = (j * res + i) * 4;
      if (!s) continue;
      const pi = clampIdx((s.p - range.pMin) / pSpan) * 3;
      pBuf[k] = lut[pi]; pBuf[k + 1] = lut[pi + 1]; pBuf[k + 2] = lut[pi + 2]; pBuf[k + 3] = 255;
      const ti = clampIdx((s.tau - range.tauMin) / tauSpan) * 3;
      tauBuf[k] = lut[ti]; tauBuf[k + 1] = lut[ti + 1]; tauBuf[k + 2] = lut[ti + 2]; tauBuf[k + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = res;
  off.height = res;
  off.getContext('2d')!.putImageData(new ImageData(pBuf, res, res), 0, 0);
  const offTau = document.createElement('canvas');
  offTau.width = res;
  offTau.height = res;
  offTau.getContext('2d')!.putImageData(new ImageData(tauBuf, res, res), 0, 0);
  for (const [canvas, img] of [
    [cvP, off],
    [cvTau, offTau],
  ] as const) {
    canvas.width = FULL;
    canvas.height = FULL;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, FULL, FULL);
    ctx.drawImage(img, 0, 0, FULL, FULL);
    if (meshToggle.checked && settled) drawMesh(ctx);
    drawOutlines(ctx);
  }
}

function ink(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
}

function worldToPx(x: number, y: number): [number, number] {
  const s = FULL / (2 * ext.halfWidth);
  return [FULL / 2 + (x - ext.cx) * s, FULL / 2 - (y - ext.cy) * s];
}

function drawMesh(ctx: CanvasRenderingContext2D, color?: string) {
  if (!core) return;
  ctx.strokeStyle = color ?? ink();
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  const { tri6, nodeX, nodeY } = core;
  for (let e = 0; e < core.elements; e++) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const na = tri6[e * 6 + a];
      const nb = tri6[e * 6 + b];
      const [ax, ay] = worldToPx(nodeX[na], nodeY[na]);
      const [bx, by] = worldToPx(nodeX[nb], nodeY[nb]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawOutlines(ctx: CanvasRenderingContext2D, color?: string) {
  if (!outlines.length) return;
  ctx.strokeStyle = color ?? ink();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (const o of outlines) {
    for (let i = 0; i < o.X.length; i++) {
      const [px, py] = worldToPx(o.X[i], o.Y[i]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawColorbars() {
  for (const id of ['cb-p', 'cb-tau']) {
    const canvas = $<HTMLCanvasElement>(id);
    canvas.width = 256;
    canvas.height = 1;
    const img = new ImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      const k = Math.round((i / 255) * (lut.length / 3 - 1)) * 3;
      img.data[i * 4] = lut[k];
      img.data[i * 4 + 1] = lut[k + 1];
      img.data[i * 4 + 2] = lut[k + 2];
      img.data[i * 4 + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(img, 0, 0);
  }
  if (!range) return;
  $('tick-p-min').textContent = fmtTick(range.pMin);
  $('tick-p-mid').textContent = '0';
  $('tick-p-max').textContent = fmtTick(range.pMax);
  $('tick-tau-min').textContent = '0';
  $('tick-tau-mid').textContent = fmtTick(range.tauMax / 2);
  $('tick-tau-max').textContent = fmtTick(range.tauMax);
}

// --- PNG export --------------------------------------------------------------

function exportPanel(which: 'p' | 'tau') {
  if (!core || !range) return;
  const src = which === 'p' ? cvP : cvTau;
  const title = which === 'p' ? 'Pressure p' : 'Maximum shear stress τ';
  const [lo, hi] = which === 'p' ? [range.pMin, range.pMax] : [range.tauMin, range.tauMax];
  const M = 24, cbH = 16, W = FULL + 2 * M, yField = M + 34, yCb = yField + FULL + 14;
  const H = yCb + cbH + 22 + 26 + M;
  const ec = document.createElement('canvas');
  ec.width = W;
  ec.height = H;
  const ctx = ec.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111111';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText(title, M, M + 20);
  ctx.fillStyle = '#e8e8e6';
  ctx.fillRect(M, yField, FULL, FULL);
  ctx.drawImage(src, M, yField);
  const grad = ctx.createLinearGradient(M, 0, M + FULL, 0);
  const n = lut.length / 3;
  for (let i = 0; i < n; i += 8) grad.addColorStop(i / (n - 1), `rgb(${lut[i * 3]},${lut[i * 3 + 1]},${lut[i * 3 + 2]})`);
  ctx.fillStyle = grad;
  ctx.fillRect(M, yCb, FULL, cbH);
  ctx.fillStyle = '#333333';
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTick(lo), M, yCb + cbH + 16);
  ctx.textAlign = 'center';
  ctx.fillText(fmtTick((lo + hi) / 2), M + FULL / 2, yCb + cbH + 16);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTick(hi), M + FULL, yCb + cbH + 16);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#555555';
  ctx.fillText(
    `${unknowns2008(core.dofs, core.elements).toLocaleString('en')} unknowns   ${core.elements.toLocaleString('en')} elements   ${threadNote}`,
    M,
    yCb + cbH + 42,
  );
  const a = document.createElement('a');
  a.download = `milamin-playground-${which}.png`;
  a.href = ec.toDataURL('image/png');
  a.click();
}

$('dl-p').addEventListener('click', () => exportPanel('p'));
$('dl-tau').addEventListener('click', () => exportPanel('tau'));

// --- view interaction ----------------------------------------------------------

attachPanZoom([cvP, cvTau], ext, () => HOME, (settled) => drawFields(settled));
cmapSelect.addEventListener('change', () => {
  lut = buildLut();
  drawColorbars();
  drawFields();
});
levelsSelect.addEventListener('change', () => {
  lut = buildLut();
  drawColorbars();
  drawFields();
});
meshToggle.addEventListener('change', () => drawFields());

// --- run orchestration --------------------------------------------------------

/** a run starts: the previous solution leaves the screen and the page shows
 *  the progress cursor until the new one is drawn (or the run stops) */
function beginRun() {
  core = null;
  evalAt = null;
  autoRange = null;
  range = null;
  for (const c of [cvP, cvTau]) {
    c.width = FULL;
    c.height = FULL;
    c.getContext('2d')!.clearRect(0, 0, FULL, FULL);
  }
  for (const id of ['tick-p-min', 'tick-p-mid', 'tick-p-max', 'tick-tau-min', 'tick-tau-mid', 'tick-tau-max']) {
    $(id).textContent = '';
  }
  document.body.classList.add('solving');
}

function endRun() {
  document.body.classList.remove('solving');
}

function finishRun(c: StokesTriCore, view?: [number, number, number]): number {
  const t0 = performance.now();
  core = c;
  evalAt = triEvaluator(c);
  // the model's bounding box; the home view is that box unless the model
  // asks for a view of its own (a large box with a small inclusion, say)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < c.nodes; i++) {
    if (c.nodeX[i] < minX) minX = c.nodeX[i];
    if (c.nodeX[i] > maxX) maxX = c.nodeX[i];
    if (c.nodeY[i] < minY) minY = c.nodeY[i];
    if (c.nodeY[i] > maxY) maxY = c.nodeY[i];
  }
  const bbox: Extent = {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    halfWidth: (Math.max(maxX - minX, maxY - minY) / 2) * 1.04,
  };
  Object.assign(HOME, view ? { cx: view[0], cy: view[1], halfWidth: view[2] } : bbox);
  // pressure is defined up to a constant with Dirichlet velocities all around:
  // gauge by the mean over a sampling grid of the whole model
  let pSum = 0;
  let pCnt = 0;
  for (let j = 0; j < 48; j++) {
    for (let i = 0; i < 48; i++) {
      const x = bbox.cx + ((i + 0.5) / 48 - 0.5) * 2 * bbox.halfWidth;
      const y = bbox.cy + ((j + 0.5) / 48 - 0.5) * 2 * bbox.halfWidth;
      const s = evalAt(x, y);
      if (s && Number.isFinite(s.p)) {
        pSum += s.p;
        pCnt++;
      }
    }
  }
  pShift = pCnt ? pSum / pCnt : 0;
  const source = {
    evalAt(x: number, y: number) {
      const s = fieldsAt(x, y);
      return s ? { ...s, inside: true } : { p: NaN, tau: NaN, inside: false };
    },
  };
  const r = fieldRanges(source, HOME);
  autoRange = { pMin: -niceNum(r.pMax), pMax: niceNum(r.pMax), tauMin: 0, tauMax: niceNum(r.tauMax) };
  range = colorRange.apply(autoRange);
  Object.assign(ext, HOME);
  drawColorbars();
  drawFields();
  return performance.now() - t0;
}

runBtn.addEventListener('click', () => {
  if (worker) {
    worker.terminate();
    worker = null;
    endRun();
    runBtn.textContent = 'Run';
    status.textContent = 'stopped';
    return;
  }
  beginRun();
  const stages: StageTime[] = [];
  let stageStart = 0;
  const closeStage = () => {
    if (stages.length) stages[stages.length - 1].ms = performance.now() - stageStart;
  };
  summary.start();
  errorEl.textContent = '';
  runBtn.textContent = 'Stop';
  status.textContent = 'starting worker…';
  worker = new Worker(new URL('./playground-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<PlaygroundMessage>) => {
    const msg = ev.data;
    if ('threads' in msg) {
      threadNote = !msg.isolated
        ? 'single-threaded (no cross-origin isolation)'
        : msg.threads > 1
          ? `${msg.threads} threads`
          : '1 thread';
      status.textContent = `running, ${threadNote}`;
    } else if ('stage' in msg) {
      closeStage();
      stages.push({ key: msg.stage, ms: null });
      stageStart = performance.now();
      summary.stages(stages);
      status.textContent = `running (${STAGE_LABELS[msg.stage]}), ${threadNote}`;
    } else if ('core' in msg) {
      closeStage();
      outlines = msg.outlines;
      stages.length = 0;
      stages.push(
        { key: 'mesh', ms: msg.meshMs },
        { key: 'assemble', ms: msg.core.assembleMs },
        { key: 'factor', ms: msg.core.factorMs },
        { key: 'ph', ms: msg.core.phMs },
        { key: 'render', ms: null },
      );
      summary.stages(stages);
      status.textContent = `rendering, ${threadNote}`;
      requestAnimationFrame(() =>
        setTimeout(() => {
          const renderMs = finishRun(msg.core, msg.view);
          stages[stages.length - 1].ms = renderMs;
          summary.finish(stages, { dofs: unknowns2008(msg.core.dofs, msg.core.elements), elements: msg.core.elements, threadNote });
          endRun();
          status.textContent = 'done';
          runBtn.textContent = 'Run';
          worker?.terminate();
          worker = null;
        }),
      );
    } else if ('error' in msg) {
      endRun();
      errorEl.textContent = msg.error;
      status.textContent = 'failed';
      runBtn.textContent = 'Run';
      worker?.terminate();
      worker = null;
    }
  };
  worker.postMessage({
    code: editor.value,
    threads: readThreads(threadsIn, THREAD_CAP),
  });
});

// ?autorun[=preset] runs on load — handy for demos and headless testing
const auto = new URLSearchParams(location.search).get('autorun');
if (auto !== null) {
  if (auto && PRESETS[auto]) {
    presetSel.value = auto;
    editor.value = PRESETS[auto].code;
  }
  runBtn.click();
}
