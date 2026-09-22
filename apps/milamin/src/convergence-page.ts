// Convergence lab page: table of refinement levels filling live, a log-log
// error-vs-h chart with fitted convergence orders, and an error map of the
// finest solution against the analytical inclusion solution.
import './site';
import { triEvaluator, StokesTriCore } from '@fem/stokesfem-tri';
import { solve as solveCircle } from '@ana/circle';
import { COLORMAPS } from '@viz/colormap';
import { colormapLut } from '@viz/render';
import type { ConvergenceMessage, LevelRow } from './convergence-worker';
import { initThreadInput, readThreads } from './threads';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const runBtn = $<HTMLButtonElement>('run');
const threadsIn = $<HTMLSelectElement>('in-threads');
const status = $('status');
const tbody = $('rows');
const orderEl = $('orders');
const chart = $<HTMLCanvasElement>('chart');
const cvErr = $<HTMLCanvasElement>('cv-err');

const THREAD_CAP = 4; // see threads.ts
initThreadInput(threadsIn, THREAD_CAP);

const exact = solveCircle({ m: 1000, er: 0, gr: 1 });
const rows: LevelRow[] = [];
let worker: Worker | null = null;

function ink(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
}
function muted(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
}

// --- table -------------------------------------------------------------------

function fmtErr(e: number): string {
  return e.toExponential(2).replace('e-', ' × 10⁻');
}

function renderTable() {
  tbody.innerHTML = rows
    .map((r, i) => {
      const rateV = i > 0 ? Math.log2(rows[i - 1].errV / r.errV).toFixed(1) : '–';
      const rateT = i > 0 ? Math.log2(rows[i - 1].errTau / r.errTau).toFixed(1) : '–';
      return (
        `<tr><td>${r.h.toPrecision(2)}</td>` +
        `<td>${r.dofs.toLocaleString('en')}</td>` +
        `<td>${fmtErr(r.errV)}</td><td>${rateV}</td>` +
        `<td>${fmtErr(r.errTau)}</td><td>${rateT}</td>` +
        `<td>${(100 * r.sliverShareTau).toFixed(0)}%</td>` +
        `<td>${(r.solveMs / 1000).toFixed(1)} s</td></tr>`
      );
    })
    .join('');
}

// --- log-log chart -------------------------------------------------------------

