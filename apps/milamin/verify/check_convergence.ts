import assert from 'node:assert/strict';
import { initTriangle } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import {
  exactSolution, meshLevel, solveLevel, integrateCircleReference, levelErrors,
  interfaceVertices, R_OUT,
} from '../src/convergence-study';

await initTriangle();
await initSpchol({ forceSingleThread: true });
const exact = exactSolution();
function close(label: string, got: number, want: number, tolerance: number) {
  assert.ok(Math.abs(got - want) <= tolerance, `${label}: ${got}, expected ${want} ± ${tolerance}`);
  console.log(`ok ${label}: ${got}`);
}

// The continuation must preserve the circular solution's interface velocity
// while retaining its stress jump (simple shear, maximum jump at 45 degrees).
const inside = exact.velAt(1, 0), outside = exact.velMatrixAt(1, 0);
close('interface u continuity', inside[0], outside[0], 1e-14);
close('interface v continuity', inside[1], outside[1], 1e-14);
close('matrix-side interface stress', exact.evalMatrixAt(Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)).tau, 2 / 1001, 1e-14);
close('inclusion-side interface stress', exact.evalAt(1, 0).tau, 2000 / 1001, 1e-14);

for (const level of [0, 2]) {
  const sol = solveLevel(meshLevel(level).mesh, exact);
  const outerN = 48 * 2 ** level;
  const area = outerN / 2 * R_OUT ** 2 * Math.sin(2 * Math.PI / outerN);
  const n = interfaceVertices(level);
  const sliverArea = Math.PI - n / 2 * Math.sin(2 * Math.PI / n);

  // Independent piecewise-constant reference: integral of tau=2 inside the
  // circle, 1 outside is mesh area + pi, regardless of the polygon interface.
  const stepReference = {
    ...exact,
    evalAt: (x: number, y: number) => ({ p: 0, tau: x*x + y*y <= 1 ? 2 : 1, inside: x*x + y*y <= 1 }),
    evalMatrixAt: () => ({ p: 0, tau: 1, inside: false }),
  };
  let weight = 0, sliverWeight = 0, integral = 0;
  integrateCircleReference(sol, level, stepReference, (_s, ref, w, part) => {
    weight += w;
    integral += w * ref.tau;
    if (part === 'sliver') sliverWeight += w;
  });
  close(`level ${level}: total area counted once`, weight, area, 1e-10);
  close(`level ${level}: exact curved sliver area`, sliverWeight, sliverArea, 1e-12);
  close(`level ${level}: discontinuous reference integral`, integral, area + Math.PI, 1e-10);

  const coarse = levelErrors(sol, level, exact);
  const refined = levelErrors(sol, level, exact, 2);
  close(`level ${level}: polar refinement, velocity`, coarse.errV / refined.errV, 1, 1e-3);
  close(`level ${level}: polar refinement, stress`, coarse.errTau / refined.errTau, 1, 1e-3);
  assert.ok(coarse.sliverShareTau > 0 && coarse.sliverShareTau < 1);
}
console.log('convergence integration checks passed');
