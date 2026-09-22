// MILAMIN browser-solver benchmark: how far is the current TS/JS stack from
// the 2008 claim of one million degrees of freedom per minute?
// Runs both solvers at increasing resolution, printing per-stage timings.
// Node's V8 is the same engine as Chrome, so these numbers approximate the
// browser. Run: npx tsx scripts/bench.ts [--max-dofs N]  (SPCHOL_THREADS=k, SPCHOL_ST=1)
import { initTriangle, buildMesh } from '@fem/trimesh';
import { solveStokesTri } from '@fem/stokesfem-tri';
import { initSpchol } from '@fem/spchol';
import { solve as solveCircle } from '@ana/circle';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_DOFS = Number(process.argv[process.argv.indexOf('--max-dofs') + 1]) || 1_000_000;
const exact = solveCircle({ m: 1000, er: 0, gr: 1 });

interface Row {
  solver: string;
  dofs: number;
  elements: number;
  hbw: number;
  meshMs: number;
  assembleMs: number;
  factorMs: number;
  phMs: number;
  totalMs: number;
  bandMB: number;
}
const rows: Row[] = [];

function report(r: Row) {
  rows.push(r);
  const rate = (r.dofs / (r.totalMs / 1000 / 60)).toExponential(2);
  console.log(
    `${r.solver}  dofs=${String(r.dofs).padStart(7)}  hbw=${String(r.hbw).padStart(5)}` +
      `  mesh=${r.meshMs.toFixed(0)}ms  asm=${r.assembleMs.toFixed(0)}ms` +
      `  chol=${r.factorMs.toFixed(0)}ms  ph=${r.phMs.toFixed(0)}ms` +
      `  total=${(r.totalMs / 1000).toFixed(2)}s  band=${r.bandMB.toFixed(0)}MB` +
      `  rate=${rate} dof/min`,
  );
}

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

// --- unstructured: MILAMIN's own element (7-node CR + P1disc) ---------------
await initTriangle();
// SPCHOL_ST=1 forces the single-thread build; SPCHOL_THREADS=k caps the threaded build
await initSpchol({ forceSingleThread: !!process.env.SPCHOL_ST, threads: Number(process.env.SPCHOL_THREADS) || undefined });

// banded is O(n^2): cap it independently so the sparse sweep can go deep
const MAX_BANDED = Math.min(MAX_DOFS, 30_000);

for (const backend of ['banded', 'sparse'] as const) {
  console.log(`--- Triangle meshes, 7-node Crouzeix-Raviart, ${backend} ---`);
  const cap = backend === 'banded' ? MAX_BANDED : MAX_DOFS;
  for (let scale = 1; ; scale *= 0.5) {
  const nb = Math.round(96 / Math.sqrt(scale));
  const ni = Math.round(64 / Math.sqrt(scale));
  const t0 = performance.now();
  const mesh = buildMesh({
    boundaries: [
      { pts: circlePts(2.5, nb), marker: 1 },
      { pts: circlePts(1, ni), marker: 2 },
    ],
    regions: [
      [0, 0, 2, 0.02 * scale],
      [1.75, 0, 1, 0.04 * scale],
    ],
  });
    const meshMs = performance.now() - t0;
    const fem = solveStokesTri({
      mesh,
      muOfAttr: (a) => (a === 2 ? 1000 : 1),
      bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
      backend,
    });
    report({
      solver: backend === 'banded' ? 'tri ' : 'spar',
      dofs: fem.dofs + 2 * fem.elements, // 2008 counting, bubble node included
      elements: fem.elements,
      hbw: backend === 'banded' ? fem.halfBandwidth : fem.nnzL,
      meshMs,
      assembleMs: fem.assembleMs,
      factorMs: fem.factorMs,
      phMs: fem.phMs,
      totalMs: meshMs + fem.assembleMs + fem.factorMs + fem.phMs,
      bandMB:
        backend === 'banded'
          ? (fem.dofs * (fem.halfBandwidth + 1) * 8) / 1e6
          : (fem.nnzL * 12) / 1e6,
    });
    // next refinement roughly doubles the dofs — stop when it would overshoot
    if (fem.dofs > cap * 0.55) break;
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'bench-results.json');
writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('written', out);
