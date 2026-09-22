import './site';
import type { BenchRow } from './bench-worker';
import { initThreadInput, readThreads } from './threads';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const runBtn = $<HTMLButtonElement>('run');
const targetSel = $<HTMLSelectElement>('in-target');
const threadsIn = $<HTMLSelectElement>('in-threads');
const bandedIn = $<HTMLInputElement>('in-banded');
const largestIn = $<HTMLInputElement>('in-largest');
const status = $('status');

const THREAD_CAP = 4; // see threads.ts
initThreadInput(threadsIn, THREAD_CAP);
const canvas = $<HTMLCanvasElement>('chart');
const tableWrap = $('table-wrap');

// MILAMIN 2008 itself, two references with slightly different scopes. The
// curve is the total time of the mechanical test problem versus size, read
// off Figure 5 of the paper (AMD Opteron, MATLAB 2007a; nodes converted to
// unknowns at 2 per node): every MILAMIN component, of which the paper calls
// boundary conditions and postprocessing minor. The star is Table 2's
// assembly + solution at one million unknowns, 15 s + 34 s, the scope the
// browser curves are plotted in. Reading a log-log figure carries a few
// percent of uncertainty.
const REF_2008_TOTAL: Array<[number, number]> = [
  [6.4e4, 2.45],
  [1.28e5, 5.3],
  [2.5e5, 11],
  [5.0e5, 22.6],
  [1.0e6, 49],
  [1.95e6, 104],
  [3.9e6, 231],
];
const REF_2008_MILLION = { dofs: 1e6, seconds: 49 };

let rows: BenchRow[] = [];
let worker: Worker | null = null;

// --- chart -------------------------------------------------------------------

// series keys are the worker's (and bench-results.json's); the labels say what
// each one is: factorization backend + ordering
const SERIES: Record<BenchRow['solver'], { color: string; label: string; banded: boolean }> = {
  sparse: { color: '#27ae60', label: 'supernodal Cholesky (AMD)', banded: false },
  tri: { color: '#c0392b', label: 'banded Cholesky (RCM)', banded: true },
};

