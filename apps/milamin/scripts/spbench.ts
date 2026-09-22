// Quick A/B benchmark for the sparse backend only: one run per size.
// Usage: npx tsx scripts/spbench.ts [scale ...]   (scale 1 ~ 5k dofs; dofs ~ 5k/scale)
import { initTriangle, buildMesh } from '@fem/trimesh';
import { solveStokesTri } from '@fem/stokesfem-tri';
import { initSpchol, spcholThreads } from '@fem/spchol';
import { solve as solveCircle } from '@ana/circle';

const exact = solveCircle({ m: 1000, er: 0, gr: 1 });

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

await initTriangle();
await initSpchol({
  forceSingleThread: !!process.env.SPCHOL_ST,
  threads: process.env.SPCHOL_THREADS ? Number(process.env.SPCHOL_THREADS) : undefined,
});
console.log(`spchol threads: ${spcholThreads()}`);

const scales = process.argv.slice(2).map(Number).filter((x) => x > 0);
if (!scales.length) scales.push(1 / 32);

for (const scale of scales) {
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
    backend: 'sparse',
  });
  const totalMs = meshMs + fem.assembleMs + fem.factorMs + fem.phMs;
  console.log(
    `dofs=${String(fem.dofs).padStart(8)}  mesh=${meshMs.toFixed(0)}ms` +
      `  asm=${fem.assembleMs.toFixed(0)}ms  chol=${fem.factorMs.toFixed(0)}ms` +
      `  ph=${fem.phMs.toFixed(0)}ms  total=${(totalMs / 1000).toFixed(2)}s` +
      `  rate=${(fem.dofs / (totalMs / 1000 / 60)).toExponential(2)} dof/min`,
  );
}
