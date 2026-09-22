// Node twin of the convergence lab (convergence.html): the same study, the
// same integrated error norms (src/convergence-study.ts), observed orders per
// level and a least-squares fit on the finest three.
// Run: npx tsx apps/milamin/scripts/convergence.ts [levels]
import { initTriangle } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import { exactSolution, meshLevel, solveLevel, levelErrors } from '../src/convergence-study';

await initTriangle();
await initSpchol({ forceSingleThread: true });

const exact = exactSolution();
const levels = Number(process.argv[2]) || 5;
const rows: Array<{ h: number; errV: number; errTau: number }> = [];
for (let k = 0; k < levels; k++) {
  const t0 = performance.now();
  const { mesh, area } = meshLevel(k);
  const sol = solveLevel(mesh, exact);
  const solveMs = performance.now() - t0;
  const err = levelErrors(sol, k, exact);
  const row = { h: Math.sqrt(area), errV: err.errV, errTau: err.errTau };
  const prev = rows[rows.length - 1];
  rows.push(row);
  const ord = (a: number, b: number) => (prev ? Math.log2(a / b).toFixed(2) : '   -');
  console.log(
    `h=${row.h.toFixed(4)} unknowns=${String(sol.dofs + 2 * sol.elements).padStart(8)} ` +
      `errV=${row.errV.toExponential(3)} (${ord(prev?.errV ?? 0, row.errV)}) ` +
      `errTau=${row.errTau.toExponential(3)} (${ord(prev?.errTau ?? 0, row.errTau)}) ` +
      `sliver share of stress error ${(100 * err.sliverShareTau).toFixed(0)}% ${(solveMs / 1000).toFixed(1)}s`,
  );
}

function fitSlope(pts: Array<[number, number]>): number {
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) {
    const lx = Math.log10(x), ly = Math.log10(y);
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}
const last3 = rows.slice(-3);
console.log(
  `fitted order, finest three: velocity ${fitSlope(last3.map((r) => [r.h, r.errV])).toFixed(2)}, ` +
    `stress ${fitSlope(last3.map((r) => [r.h, r.errTau])).toFixed(2)}`,
);
