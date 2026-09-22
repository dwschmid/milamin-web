// Million-dof showcase page: run one circular-inclusion Stokes problem at the
// selected size in a worker, show live per-stage timings, then render the
// pressure and max-shear-stress fields. The panels behave like the other FEM
// pages: colormap and quantization selectable, wheel/drag pan-zoom, mesh
// overlay, PNG export.
import './site';
import { triEvaluator, StokesTriCore } from '@fem/stokesfem-tri';
import { COLORMAPS, quantize } from '@viz/colormap';
import { colormapLut, fieldRanges, niceNum, Extent, FieldRange } from '@viz/render';
import { attachPanZoom } from '@viz/panzoom';
import type { MillionMessage } from './million-worker';
import { initThreadInput, readThreads } from './threads';
import { initColorRange } from './color-range';
import { unknowns2008 } from '@fem/unknowns';
import { createRunSummary, StageTime, STAGE_LABELS } from './run-summary';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const targetSel = $<HTMLSelectElement>('in-target');
const threadsIn = $<HTMLSelectElement>('in-threads');
const cmapSelect = $<HTMLSelectElement>('in-cmap');
const levelsSelect = $<HTMLSelectElement>('in-levels');
const meshToggle = $<HTMLInputElement>('in-mesh');
const runBtn = $<HTMLButtonElement>('run');
const status = $('status');
const summary = createRunSummary($('summary'));
const cvP = $<HTMLCanvasElement>('cv-p');
const cvTau = $<HTMLCanvasElement>('cv-tau');

// 2D factorizations plateau at a few threads (see threads.ts); default 4
const THREAD_CAP = 4;
initThreadInput(threadsIn, THREAD_CAP);

for (const [key, { label }] of Object.entries(COLORMAPS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = label;
  cmapSelect.appendChild(opt);
}
cmapSelect.value = 'turbo';

const FULL = 560;
const HOME: Extent = { cx: 0, cy: 0, halfWidth: 2.5 };
const ext: Extent = { ...HOME };
const R_INCL = 1;

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
    drawOutline(ctx);
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

function drawOutline(ctx: CanvasRenderingContext2D, color?: string) {
  ctx.strokeStyle = color ?? ink();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (let i = 0; i <= 128; i++) {
    const t = (2 * Math.PI * i) / 128;
    const [px, py] = worldToPx(R_INCL * Math.cos(t), R_INCL * Math.sin(t));
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
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
  a.download = `milamin-million-${which}.png`;
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

function finishRun(c: StokesTriCore): number {
  const t0 = performance.now();
  core = c;
  evalAt = triEvaluator(c);
  // pressure is defined up to a constant with Dirichlet velocities all around:
  // gauge by the mean over a sampling grid so the range is symmetric
  let pSum = 0;
  let pCnt = 0;
  for (let j = 0; j < 48; j++) {
    for (let i = 0; i < 48; i++) {
      const x = ((i + 0.5) / 48 - 0.5) * 2 * HOME.halfWidth;
      const y = ((j + 0.5) / 48 - 0.5) * 2 * HOME.halfWidth;
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
  runBtn.textContent = 'Stop';
  status.textContent = 'starting worker…';
  worker = new Worker(new URL('./million-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<MillionMessage>) => {
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
      // the worker measured the stages precisely; use its numbers
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
      // let the status paint before the render blocks the main thread
      requestAnimationFrame(() =>
        setTimeout(() => {
          const renderMs = finishRun(msg.core);
          stages[stages.length - 1].ms = renderMs;
          summary.finish(stages, {
            dofs: unknowns2008(msg.core.dofs, msg.core.elements),
            elements: msg.core.elements,
            threadNote,
            compare2008: true,
          });
          endRun();
          status.textContent = 'done';
          runBtn.textContent = 'Run';
          worker?.terminate();
          worker = null;
        }),
      );
    } else if ('error' in msg) {
      endRun();
      status.textContent = `failed: ${msg.error}`;
      runBtn.textContent = 'Run';
      worker?.terminate();
      worker = null;
    }
  };
  worker.postMessage({
    targetDofs: Number(targetSel.value),
    threads: readThreads(threadsIn, THREAD_CAP),
  });
});
