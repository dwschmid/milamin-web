// Page controller for the folding/boudinage simulation: collect the model
// parameters, run the time loop in a worker, store the streamed frames, and
// let the user scrub or play through them. One field panel (viscosity,
// pressure, shear stress, strain rate, speed, perturbing speed or vorticity)
// and one amplification chart comparing the measured amplitude against the
// analytical growth rate applicable to the run.
import '../../milamin/src/site';
import { triEvaluator, StokesTriCore } from '@fem/stokesfem-tri';
import { COLORMAPS, quantize } from '@viz/colormap';
import { colormapLut, niceNum, Extent } from '@viz/render';
import { attachPanZoom } from '@viz/panzoom';
import {
  qBiotThin,
  qFletcherThick,
  qFletcherBounded,
  qNeckThick,
  qNeckBounded,
  qPowerLawThick,
  dominantWavelengthOf,
} from './growth';
import { initialState, type Face, type StrainMode, type ModelParams, type Perturbation } from './geometry';
import type { FoldingMessage, FoldingFrame, FoldingRequest } from './folding-worker';
import { initThreadInput, readThreads } from '../../milamin/src/threads';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const rIn = $<HTMLInputElement>('in-r');
const wlNote = $('note-wl');
const modeSel = $<HTMLSelectElement>('in-mode');
const layersIn = $<HTMLInputElement>('in-layers');
const spacingIn = $<HTMLInputElement>('in-spacing');
const nlIn = $<HTMLInputElement>('in-nl');
const nmIn = $<HTMLInputElement>('in-nm');
const pertSel = $<HTMLSelectElement>('in-pert');
const wlIn = $<HTMLInputElement>('in-wl');
const wlNum = $<HTMLInputElement>('num-wl');
const ampIn = $<HTMLInputElement>('in-amp');
const hurstIn = $<HTMLInputElement>('in-hurst');
const bellIn = $<HTMLInputElement>('in-bell');
const marginIn = $<HTMLInputElement>('in-margin');
const strainIn = $<HTMLInputElement>('in-strain');
const strainNum = $<HTMLInputElement>('num-strain');
const stepsIn = $<HTMLInputElement>('in-steps');
const stepsNum = $<HTMLInputElement>('num-steps');
const resSel = $<HTMLSelectElement>('in-res');
const threadsIn = $<HTMLSelectElement>('in-threads');
const fieldSel = $<HTMLSelectElement>('in-field');
const cmapSelect = $<HTMLSelectElement>('in-cmap');
const levelsSelect = $<HTMLSelectElement>('in-levels');
const meshToggle = $<HTMLInputElement>('in-mesh');
const crangeSel = $<HTMLSelectElement>('in-crange');
const cminIn = $<HTMLInputElement>('in-cmin');
const cmaxIn = $<HTMLInputElement>('in-cmax');
const runBtn = $<HTMLButtonElement>('run');
const status = $('status');
const summaryEl = $('summary');
const playBtn = $<HTMLButtonElement>('play');
const frameIn = $<HTMLInputElement>('in-frame');
const frameLabel = $('frame-label');
const panelTitle = $('panel-title');
const cvField = $<HTMLCanvasElement>('cv-field');

// see milamin/src/threads.ts: 2D factorizations plateau at a few threads
const THREAD_CAP = 4;
initThreadInput(threadsIn, THREAD_CAP);

for (const [key, { label }] of Object.entries(COLORMAPS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = label;
  cmapSelect.appendChild(opt);
}
cmapSelect.value = 'turbo';

// interface nodes per unit length and area targets per resolution setting
const RES = {
  coarse: { nodesPerH: 4, areaLayer: 0.05, areaMatrix: 0.4 },
  medium: { nodesPerH: 6, areaLayer: 0.02, areaMatrix: 0.2 },
  fine: { nodesPerH: 8, areaLayer: 0.008, areaMatrix: 0.1 },
} as const;

// panel resolution in px; Enlarge goes full width at full resolution
let FULL = 760;
/** what the worker is doing right now, shown while frames are still to come */
let progressNote = '';
const LUT_N = 1024;
let lut = buildLut();

function buildLut(): Uint8Array {
  const map = COLORMAPS[cmapSelect.value].map;
  const n = Number(levelsSelect.value);
  return colormapLut(n > 0 ? quantize(map, n) : map);
}

// --- run state ---------------------------------------------------------------

interface StoredFrame extends FoldingFrame {
  evalAt: ReturnType<typeof triEvaluator>;
  pShift: number;
}

interface RunInfo {
  R: number;
  nl: number;
  nm: number;
  mode: StrainMode;
  layers: number;
  perturbation: Perturbation;
  strainPct: number;
  nSteps: number;
  boxWidth: number;
  boxHeight: number;
  /** effective sine wavelength after fitting whole waves into the box */
  wavelength: number;
}

let frames: StoredFrame[] = [];
let current = -1;
let run: RunInfo | null = null;
let worker: Worker | null = null;
let threadNote = '';
let runTotalMs: number | null = null;
// field ranges expand as frames arrive so colors stay comparable across time
let pRange = 0;
let tauRange = 0;
let velRange = 0;
let eIIRange = 0;
let pvelRange = 0;
let wRange = 0;
let muLo = 1;
let muHi = 10;

let HOME: Extent = { cx: 0, cy: 0, halfWidth: 18 };
const ext: Extent = { ...HOME };

const FIELD_TITLES: Record<string, string> = {
  mu: 'Viscosity',
  p: 'Pressure',
  tau: 'Maximum shear stress',
  eII: 'Strain rate',
  vel: 'Velocity magnitude',
  pvel: 'Perturbing velocity magnitude',
  vort: 'Vorticity',
};

function dirOfRun(): number {
  return (run?.mode ?? 'shortening') === 'shortening' ? 1 : -1;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
}

function fmtTick(v: number): string {
  return String(Number(v.toPrecision(2)));
}

function percentile(vals: number[], q: number): number {
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
}

/** Attach the evaluator, gauge the pressure and grow the shared ranges. */
function prepareFrame(f: FoldingFrame): StoredFrame {
  const evalAt = triEvaluator(f.core);
  const dir = dirOfRun();
  const ps: number[] = [];
  const taus: number[] = [];
  const vels: number[] = [];
  const eIIs: number[] = [];
  const pvels: number[] = [];
  const ws: number[] = [];
  let mMin = Infinity;
  let mMax = 0;
  const N = 64;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * 2 * f.halfW;
      const y = ((j + 0.5) / N - 0.5) * 2 * f.halfH;
      const s = evalAt(x, y);
      if (!s) continue;
      ps.push(s.p);
      taus.push(s.tau);
      vels.push(Math.hypot(s.u, s.v));
      eIIs.push(s.eII);
      pvels.push(Math.hypot(s.u + dir * x, s.v - dir * y));
      ws.push(Math.abs(s.w));
      if (s.mu < mMin) mMin = s.mu;
      if (s.mu > mMax) mMax = s.mu;
    }
  }
  const pShift = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
  pRange = Math.max(pRange, percentile(ps.map((p) => Math.abs(p - pShift)), 0.98));
  tauRange = Math.max(tauRange, percentile(taus, 0.98));
  velRange = Math.max(velRange, percentile(vels, 0.98));
  eIIRange = Math.max(eIIRange, percentile(eIIs, 0.98));
  pvelRange = Math.max(pvelRange, percentile(pvels, 0.98));
  wRange = Math.max(wRange, percentile(ws, 0.98));
  muLo = Math.min(muLo, mMin);
  muHi = Math.max(muHi, mMax);
  return { ...f, evalAt, pShift };
}