function fitSlope(pts: Array<[number, number]>): number {
  // least squares on log10(x), log10(y)
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) {
    const lx = Math.log10(x), ly = Math.log10(y);
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

function drawChart() {
  const W = 560, H = 380, ML = 62, MR = 16, MT = 14, MB = 44;
  const dpr = window.devicePixelRatio || 1;
  chart.width = W * dpr;
  chart.height = H * dpr;
  chart.style.width = '100%';
  chart.style.maxWidth = `${W}px`;
  chart.style.height = 'auto';
  const ctx = chart.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;

  const hs = rows.map((r) => r.h);
  const errs = rows.flatMap((r) => [r.errV, r.errTau]);
  const xMin = Math.min(...hs) / 1.3, xMax = Math.max(...hs) * 1.3;
  const yMin = 10 ** Math.floor(Math.log10(Math.min(...errs))), yMax = 10 ** Math.ceil(Math.log10(Math.max(...errs)));
  const px = (h: number) => ML + ((Math.log10(h) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (W - ML - MR);
  const py = (e: number) => MT + (1 - (Math.log10(e) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * (H - MT - MB);

  // frame + gridlines and ticks per order of magnitude
  ctx.strokeStyle = muted();
  ctx.fillStyle = muted();
  ctx.lineWidth = 1;
  ctx.font = '12px system-ui, sans-serif';
  ctx.strokeRect(ML, MT, W - ML - MR, H - MT - MB);
  ctx.textAlign = 'right';
  for (let d = Math.ceil(Math.log10(yMin)); d <= Math.floor(Math.log10(yMax)); d++) {
    const y = py(10 ** d);
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - MR, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(`1e${d}`, ML - 6, y + 4);
  }
  ctx.textAlign = 'center';
  for (const r of rows) {
    ctx.fillText(r.h.toPrecision(1), px(r.h), H - MB + 18);
  }
  ctx.fillText('element size h (log)', ML + (W - ML - MR) / 2, H - 8);
  ctx.save();
  ctx.translate(14, MT + (H - MT - MB) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('relative L2 error (log)', 0, 0);
  ctx.restore();

  const series: Array<{ key: 'errV' | 'errTau'; color: string; label: string }> = [
    { key: 'errV', color: '#2a78d6', label: 'velocity' },
    { key: 'errTau', color: '#c43d3d', label: 'stress τ' },
  ];
  const slopes: string[] = [];
  series.forEach((s, si) => {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = px(r.h), y = py(r[s.key]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const r of rows) {
      ctx.beginPath();
      ctx.arc(px(r.h), py(r[s.key]), 3.5, 0, 2 * Math.PI);
      ctx.fill();
    }
    const slope = fitSlope(rows.slice(-3).map((r) => [r.h, r[s.key]]));
    slopes.push(`${s.label}: O(h<sup>${slope.toFixed(1)}</sup>)`);
    ctx.textAlign = 'left';
    ctx.fillText(s.label, ML + 12, MT + 20 + 18 * si);
  });
  orderEl.innerHTML = `Fitted convergence order (finest three levels): ${slopes.join(', ')}.`;
}

// --- error map -----------------------------------------------------------------

const R_OUT = 2.5;

function drawErrorMap(core: StokesTriCore) {
  const evalAt = triEvaluator(core);
  const FULL = 560;
  const lut = colormapLut(COLORMAPS.turbo.map);
  // |Δv| on a log scale spanning four orders of magnitude below its maximum
  const errAt = (x: number, y: number): number | null => {
    if (x * x + y * y > R_OUT * R_OUT) return null;
    const s = evalAt(x, y);
    if (!s) return null;
    const [ue, ve] = exact.velAt(x, y);
    return Math.hypot(s.u - ue, s.v - ve);
  };
  let eMax = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() - 0.5) * 2 * R_OUT;
    const y = (Math.random() - 0.5) * 2 * R_OUT;
    const e = errAt(x, y);
    if (e !== null && e > eMax) eMax = e;
  }
  eMax = eMax || 1e-12;
  const buf = new Uint8ClampedArray(FULL * FULL * 4);
  const scale = (2 * (R_OUT + 0.1)) / FULL;
  for (let j = 0; j < FULL; j++) {
    const y = (FULL / 2 - (j + 0.5)) * scale;
    for (let i = 0; i < FULL; i++) {
      const e = errAt((i + 0.5 - FULL / 2) * scale, y);
      if (e === null) continue;
      const t = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(e, 1e-300) / eMax) / 4));
      const c = Math.round(t * (lut.length / 3 - 1)) * 3;
      const k = (j * FULL + i) * 4;
      buf[k] = lut[c]; buf[k + 1] = lut[c + 1]; buf[k + 2] = lut[c + 2]; buf[k + 3] = 255;
    }
  }
  cvErr.width = FULL;
  cvErr.height = FULL;
  const ctx = cvErr.getContext('2d')!;
  ctx.putImageData(new ImageData(buf, FULL, FULL), 0, 0);
  // inclusion outline
  ctx.strokeStyle = ink();
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (let i = 0; i <= 128; i++) {
    const t = (2 * Math.PI * i) / 128;
    const pxx = FULL / 2 + (Math.cos(t) * FULL) / (2 * (R_OUT + 0.1));
    const pyy = FULL / 2 - (Math.sin(t) * FULL) / (2 * (R_OUT + 0.1));
    i === 0 ? ctx.moveTo(pxx, pyy) : ctx.lineTo(pxx, pyy);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  drawErrorColorbar(lut, eMax);
  $('err-scale').textContent = '|Δv|, the velocity error, on a logarithmic scale over four orders of magnitude below its maximum';
}

/** Colorbar for the error map: the same LUT, a tick per order of magnitude from eMax / 1e4 to eMax. */
function drawErrorColorbar(lut: Uint8Array, eMax: number) {
  const bar = $<HTMLCanvasElement>('cb-err');
  bar.width = 256;
  bar.height = 1;
  const img = new ImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    const k = Math.round((i / 255) * (lut.length / 3 - 1)) * 3;
    img.data[i * 4] = lut[k];
    img.data[i * 4 + 1] = lut[k + 1];
    img.data[i * 4 + 2] = lut[k + 2];
    img.data[i * 4 + 3] = 255;
  }
  bar.getContext('2d')!.putImageData(img, 0, 0);
  const ticks = $('ticks-err');
  ticks.innerHTML = '';
  for (let d = 4; d >= 0; d--) {
    const span = document.createElement('span');
    span.textContent = (eMax / 10 ** d).toExponential(0).replace('e-', 'e−');
    ticks.appendChild(span);
  }
}

// --- run -----------------------------------------------------------------------

runBtn.addEventListener('click', () => {
  if (worker) {
    worker.terminate();
    worker = null;
    document.body.classList.remove('solving');
    runBtn.textContent = 'Run the study';
    status.textContent = 'stopped';
    return;
  }
  rows.length = 0;
  renderTable();
  orderEl.textContent = '';
  drawChart();
  cvErr.getContext('2d')!.clearRect(0, 0, cvErr.width, cvErr.height);
  $('err-scale').textContent = '';
  $('ticks-err').innerHTML = '';
  $<HTMLCanvasElement>('cb-err').getContext('2d')!.clearRect(0, 0, 256, 1);
  document.body.classList.add('solving');
  runBtn.textContent = 'Stop';
  status.textContent = 'starting worker…';
  let threadNote = '';
  worker = new Worker(new URL('./convergence-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<ConvergenceMessage>) => {
    const msg = ev.data;
    if ('threads' in msg) {
      threadNote = !msg.isolated
        ? 'single-threaded (no cross-origin isolation)'
        : `${msg.threads} thread${msg.threads > 1 ? 's' : ''}`;
      status.textContent = `running, ${threadNote}`;
    } else if ('level' in msg) {
      status.textContent = `level ${msg.level} of ${msg.of} (${threadNote})`;
    } else if ('row' in msg) {
      rows.push(msg.row);
      renderTable();
      drawChart();
    } else if ('core' in msg) {
      status.textContent = 'mapping the error…';
      requestAnimationFrame(() =>
        setTimeout(() => {
          drawErrorMap(msg.core);
          document.body.classList.remove('solving');
          status.textContent = 'done';
          runBtn.textContent = 'Run the study';
          worker?.terminate();
          worker = null;
        }),
      );
    } else if ('error' in msg) {
      document.body.classList.remove('solving');
      status.textContent = `failed: ${msg.error}`;
      runBtn.textContent = 'Run the study';
      worker?.terminate();
      worker = null;
    }
  };
  worker.postMessage({ threads: readThreads(threadsIn, THREAD_CAP) });
});

// ?autorun for demos and headless tests
if (new URLSearchParams(location.search).has('autorun')) runBtn.click();
