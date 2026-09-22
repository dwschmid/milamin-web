// Checks the sparse (Eigen SimplicialLDLT wasm) backend of the triangle
// Stokes solver against the banded reference: identical problem, two linear
// solvers, solutions must agree to solver tolerance; convergence gates as in
// check_femtri. Run: npm run verify
import { initTriangle, buildMesh } from '../src/trimesh';
import { solveStokesTri } from '../src/stokesfem-tri';
import { initSpchol } from '../src/spchol';
import { solve as solveCircle } from '../../analytic/src/circle';

let failures = 0;
let checks = 0;

function expectBelow(what: string, got: number, bound: number) {
  checks++;
  if (!(got < bound) || Number.isNaN(got)) {
    failures++;
    console.error(`FAIL ${what}: ${got} not below ${bound}`);
  }
}

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

await initTriangle();
await initSpchol();

for (const m of [1000, 0.01]) {
  const exact = solveCircle({ m, er: 0, gr: 1 });
  const mesh = buildMesh({
    boundaries: [
      { pts: circlePts(2.5, 96), marker: 1 },
      { pts: circlePts(1, 64), marker: 2 },
    ],
    regions: [
      [0, 0, 2, 0.02],
      [1.75, 0, 1, 0.04],
    ],
  });
  const args = {
    mesh,
    muOfAttr: (a: number) => (a === 2 ? m : 1),
    bc: (marker: number, x: number, y: number) => (marker === 1 ? exact.velAt(x, y) : null),
  };
  const banded = solveStokesTri({ ...args, backend: 'banded' });
  const sparse = solveStokesTri({ ...args, backend: 'sparse' });

  // same discrete problem, two exact factorizations: velocities must agree
  let du = 0;
  let uMax = 0;
  for (let i = 0; i < banded.u.length; i++) {
    du = Math.max(du, Math.abs(banded.u[i] - sparse.u[i]));
    uMax = Math.max(uMax, Math.abs(banded.u[i]));
  }
  expectBelow(`[m=${m}] |u_banded - u_sparse| / |u|`, du / uMax, 1e-8);

  // element pressures too: all three coefficients (constant and the two
  // element-scaled slopes), and the condensed bubble velocities
  let dp = 0;
  let pMax = 0;
  for (let i = 0; i < banded.elP.length; i++) {
    dp = Math.max(dp, Math.abs(banded.elP[i] - sparse.elP[i]));
    pMax = Math.max(pMax, Math.abs(banded.elP[i]));
  }
  expectBelow(`[m=${m}] |p_banded - p_sparse| / |p| (all coefficients)`, dp / pMax, 1e-6);
  let dub = 0;
  let ubMax = 0;
  for (let i = 0; i < banded.ub.length; i++) {
    dub = Math.max(dub, Math.abs(banded.ub[i] - sparse.ub[i]));
    ubMax = Math.max(ubMax, Math.abs(banded.ub[i]));
  }
  expectBelow(`[m=${m}] |bubble_banded - bubble_sparse| / |bubble|`, dub / ubMax, 1e-6);

  // PH floors around 1.5e-8 at this contrast for BOTH backends now that the
  // residual measures all three pressure coefficients (it was 2e-9 on the
  // constant coefficient alone) — gate accordingly
  expectBelow(`[m=${m}] sparse div residual`, sparse.divResidual, 5e-8);
  expectBelow(
    `[m=${m}] sparse vs banded div residual ratio`,
    sparse.divResidual / Math.max(banded.divResidual, 1e-300),
    100,
  );
  checks++;
  if (!(sparse.nnzL > 0)) {
    failures++;
    console.error(`FAIL [m=${m}] nnzL not reported: ${sparse.nnzL}`);
  }

  // sanity vs the analytical solution (same gate as check_femtri coarse)
  let errU = 0;
  let refU = 0;
  for (let nd = 0; nd < sparse.nodes; nd++) {
    const x = sparse.nodeX[nd];
    const y = sparse.nodeY[nd];
    const [ue, ve] = exact.velAt(x, y);
    errU = Math.max(
      errU,
      Math.hypot(sparse.u[2 * nd] - ue, sparse.u[2 * nd + 1] - ve),
    );
    refU = Math.max(refU, Math.hypot(ue, ve));
  }
  expectBelow(`[m=${m}] sparse velocity error vs analytics`, errU / refU, 2e-3);

  console.log(
    `[spchol m=${m}] dofs=${sparse.dofs} nnzL=${sparse.nnzL} ` +
      `factor=${sparse.factorMs.toFixed(0)}ms (banded: ${banded.factorMs.toFixed(0)}ms) ` +
      `du=${(du / uMax).toExponential(2)}`,
  );
}

if (failures) {
  console.error(`${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