// --- field rendering ---------------------------------------------------------

function ink(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
}

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

function muted(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
}

function worldToPx(x: number, y: number): [number, number] {
  const s = FULL / (2 * ext.halfWidth);
  return [FULL / 2 + (x - ext.cx) * s, FULL / 2 - (y - ext.cy) * s];
}

/** The raw value of the selected field at a sample. */
function rawValue(
  f: StoredFrame,
  x: number,
  y: number,
  s: NonNullable<ReturnType<StoredFrame['evalAt']>>,
): number {
  const dir = dirOfRun();
  switch (fieldSel.value) {
    case 'mu':
      return s.mu;
    case 'p':
      return s.p - f.pShift;
    case 'tau':
      return s.tau;
    case 'eII':
      return s.eII;
    case 'pvel':
      return Math.hypot(s.u + dir * x, s.v - dir * y);
    case 'vort':
      return s.w;
    default:
      return Math.hypot(s.u, s.v);
  }
}

/** The automatic colour range of the selected field (grown over all frames
 *  so colours stay comparable through the run); viscosity is logarithmic. */
function autoRange(): [number, number] {
  switch (fieldSel.value) {
    case 'mu':
      return [muLo, muHi];
    case 'p':
      return [-niceNum(pRange), niceNum(pRange)];
    case 'tau':
      return [0, niceNum(tauRange)];
    case 'eII':
      return [0, niceNum(eIIRange)];
    case 'pvel':
      return [0, niceNum(pvelRange)];
    case 'vort':
      return [-niceNum(wRange), niceNum(wRange)];
    default:
      return [0, niceNum(velRange)];
  }
}

/** The colour range in use: the user's limits when set, else automatic. */
function colorRange(): [number, number] {
  if (crangeSel.value === 'manual') {
    const lo = Number(cminIn.value);
    const hi = Number(cmaxIn.value);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
  }
  return autoRange();
}

function fieldValue(
  f: StoredFrame,
  x: number,
  y: number,
  s: NonNullable<ReturnType<StoredFrame['evalAt']>>,
): number {
  const v = rawValue(f, x, y, s);
  const [lo, hi] = colorRange();
  if (fieldSel.value === 'mu') {
    const l = Math.max(1e-12, lo);
    return Math.log(Math.max(v, 1e-12) / l) / Math.max(1e-12, Math.log(Math.max(hi, l * 1.0001) / l));
  }
  return (v - lo) / (hi - lo || 1e-12);
}