// ?thumb renders the chart for the home-page thumbnail: neutral grey ink that
// reads on the light and the dark ground alike, larger type, no grid
const THUMB = new URLSearchParams(location.search).has('thumb');

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const W = 800;
  const H = 480;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${W}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = THUMB ? '#8b867d' : dark ? '#ddd' : '#222';
  const grid = THUMB ? 'transparent' : dark ? '#333' : '#e5e5e5';
  const font = THUMB ? '600 19px system-ui, sans-serif' : '14px system-ui, sans-serif';
  ctx.clearRect(0, 0, W, H);

  const M = { l: THUMB ? 96 : 72, r: 16, t: 18, b: 50 };
  const x0 = Math.log10(3e3);
  const x1 = Math.log10(5e6);
  const y0 = Math.log10(0.05);
  const y1 = Math.log10(2000);
  const px = (lg: number) => M.l + ((lg - x0) / (x1 - x0)) * (W - M.l - M.r);
  const py = (lg: number) => H - M.b - ((lg - y0) / (y1 - y0)) * (H - M.t - M.b);

  // grid + labels
  ctx.font = font;
  ctx.fillStyle = ink;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let e = 4; e <= 6; e++) {
    const x = px(e);
    ctx.beginPath();
    ctx.moveTo(x, M.t);
    ctx.lineTo(x, H - M.b);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(e === 6 ? '1M' : e === 5 ? '100k' : '10k', x, H - M.b + 20);
  }
  for (let e = -1; e <= 3; e++) {
    const y = py(e);
    ctx.beginPath();
    ctx.moveTo(M.l, y);
    ctx.lineTo(W - M.r, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    const lab = e === -1 ? '0.1 s' : e === 0 ? '1 s' : e === 1 ? '10 s' : e === 2 ? '100 s' : '1000 s';
    ctx.fillText(lab, M.l - 8, y + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillText('unknowns', M.l + (W - M.l - M.r) / 2, H - 8);
  ctx.save();
  ctx.translate(14, M.t + (H - M.t - M.b) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('assembly + solution time', 0, 0);
  ctx.restore();

  // MILAMIN 2008: the total-time curve, dashed, and a star on Table 2's million
  ctx.strokeStyle = THUMB ? '#a39e94' : dark ? '#9a958c' : '#8a857c';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = THUMB ? 2.5 : 1.4;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  REF_2008_TOTAL.forEach(([d, s], i) => {
    const x = px(Math.log10(d));
    const y = py(Math.log10(s));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [d, s] of REF_2008_TOTAL) {
    ctx.beginPath();
    ctx.arc(px(Math.log10(d)), py(Math.log10(s)), 2.5, 0, 2 * Math.PI);
    ctx.fill();
  }
  // label at the upper end of the curve, right-aligned above its last point,
  // where the line runs away below the text instead of through it
  const last = REF_2008_TOTAL[REF_2008_TOTAL.length - 1];
  ctx.textAlign = 'right';
  if (!THUMB) ctx.fillText('MILAMIN 2008, total time (paper, Fig. 5)', px(Math.log10(last[0])) + 6, py(Math.log10(last[1])) - 12);
  {
    const cx = px(Math.log10(REF_2008_MILLION.dofs));
    const cy = py(Math.log10(REF_2008_MILLION.seconds));
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 === 0 ? 8 : 3.5;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'right';
    ctx.fillText(THUMB ? 'MILAMIN 2008' : '2008: 49 s assembly + solve (Table 2)', cx - 12, cy + 4);
  }

  // measured points, per solver, connected
  for (const solver of ['tri', 'sparse'] as const) {
    const pts = rows.filter((r) => r.solver === solver);
    if (!pts.length) continue;
    ctx.strokeStyle = SERIES[solver].color;
    ctx.fillStyle = SERIES[solver].color;
    ctx.lineWidth = THUMB ? 3 : 1.8;
    ctx.beginPath();
    pts.forEach((r, i) => {
      const x = px(Math.log10(r.dofs));
      const y = py(Math.log10((r.assembleMs + r.factorMs + r.phMs) / 1000));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const r of pts) {
      ctx.beginPath();
      ctx.arc(px(Math.log10(r.dofs)), py(Math.log10((r.assembleMs + r.factorMs + r.phMs) / 1000)), THUMB ? 6 : 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  // legend: only the series that have run or will run (banded ones are opt-in)
  const shown = (Object.keys(SERIES) as Array<BenchRow['solver']>).filter(
    (k) => rows.some((r) => r.solver === k) || (!SERIES[k].banded || bandedIn.checked),
  );
  shown.forEach((key, i) => {
    const { color, label } = SERIES[key];
    const y = M.t + 14 + i * (THUMB ? 26 : 20);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(M.l + 12, y, THUMB ? 6 : 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.fillText(label, M.l + 24, y + 4);
  });
}

// --- table -------------------------------------------------------------------

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
}

function renderTable() {
  if (!rows.length) {
    tableWrap.replaceChildren();
    return;
  }
  const tbl = document.createElement('table');
  tbl.className = 'bench-table';
  tbl.innerHTML =
    '<thead><tr><th>solver</th><th class="num">unknowns</th><th class="num">elements</th>' +
    '<th class="num">mesh</th><th class="num">matrices &amp; assembly</th><th class="num">factorization</th>' +
    '<th class="num">pressure iterations</th><th class="num">total</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    [
      SERIES[r.solver].label,
      r.dofs.toLocaleString('en'),
      r.elements.toLocaleString('en'),
      fmtMs(r.meshMs),
      fmtMs(r.assembleMs),
      fmtMs(r.factorMs),
      fmtMs(r.phMs),
      fmtMs(r.totalMs),
    ].forEach((v, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = v;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  scroller.appendChild(tbl);
  tableWrap.replaceChildren(scroller);
}

// --- run ---------------------------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  mesh: 'meshing',
  assemble: 'element matrices & assembly',
  factor: 'factorization',
  ph: 'pressure iterations',
};
let ticker = 0;
const endRun = (label: string) => {
  clearInterval(ticker);
  ticker = 0;
  document.documentElement.style.cursor = '';
  worker?.terminate();
  worker = null;
  runBtn.textContent = 'Run benchmark';
  status.textContent = label;
};

runBtn.addEventListener('click', () => {
  if (worker) {
    endRun('stopped');
    return;
  }
  rows = [];
  drawChart();
  renderTable();
  worker = new Worker(new URL('./bench-worker.ts', import.meta.url), { type: 'module' });
  runBtn.textContent = 'Stop';
  document.documentElement.style.cursor = 'progress';
  status.textContent = 'running… (in a worker; the page stays live)';
  let threadNote = '';
  let stageText = '';
  let stageStart = 0;
  const liveStatus = () => {
    const secs = Math.round((performance.now() - stageStart) / 1000);
    status.textContent = `running… ${stageText}${secs >= 1 ? ` ${secs} s` : ''}${threadNote}`;
  };
  ticker = window.setInterval(() => stageText && liveStatus(), 1000);
  worker.onmessage = (ev) => {
    if (ev.data.threads) {
      threadNote = !ev.data.isolated
        ? ' (sparse solver single-threaded; no cross-origin isolation)'
        : ev.data.threads > 1
          ? ` (sparse solver on ${ev.data.threads} threads)`
          : ' (sparse solver: single-thread build)';
      status.textContent = `running…${threadNote}`;
    } else if (ev.data.stage) {
      stageText = `${STAGE_LABELS[ev.data.stage] ?? ev.data.stage}${
        ev.data.dofs ? ` at ${Number(ev.data.dofs).toLocaleString('en')} unknowns` : ''
      }`;
      stageStart = performance.now();
      liveStatus();
    } else if (ev.data.row) {
      rows.push(ev.data.row as BenchRow);
      drawChart();
      renderTable();
      stageText = '';
      status.textContent = `running… last: ${(ev.data.row as BenchRow).dofs.toLocaleString('en')} unknowns${threadNote}`;
    } else if (ev.data.done) {
      endRun(`done${threadNote}`);
    } else if (ev.data.error) {
      endRun(`stopped: ${ev.data.error}`);
    }
  };
  worker.postMessage({
    maxDofs: Number(targetSel.value),
    threads: readThreads(threadsIn, THREAD_CAP),
    includeBanded: bandedIn.checked,
    largestOnly: largestIn.checked,
  });
});

drawChart();
bandedIn.addEventListener('change', drawChart);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawChart);