function drawField(settled = true) {
  const ctx = cvField.getContext('2d')!;
  cvField.width = FULL;
  cvField.height = FULL;
  ctx.clearRect(0, 0, FULL, FULL);
  const f = frames[current];
  if (!f) {
    drawPreview(ctx);
    if (progressNote) {
      ctx.fillStyle = ink();
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(progressNote, FULL / 2, 28);
    }
    return;
  }
  const res = settled ? FULL : FULL / 2;
  const buf = new Uint8ClampedArray(res * res * 4);
  const scale = (2 * ext.halfWidth) / res;
  for (let j = 0; j < res; j++) {
    const y = ext.cy + (res / 2 - (j + 0.5)) * scale;
    for (let i = 0; i < res; i++) {
      const x = ext.cx + (i + 0.5 - res / 2) * scale;
      const s = f.evalAt(x, y);
      if (!s) continue;
      const t = Math.max(0, Math.min(1, fieldValue(f, x, y, s)));
      const ci = Math.round(t * (LUT_N - 1)) * 3;
      const k = (j * res + i) * 4;
      buf[k] = lut[ci];
      buf[k + 1] = lut[ci + 1];
      buf[k + 2] = lut[ci + 2];
      buf[k + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = res;
  off.height = res;
  off.getContext('2d')!.putImageData(new ImageData(buf, res, res), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, FULL, FULL);
  if (meshToggle.checked && settled) drawMesh(ctx, f);
  drawInterfaces(ctx, f);
  drawBox(ctx, f);
}

function drawMesh(ctx: CanvasRenderingContext2D, f: StoredFrame) {
  ctx.strokeStyle = ink();
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  const { tri6, nodeX, nodeY } = f.core;
  for (let e = 0; e < f.core.elements; e++) {
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

interface Geometry {
  faces: Array<{ X: Float64Array; Y: Float64Array }>;
  halfW: number;
  halfH: number;
}

/** The initial geometry for the current inputs: no meshing, no solve, so it
 *  redraws at once while the inputs change. Shown until a run has frames. */
function drawPreview(ctx: CanvasRenderingContext2D) {
  const g = geometryFromInputs();
  Object.assign(ext, HOME);
  drawInterfaces(ctx, g);
  drawBox(ctx, g);
  ctx.fillStyle = ink();
  ctx.globalAlpha = 0.6;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(worker ? 'initial geometry' : 'initial geometry: press Run to solve', 12, FULL - 12);
  ctx.globalAlpha = 1;
}

function drawInterfaces(ctx: CanvasRenderingContext2D, f: Geometry) {
  ctx.strokeStyle = ink();
  ctx.lineWidth = 1.75;
  for (const face of f.faces) {
    ctx.beginPath();
    for (let i = 0; i < face.X.length; i++) {
      const [px, py] = worldToPx(face.X[i], face.Y[i]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawBox(ctx: CanvasRenderingContext2D, f: Geometry) {
  ctx.strokeStyle = ink();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  const [x0, y0] = worldToPx(-f.halfW, f.halfH);
  const [x1, y1] = worldToPx(f.halfW, -f.halfH);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
}

function drawColorbar() {
  const canvas = $<HTMLCanvasElement>('cb-field');
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
  const [lo, hi] = colorRange();
  const mid = fieldSel.value === 'mu' ? Math.sqrt(Math.max(lo, 1e-12) * hi) : (lo + hi) / 2;
  // the automatic limits are shown in the inputs so "Set below" starts from them
  if (crangeSel.value === 'auto') {
    cminIn.value = String(Number(lo.toPrecision(3)));
    cmaxIn.value = String(Number(hi.toPrecision(3)));
  }
  $('tick-min').textContent = fmtTick(lo);
  $('tick-mid').textContent = fmtTick(mid);
  $('tick-max').textContent = fmtTick(hi);
}

// --- growth-rate theory selection ------------------------------------------------

interface Theory {
  q: (k: number) => number;
  label: string;
}

/**
 * The analytical growth-rate curve applicable to a parameter set, or null
 * (multilayer and noise runs have no single-curve prediction here). The
 * converged Picard iterations reproduce these small-amplitude rates,
 * linear and power-law alike (verified in check_folding.ts); the power-law
 * expressions assume an unbounded matrix, so a few percent of boundary
 * effect remain there.
 */
function theoryFor(
  R: number,
  nl: number,
  nm: number,
  mode: StrainMode,
  layers: number,
  perturbation: string,
  boxHeight: number,
): Theory | null {
  if (layers > 1 || perturbation !== 'sine') return null;
  const H = boxHeight / 2;
  if (nl === 1 && nm === 1) {
    return mode === 'shortening'
      ? { q: (k) => qFletcherBounded(k, R, H), label: 'Fletcher (1977), linear theory' }
      : { q: (k) => qNeckBounded(k, R, H), label: 'Johnson & Fletcher (1994), linear theory' };
  }
  return mode === 'shortening'
    ? { q: (k) => qPowerLawThick(k, R, nl, nm, false), label: 'Fletcher (1974), power law' }
    : { q: (k) => qPowerLawThick(k, R, nl, nm, true), label: 'Pollard & Fletcher (2005), power law' };
}

// --- frame navigation -----------------------------------------------------------

function showFrame(i: number) {
  if (i < 0 || i >= frames.length) return;
  current = i;
  frameIn.value = String(i);
  const f = frames[i];
  frameLabel.textContent =
    `step ${f.step}/${f.nSteps}, ${f.strain.toFixed(1)}% ${run?.mode ?? 'shortening'}, ` +
    `A/A0 = ${(f.amplitude / (frames[0].amplitude || 1e-12)).toFixed(2)}`;
  const solveMs = f.solveMs;
  summaryEl.hidden = false;
  summaryEl.innerHTML =
    `<div class="run-facts">This step: <b>${f.core.elements.toLocaleString('en')}</b> elements, ` +
    `<b>${(f.core.dofs + 2 * f.core.elements).toLocaleString('en')}</b> unknowns, meshed and solved in <b>${fmt(solveMs)}</b>` +
    (f.picardIterations > 1
      ? ` with <b>${f.picardIterations}</b> Picard iterations (last relative viscosity change ${f.picardChange.toExponential(1)}` +
        `${f.picardChange >= 1e-2 ? ', not yet below the 1e-2 tolerance' : ''})`
      : '') +
    (threadNote ? `, ${threadNote}` : '') +
    '.</div>' +
    (runTotalMs !== null
      ? `<div class="run-facts">The whole run: <b>${fmt(runTotalMs)}</b> for ${run?.nSteps ?? frames.length - 1} time steps.</div>`
      : '');
  drawField();
  drawColorbar();
  drawGrowth();
}

let playTimer: number | null = null;

function stopPlay() {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = 'Play';
  }
}

playBtn.addEventListener('click', () => {
  if (playTimer !== null) {
    stopPlay();
    return;
  }
  if (!frames.length) return;
  if (current >= frames.length - 1) showFrame(0);
  playBtn.textContent = 'Pause';
  playTimer = window.setInterval(() => {
    if (current >= frames.length - 1) {
      stopPlay();
      return;
    }
    showFrame(current + 1);
  }, 250);
});

frameIn.addEventListener('input', () => {
  stopPlay();
  showFrame(Number(frameIn.value));
});

// --- controls ------------------------------------------------------------------

function syncPair(range: HTMLInputElement, num: HTMLInputElement) {
  range.addEventListener('input', () => (num.value = range.value));
  num.addEventListener('input', () => (range.value = num.value));
}
syncPair(wlIn, wlNum);
syncPair(strainIn, strainNum);
syncPair(stepsIn, stepsNum);

/** The amplitude rate a sine perturbation grows at, per unit strain: under
 *  shortening the dynamic part q on top of the kinematic thickening, under
 *  extension the total -(1 + q), since a layer only necks when the dynamic
 *  thinning outruns the kinematic one (see amplitudeTheory). The dominant
 *  wavelength maximizes this. */
function growthRateOf(q: (k: number) => number, mode: StrainMode): (k: number) => number {
  return mode === 'shortening' ? q : (k) => -(1 + q(k));
}

// --- growth-rate curve (analytical, live) -------------------------------------------
// The growth-rate window of the original FOLDER, folded into the perturbation
// box: the amplitude growth rate per unit strain against wavelength for the
// current layer, from the closed forms in growth.ts. Shortening plots the
// dynamic rate q on top of the kinematic thickening; extension plots the
// necking rate -(1 + q), positive where a layer necks.
const growthDetails = $<HTMLDetailsElement>('growth');
const cvGrowth = $<HTMLCanvasElement>('cv-growth');
const growthNote = $('growth-note');
const growthLegend = $('growth-legend');
const gaxisSel = $<HTMLSelectElement>('in-gaxis');

/** The growth rate the run itself measured: the instantaneous dlnA/dt from
 *  the first solve's velocity field, which for a single sine layer is the
 *  quantity the analytical curves predict at the chosen wavelength.
 *  Shortening: dlnA/dt = 1 + q, so q = dlnA/dt - 1; extension: the necking
 *  rate -(1 + q) = dlnA/dt directly (see growth.ts, amplitudeTheory). It
 *  tests the solver, not the time stepping: that is what the step warning
 *  below is for. */
function measuredGrowth(): { lam: number; rate: number } | null {
  const trail = measuredTrail();
  return trail.length && trail[0].frame === 0 ? trail[0] : null;
}

/** Mean vertical distance between a layer's two interfaces: the area between
 *  them over the box width (trapezoid rule along each polyline). */
function meanThickness(bottom: Face, top: Face): number {
  const area = (f: Face) => {
    let a = 0;
    for (let i = 1; i < f.X.length; i++) a += (f.X[i] - f.X[i - 1]) * (f.Y[i] + f.Y[i - 1]) / 2;
    return a / (f.X[f.X.length - 1] - f.X[0]);
  };
  return area(top) - area(bottom);
}

/** The same measurement at every step of the run, each at that step's
 *  wavelength over thickness: the wavelength shrinks with the box and the
 *  layer thickens, so the points walk along the curve while the fold is
 *  small and fall below it once the amplitude is finite. */
function measuredTrail(): Array<{ frame: number; lam: number; rate: number }> {
  if (!run || !frames.length || run.perturbation !== 'sine' || run.layers > 1) return [];
  const waves = Math.round(run.boxWidth / run.wavelength);
  const out: Array<{ frame: number; lam: number; rate: number }> = [];
  frames.forEach((f, i) => {
    const g = f.growthRate;
    const n = f.faces.length;
    if (!Number.isFinite(g) || n < 2) return;
    const h = meanThickness(f.faces[n - 2], f.faces[n - 1]);
    if (!(h > 0)) return;
    out.push({ frame: i, lam: (2 * f.halfW) / waves / h, rate: run!.mode === 'shortening' ? g - 1 : g });
  });
  return out;
}

/** How much the amplitude grows per time step at the chosen wavelength,
 *  e^((1+q) dt); the Heun step follows this only while it stays modest. */
function stepGrowth(m: ReturnType<typeof readModel>, rateAtChosen: number): { factor: number; stepsNeeded: number } {
  const T = m.mode === 'shortening' ? -Math.log(1 - m.strainPct / 100) : Math.log(1 + m.strainPct / 100);
  const dlnA = Math.max(0, m.mode === 'shortening' ? 1 + rateAtChosen : rateAtChosen);
  // growth of ln A per step of at most 0.3 keeps the Heun step within a few percent
  return { factor: Math.exp(dlnA * (T / m.nSteps)), stepsNeeded: Math.ceil((dlnA * T) / 0.3) };
}

function drawGrowth() {
  if (!growthDetails.open) return;
  const m = readModel();
  const H = m.boxHeight / 2;
  const necking = m.mode === 'extension';
  const rate = (q: (k: number) => number) => (k: number) => (necking ? -(1 + q(k)) : q(k));
  const linear = m.nl === 1 && m.nm === 1;
  const curves: Array<{ label: string; f: (k: number) => number; color: string; dash?: number[] }> = linear
    ? necking
      ? [
          { label: 'unbounded matrix (Johnson & Fletcher 1994)', f: rate((k) => qNeckThick(k, m.R)), color: ink(), dash: [5, 4] },
          { label: 'the walls of this box', f: rate((k) => qNeckBounded(k, m.R, H)), color: accent() },
        ]
      : [
          { label: 'thin plate (Biot 1961)', f: rate((k) => qBiotThin(k, m.R)), color: muted(), dash: [2, 4] },
          { label: 'thick plate, unbounded matrix (Fletcher 1977)', f: rate((k) => qFletcherThick(k, m.R)), color: ink(), dash: [5, 4] },
          { label: 'thick plate, the walls of this box', f: rate((k) => qFletcherBounded(k, m.R, H)), color: accent() },
        ]
    : [
        {
          label: necking ? 'power law, unbounded matrix (Pollard & Fletcher 2005)' : 'power law, unbounded matrix (Fletcher 1974)',
          f: rate((k) => qPowerLawThick(k, m.R, m.nl, m.nm, necking)),
          color: accent(),
        },
      ];
  const dpr = window.devicePixelRatio || 1;
  const W = cvGrowth.clientWidth || 340;
  const Hc = 220;
  cvGrowth.width = W * dpr;
  cvGrowth.height = Hc * dpr;
  const ctx = cvGrowth.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, Hc);
  const ML = 44, MR = 10, MT = 10, MB = 30;
  // FOLDER's window plotted 1 to 50 on a linear axis by default, with a log option
  const logAxis = gaxisSel.value === 'log';
  const lamMin = logAxis ? 2 : 1, lamMax = logAxis ? 200 : 50;
  const N = 200;
  const lams = Array.from({ length: N + 1 }, (_, i) =>
    logAxis ? lamMin * Math.pow(lamMax / lamMin, i / N) : lamMin + ((lamMax - lamMin) * i) / N,
  );
  const series = curves.map((c) => lams.map((lam) => c.f((2 * Math.PI) / lam)));
  const finite = series.flat().filter(Number.isFinite);
  let yMax = Math.max(0.5, ...finite);
  let yMin = Math.min(0, ...finite);
  // the necking curves dive far below zero at short wavelengths; clip the view
  // to what matters, the positive part and a little below
  if (necking) yMin = Math.max(yMin, -0.6 * yMax - 0.1);
  else yMin = Math.max(yMin, -0.1 * yMax);
  yMax *= 1.08;
  const px = (lam: number) =>
    ML +
    (logAxis
      ? (Math.log10(lam) - Math.log10(lamMin)) / Math.log10(lamMax / lamMin)
      : (lam - lamMin) / (lamMax - lamMin)) *
      (W - ML - MR);
  const py = (v: number) => MT + (1 - (v - yMin) / (yMax - yMin)) * (Hc - MT - MB);
  // frame, zero line, ticks
  ctx.strokeStyle = muted();
  ctx.fillStyle = muted();
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  ctx.strokeRect(ML, MT, W - ML - MR, Hc - MT - MB);
  if (yMin < 0) {
    ctx.beginPath(); ctx.moveTo(ML, py(0)); ctx.lineTo(W - MR, py(0)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const lam of logAxis ? [2, 5, 10, 20, 50, 100, 200] : [1, 10, 20, 30, 40, 50]) ctx.fillText(String(lam), px(lam), Hc - MB + 14);
  ctx.fillText('wavelength / thickness', ML + (W - ML - MR) / 2, Hc - 4);
  // y ticks at a round step, with faint gridlines
  const span = yMax - yMin;
  const mag = 10 ** Math.floor(Math.log10(span / 4));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((st) => span / st <= 6) ?? mag * 10;
  ctx.textAlign = 'right';
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
    const y = py(v);
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - MR, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(Number(v.toPrecision(3))), ML - 4, y + 4);
  }
  ctx.save();
  ctx.translate(11, MT + (Hc - MT - MB) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(necking ? 'necking rate' : 'growth rate q', 0, 0);
  ctx.restore();
  // curves
  curves.forEach((c, ci) => {
    ctx.strokeStyle = c.color;
    ctx.lineWidth = ci === curves.length - 1 ? 2 : 1.4;
    ctx.setLineDash(c.dash ?? []);
    ctx.beginPath();
    let pen = false;
    series[ci].forEach((v, i) => {
      if (!Number.isFinite(v) || v < yMin - 1e9) { pen = false; return; }
      const x = px(lams[i]), y = Math.max(MT, py(Math.min(v, yMax)));
      pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      pen = true;
    });
    ctx.stroke();
    ctx.setLineDash([]);
  });
  // the chosen wavelength (sine and triangle) and the dominant one of the last curve
  const main = curves[curves.length - 1];
  const ld = dominantWavelengthOf(main.f);
  const periodic = m.perturbation === 'sine' || m.perturbation === 'triangle';
  if (periodic && m.boxWidth / m.waves <= lamMax) {
    const lam = m.boxWidth / m.waves;
    ctx.strokeStyle = ink();
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px(lam), MT); ctx.lineTo(px(lam), Hc - MB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  if (ld && ld <= lamMax) {
    ctx.fillStyle = accent();
    ctx.beginPath(); ctx.arc(px(ld), py(main.f((2 * Math.PI) / ld)), 4, 0, 2 * Math.PI); ctx.fill();
  }
  // the run's own measurement, if the run matches what the curve shows
  const meas = measuredGrowth();
  const runMatches =
    meas && run && run.R === m.R && run.nl === m.nl && run.nm === m.nm && run.mode === m.mode && meas.lam <= lamMax;
  if (meas && runMatches) {
    // the later steps as a trail of small dots, the step on display filled larger
    const trail = measuredTrail().filter((t) => t.lam >= lamMin && t.lam <= lamMax);
    const tx = (t: { lam: number; rate: number }) => [px(t.lam), py(Math.max(yMin, Math.min(yMax, t.rate)))];
    ctx.strokeStyle = ink();
    ctx.fillStyle = ink();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    trail.forEach((t, i) => {
      const [x, y] = tx(t);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    for (const t of trail) {
      if (t.frame === 0) continue;
      const [x, y] = tx(t);
      ctx.beginPath(); ctx.arc(x, y, t.frame === current ? 4 : 2.2, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const x = px(meas.lam), y = py(Math.max(yMin, Math.min(yMax, meas.rate)));
    // open diamond in ink, so it reads on top of the curve and the dominant-wavelength dot
    ctx.strokeStyle = ink();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath();
    ctx.stroke();
  }
  // legend, as text under the chart (the chart is too narrow to hold it)
  growthLegend.innerHTML = curves
    .map(
      (c) =>
        `<span><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="${c.color}" stroke-width="2"` +
        `${c.dash ? ` stroke-dasharray="${c.dash.join(' ')}"` : ''}/></svg>${c.label.replace('&', '&amp;')}</span>`,
    )
    .join('');
  const lamChosen = periodic ? m.boxWidth / m.waves : null;
  const rateAtChosen = lamChosen ? main.f((2 * Math.PI) / lamChosen) : NaN;
  const theoryAtRun = meas ? main.f((2 * Math.PI) / meas.lam) : NaN;
  const { factor, stepsNeeded } = lamChosen ? stepGrowth(m, rateAtChosen) : { factor: 1, stepsNeeded: 0 };
  growthNote.textContent =
    (lamChosen ? `Dotted: the chosen wavelength, ${lamChosen.toFixed(1)} h, rate ${rateAtChosen.toFixed(2)}. ` : '') +
    (ld ? `Dot: the dominant wavelength, ${ld.toFixed(1)} h. ` : 'No growing wavelength on the highlighted curve. ') +
    (meas && runMatches
      ? `Diamond: the solver's own rate from the run's first velocity field, ${meas.rate.toFixed(2)}, against ${theoryAtRun.toFixed(2)} from theory` +
        (Number.isFinite(theoryAtRun) && theoryAtRun !== 0 ? ` (${(100 * Math.abs(meas.rate / theoryAtRun - 1)).toFixed(1)}% off). ` : '. ') +
        (frames.length > 1
          ? 'Small dots: the same measurement at every later step, each at that step\'s wavelength over thickness (the larger dot is the step on display). '
          : '')
      : run && frames.length
        ? 'A run with a single sine layer adds the solver\'s measured rate here. '
        : '') +
    (lamChosen && factor > 1.35
      ? `At this rate the amplitude grows ${factor.toFixed(1)}× per time step; the time integration is accurate only while that stays small, so use at least ${stepsNeeded} steps for this strain.`
      : '');
}
growthDetails.addEventListener('toggle', drawGrowth);
gaxisSel.addEventListener('change', drawGrowth);
window.addEventListener('resize', drawGrowth);

function updateNotes() {
  const mode = modeSel.value as StrainMode;
  const nl = Math.max(1, Number(nlIn.value) || 1);
  const R = Math.max(2, Number(rIn.value) || 100);
  const nm = Math.max(1, Number(nmIn.value) || 1);
  // the physical reference: a layer in an unbounded matrix; the walls of this
  // box shift it, and the bounded solution says by how much
  const th = theoryFor(R, nl, nm, mode, 1, 'sine', 1e6)!;
  const ld = dominantWavelengthOf(growthRateOf(th.q, mode));
  const thBox = theoryFor(R, nl, nm, mode, 1, 'sine', readModel().boxHeight)!;
  const ldBox = dominantWavelengthOf(growthRateOf(thBox.q, mode));
  const wallNote =
    ld && ldBox && Math.abs(ldBox - ld) / ld > 0.02
      ? ` In this box the walls shift it to ${ldBox.toFixed(1)} h (bounded solution).`
      : '';
  wlNote.innerHTML = ld
    ? `For a single layer with these properties the dominant ${mode === 'shortening' ? 'fold' : 'necking'} wavelength is <b>${ld.toFixed(1)} h</b> (${th.label.replace('&', '&amp;')}).${wallNote}`
    : mode === 'extension' && nl === 1
      ? 'A linear viscous layer thins but does not neck: give the layer a stress exponent above 1.'
      : 'No growing wavelength for these parameters.';
  drawGrowth();
}
for (const el of [rIn, nlIn, nmIn, modeSel, layersIn, spacingIn, marginIn, pertSel, wlIn, wlNum]) {
  el.addEventListener('input', updateNotes);
  el.addEventListener('change', updateNotes);
}

/** The box and run geometry for the current inputs, as the run will use them. */
function readModel() {
  const R = Math.max(2, Number(rIn.value) || 100);
  const nl = Math.max(1, Number(nlIn.value) || 1);
  const nm = Math.max(1, Number(nmIn.value) || 1);
  const mode = modeSel.value as StrainMode;
  const layers = Math.max(1, Math.min(5, Math.round(Number(layersIn.value) || 1)));
  const spacing = Math.max(1.5, Number(spacingIn.value) || 3);
  const perturbation = pertSel.value as Perturbation;
  const wl = Math.max(4, Number(wlIn.value) || 16);
  // whole sine or triangle waves must fit the box; widen it for long ones
  const periodic = perturbation === 'sine' || perturbation === 'triangle';
  const waves = periodic ? Math.max(1, Math.round(32 / wl)) : 1;
  const boxWidth = periodic ? waves * wl : 32;
  const stack = (layers - 1) * spacing + 1;
  const margin = Math.max(2, Number(marginIn.value) || 7.5);
  const boxHeight = stack + 2 * margin;
  const hurst = Number(hurstIn.value);
  const width =
    perturbation === 'fractal' ? Math.min(1, Math.max(0, Number.isFinite(hurst) && hurstIn.value !== '' ? hurst : 0.5))
    : perturbation === 'bell' ? Math.max(0.5, Number(bellIn.value) || 4)
    : undefined;
  const strainPct = Number(strainIn.value);
  const nSteps = Number(stepsIn.value);
  const res = RES[resSel.value as keyof typeof RES];
  const amp0 = Math.max(0.001, Number(ampIn.value) || 0.02);
  return { R, nl, nm, mode, layers, spacing, perturbation, wl, waves, boxWidth, boxHeight, strainPct, nSteps, res, amp0, width };
}

function homeFor(m: ReturnType<typeof readModel>): Extent {
  const growFactor = 1 + m.strainPct / 100;
  return {
    cx: 0,
    cy: 0,
    halfWidth:
      1.06 *
      (m.mode === 'shortening'
        ? Math.max(m.boxWidth / 2, m.boxHeight / 2 / (1 - m.strainPct / 100))
        : Math.max((m.boxWidth / 2) * growFactor, m.boxHeight / 2)),
  };
}

function geometryFromInputs(): Geometry {
  const m = readModel();
  const p: ModelParams = {
    boxWidth: m.boxWidth,
    boxHeight: m.boxHeight,
    nx: Math.round(m.res.nodesPerH * m.boxWidth) + 1,
    layers: m.layers,
    spacing: m.spacing,
    perturbation: m.perturbation,
    amp0: m.amp0,
    wavelength: m.wl,
    width: m.width,
    seed: 42,
    mode: m.mode,
  };
  HOME = homeFor(m);
  return initialState(p);
}

/** A model input changed: the frames on screen no longer belong to these
 *  inputs, so drop them and show the new initial geometry instead. */
function inputsChanged() {
  if (worker) return; // a run in progress keeps its own parameters
  if (frames.length) {
    frames = [];
    current = -1;
    run = null;
    frameIn.max = '0';
    frameIn.value = '0';
    frameIn.disabled = true;
    playBtn.disabled = true;
    frameLabel.textContent = 'inputs changed, press Run';
    summaryEl.hidden = true;
    status.textContent = 'idle';
    drawColorbar();
  }
  drawField();
}
for (const el of [rIn, nlIn, nmIn, modeSel, layersIn, spacingIn, marginIn, pertSel, wlIn, wlNum, ampIn, hurstIn, bellIn, strainIn, strainNum, stepsIn, stepsNum, resSel]) {
  el.addEventListener('input', inputsChanged);
  el.addEventListener('change', inputsChanged);
}

function updateVisibility() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-for]')) {
    el.style.display = el.dataset.for!.split(' ').includes(pertSel.value) ? '' : 'none';
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-multi]')) {
    el.style.display = Number(layersIn.value) > 1 ? '' : 'none';
  }
}
pertSel.addEventListener('change', updateVisibility);
layersIn.addEventListener('input', updateVisibility);
// --- remember the inputs (localStorage, best effort) ---------------------------
const LS_KEY = 'milamin-folder-inputs';
const REMEMBERED = [
  'in-mode', 'in-r', 'in-nl', 'in-nm', 'in-layers', 'in-spacing', 'in-margin',
  'in-pert', 'in-wl', 'num-wl', 'in-hurst', 'in-bell', 'in-amp',
  'in-strain', 'num-strain', 'in-steps', 'num-steps', 'in-res', 'in-threads',
  'in-field', 'in-cmap', 'in-levels', 'in-mesh', 'in-gaxis',
];
function saveInputs() {
  try {
    const o: Record<string, string | boolean> = {};
    for (const id of REMEMBERED) {
      const el = $<HTMLInputElement>(id);
      o[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}
/** the inputs as URL hash parameters (ids without their in-/num- prefix) */
function inputsToHash(): string {
  const q = new URLSearchParams();
  for (const id of REMEMBERED) {
    if (id.startsWith('num-')) continue; // twins of the range inputs
    const el = $<HTMLInputElement>(id);
    q.set(id.replace(/^in-/, ''), el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
  }
  return q.toString();
}

function inputsFromHash(hash: string): Record<string, string | boolean> | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  if (![...q.keys()].length) return null;
  const o: Record<string, string | boolean> = {};
  for (const id of REMEMBERED) {
    const key = id.replace(/^(in|num)-/, '');
    const v = q.get(key);
    if (v === null) continue;
    o[id] = $<HTMLInputElement>(id).type === 'checkbox' ? v === '1' : v;
  }
  return o;
}

function restoreInputs() {
  try {
    // a shared link wins over what this browser remembers
    const fromLink = inputsFromHash(location.hash);
    const raw = localStorage.getItem(LS_KEY);
    if (!fromLink && !raw) return;
    const o = fromLink ?? (JSON.parse(raw!) as Record<string, string | boolean>);
    for (const id of REMEMBERED) {
      if (!(id in o)) continue;
      const el = $<HTMLInputElement>(id);
      if (el.type === 'checkbox') el.checked = Boolean(o[id]);
      else el.value = String(o[id]);
    }
    panelTitle.textContent = FIELD_TITLES[fieldSel.value];
    lut = buildLut();
  } catch {
    /* a stale or foreign value: keep the defaults */
  }
}
restoreInputs();
if (location.hash.length > 1) saveInputs(); // a shared model becomes the remembered one
for (const id of REMEMBERED) {
  $(id).addEventListener('input', saveInputs);
  $(id).addEventListener('change', saveInputs);
}
$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${inputsToHash()}`;
  history.replaceState(null, '', url);
  const note = $('share-note');
  try {
    await navigator.clipboard.writeText(url);
    note.textContent = 'link copied';
  } catch {
    note.textContent = 'link is in the address bar';
  }
  setTimeout(() => (note.textContent = ''), 4000);
});
$('reset').addEventListener('click', () => {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* nothing stored */
  }
  location.reload();
});

updateVisibility();
updateNotes();
summaryEl.classList.add('run-summary');
summaryEl.hidden = true;
drawField();

// Enlarge: both panels full width at double resolution
const panelsEl = document.querySelector<HTMLElement>('.panels')!;
for (const b of document.querySelectorAll<HTMLButtonElement>('.panel-tools .enlarge')) {
  b.addEventListener('click', () => {
    const large = !panelsEl.classList.contains('large');
    panelsEl.classList.toggle('large', large);
    FULL = large ? 1400 : 760;
    for (const x of document.querySelectorAll<HTMLButtonElement>('.panel-tools .enlarge')) {
      x.textContent = large ? 'Shrink' : 'Enlarge';
    }
    drawField();
  });
}

attachPanZoom([cvField], ext, () => HOME, (settled) => drawField(settled));
cmapSelect.addEventListener('change', () => {
  lut = buildLut();
  drawColorbar();
  drawField();
});
levelsSelect.addEventListener('change', () => {
  lut = buildLut();
  drawColorbar();
  drawField();
});
meshToggle.addEventListener('change', () => drawField());
fieldSel.addEventListener('change', () => {
  panelTitle.textContent = FIELD_TITLES[fieldSel.value];
  crangeSel.value = 'auto'; // limits belong to a field; a new field starts automatic
  updateCrange();
  drawColorbar();
  drawField();
});
function updateCrange() {
  const manual = crangeSel.value === 'manual';
  for (const el of document.querySelectorAll<HTMLElement>('[data-crange]')) el.style.display = manual ? '' : 'none';
  drawColorbar();
  drawField();
}
crangeSel.addEventListener('change', updateCrange);
for (const el of [cminIn, cmaxIn]) el.addEventListener('input', () => { if (crangeSel.value === 'manual') { drawColorbar(); drawField(); } });
updateCrange();

// --- PNG export ------------------------------------------------------------------

function exportPanel() {
  if (!frames.length || !run) return;
  const f = frames[current];
  const title = `${FIELD_TITLES[fieldSel.value]} at ${f.strain.toFixed(0)}% ${run.mode}`;
  const M = 24;
  const W = FULL + 2 * M;
  const yField = M + 34;
  const H = yField + FULL + 48 + M;
  const ec = document.createElement('canvas');
  ec.width = W;
  ec.height = H;
  const ctx = ec.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111111';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText(title, M, M + 20);
  ctx.fillStyle = '#f2f2f0';
  ctx.fillRect(M, yField, FULL, FULL);
  ctx.drawImage(cvField, M, yField);
  ctx.fillStyle = '#555555';
  ctx.font = '14px system-ui, sans-serif';
  const rheo =
    run.nl === 1 && run.nm === 1 ? 'linear viscous' : `power law nl=${run.nl}, nm=${run.nm}`;
  ctx.fillText(
    `viscosity ratio ${run.R}, ${rheo}, ${run.layers} layer${run.layers > 1 ? 's' : ''}, ` +
      `${run.perturbation} perturbation, ${run.strainPct}% ${run.mode} in ${run.nSteps} steps`,
    M,
    yField + FULL + 28,
  );
  const a = document.createElement('a');
  a.download = `folder-${fieldSel.value}.png`;
  a.href = ec.toDataURL('image/png');
  a.click();
}
$('dl-field').addEventListener('click', () => exportPanel());

// --- run orchestration -------------------------------------------------------------

runBtn.addEventListener('click', () => {
  if (worker) {
    worker.terminate();
    worker = null;
    document.body.classList.remove('solving');
    progressNote = '';
    runBtn.textContent = 'Run';
    status.textContent = `stopped after ${frames.length} frames`;
    drawField();
    return;
  }
  stopPlay();
  const { R, nl, nm, mode, layers, spacing, perturbation, wl, waves, boxWidth, boxHeight, strainPct, nSteps, res, amp0, width } =
    readModel();
  run = {
    R,
    nl,
    nm,
    mode,
    layers,
    perturbation,
    strainPct,
    nSteps,
    boxWidth,
    boxHeight,
    wavelength: boxWidth / waves,
  };
  frames = [];
  current = -1;
  pRange = tauRange = velRange = eIIRange = pvelRange = wRange = 0;
  muLo = Infinity;
  muHi = 0;
  runTotalMs = null;
  summaryEl.hidden = true;
  HOME = homeFor(readModel());
  Object.assign(ext, HOME);
  document.body.classList.add('solving');
  frameIn.min = '0';
  frameIn.max = '0';
  frameIn.value = '0';
  frameIn.disabled = true;
  playBtn.disabled = true;
  runBtn.textContent = 'Stop';
  status.textContent = 'starting worker';
  progressNote = 'starting the solver';
  drawField();

  const req: FoldingRequest = {
    params: {
      R,
      nLayer: nl,
      nMatrix: nm,
      mode,
      layers,
      spacing,
      perturbation,
      amp0,
      wavelength: wl,
      width,
      seed: 42,
      boxWidth,
      boxHeight,
      nx: Math.round(res.nodesPerH * boxWidth) + 1,
      strainPct,
      nSteps,
      areaLayer: res.areaLayer,
      areaMatrix: res.areaMatrix,
      backend: 'sparse',
    },
    threads: readThreads(threadsIn, THREAD_CAP),
  };
  worker = new Worker(new URL('./folding-worker.ts', import.meta.url), { type: 'module' });
  worker.onerror = (e) => {
    status.textContent = `worker failed: ${e.message || 'script did not load'}${
      e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''
    }`;
    document.body.classList.remove('solving');
    runBtn.textContent = 'Run';
    worker?.terminate();
    worker = null;
  };
  worker.onmessage = (ev: MessageEvent<FoldingMessage>) => {
    const msg = ev.data;
    if ('booted' in msg) {
      status.textContent = 'worker started, loading wasm modules';
      progressNote = 'loading the solver';
      drawField();
    } else if ('threads' in msg) {
      threadNote = !msg.isolated
        ? 'single-threaded (no cross-origin isolation)'
        : msg.threads > 1
          ? `${msg.threads} threads`
          : '1 thread';
      status.textContent = `running, ${threadNote}`;
    } else if ('progress' in msg) {
      const { step, nSteps, phase, iteration } = msg.progress;
      const what = phase === 'mesh' ? 'meshing' : iteration > 1 ? `solving (Picard ${iteration})` : 'solving';
      status.textContent = `step ${step}/${nSteps}: ${what}, ${threadNote}`;
      if (!frames.length) {
        progressNote = `computing step ${step} of ${nSteps}: ${what}`;
        drawField();
      }
    } else if ('frame' in msg) {
      progressNote = '';
      const follow = current === frames.length - 1;
      frames.push(prepareFrame(msg.frame));
      frameIn.max = String(frames.length - 1);
      frameIn.disabled = false;
      playBtn.disabled = false;
      status.textContent = `step ${msg.frame.step}/${msg.frame.nSteps} done, ${threadNote}`;
      if (follow || frames.length === 1) showFrame(frames.length - 1);
      else drawGrowth();
    } else if ('done' in msg) {
      runTotalMs = msg.totalMs;
      document.body.classList.remove('solving');
      status.textContent = `done in ${fmt(msg.totalMs)}`;
      runBtn.textContent = 'Run';
      worker?.terminate();
      worker = null;
      showFrame(current);
    } else if ('error' in msg) {
      document.body.classList.remove('solving');
      status.textContent = `failed: ${msg.error}`;
      runBtn.textContent = 'Run';
      worker?.terminate();
      worker = null;
    }
  };
  worker.postMessage(req);
});

panelTitle.textContent = FIELD_TITLES[fieldSel.value];
drawColorbar();
