// Checks the unstructured-triangle Stokes FEM (src/stokesfem-tri.ts + Triangle
// meshes from src/trimesh.ts) against
//  1. the analytical circular inclusion (two-region disk mesh, exact
//     velocities on the outer boundary): error magnitude + mesh-refinement
//     decrease at strong and weak viscosity contrast,
//  2. the rigid square of Schmid (2005): annular mesh between the square
//     (rigid-rotation Dirichlet) and an outer circle (analytical velocities),
//     matrix pressure and stress vs the closed-form solution.
// Run: npm run verify

import { initTriangle, buildMesh } from '../src/trimesh';
import { solveStokesTri } from '../src/stokesfem-tri';
import { solve as solveCircle } from '../../analytic/src/circle';
import { solve as solvePolygon } from '../../analytic/src/polygon';

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

// --- 1. circular inclusion, two-region disk ---------------------------------
function circleErrors(m: number, er: number, gr: number, scale: number) {
  const exact = solveCircle({ m, er, gr });
  // the boundary polygons must refine with the mesh, or their chordal
  // geometric error (sagitta ~ (dtheta)^2/8) floors the convergence
  const nb = Math.round(96 / Math.sqrt(scale));
  const ni = Math.round(64 / Math.sqrt(scale));
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
  const fem = solveStokesTri({
    mesh,
    muOfAttr: (a) => (a === 2 ? m : 1),
    bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
  });

  const sample: Array<[number, number]> = [];
  for (let i = 0; i <= 40; i++) {
    const r = 0.05 + (2.4 * i) / 40;
    for (let j = 0; j < 72; j++) {
      const t = ((j + 0.31) * 2 * Math.PI) / 72;
      sample.push([r * Math.cos(t), r * Math.sin(t)]);
    }
  }
  let shiftSum = 0;
  let cnt = 0;
  for (const [x, y] of sample) {
    const f = fem.evalAt(x, y);
    if (!f) continue;
    shiftSum += f.p - exact.evalAt(x, y).p;
    cnt++;
  }
  const shift = shiftSum / cnt;
  let e2u = 0, n2u = 0, e2p = 0, n2p = 0, e2t = 0, n2t = 0;
  for (const [x, y] of sample) {
    const f = fem.evalAt(x, y);
    if (!f) continue;
    const [ue, ve] = exact.velAt(x, y);
    const a = exact.evalAt(x, y);
    e2u += (f.u - ue) ** 2 + (f.v - ve) ** 2;
    n2u += ue ** 2 + ve ** 2;
    e2p += (f.p - shift - a.p) ** 2;
    n2p += a.p ** 2 + 1e-12;
    e2t += (f.tau - a.tau) ** 2;
    n2t += a.tau ** 2;
  }
  return {
    u: Math.sqrt(e2u / n2u),
    p: Math.sqrt(e2p / n2p),
    tau: Math.sqrt(e2t / n2t),
    div: fem.divResidual,
    dofs: fem.dofs,
    hbw: fem.halfBandwidth,
  };
}

for (const { m, er, gr } of [
  { m: 1000, er: 0, gr: 1 },
  { m: 0.01, er: 1, gr: 0.3 },
]) {
  const label = `tri circle m=${m}`;
  const coarse = circleErrors(m, er, gr, 1);
  const fine = circleErrors(m, er, gr, 0.25);
  console.log(
    `[${label}] coarse(${coarse.dofs} dofs, hbw ${coarse.hbw}): u=${coarse.u.toExponential(2)} p=${coarse.p.toExponential(2)} tau=${coarse.tau.toExponential(2)} div=${coarse.div.toExponential(1)}`,
  );
  console.log(
    `[${label}] fine  (${fine.dofs} dofs, hbw ${fine.hbw}): u=${fine.u.toExponential(2)} p=${fine.p.toExponential(2)} tau=${fine.tau.toExponential(2)}`,
  );
  expectBelow(`[${label}] coarse u`, coarse.u, 0.02);
  expectBelow(`[${label}] coarse tau`, coarse.tau, 0.1);
  expectBelow(`[${label}] coarse p`, coarse.p, 0.2);
  expectBelow(`[${label}] fine u`, fine.u, coarse.u / 1.4);
  expectBelow(`[${label}] fine tau`, fine.tau, coarse.tau / 1.4);
  expectBelow(`[${label}] fine p`, fine.p, coarse.p / 1.4);
  // the PH increment metric floors at the Cholesky roundoff level for high
  // contrast; the true divergence is smaller by the penalty factor ~1e3
  expectBelow(`[${label}] div`, fine.div, 1e-5);
}

// --- 2. rigid square vs Schmid (2005) ---------------------------------------
{
  const er = -1, gr = 0.4;
  const pol = solvePolygon({ shape: 'square', sharp: 0.5, alpha: 0, er, gr });
  const square = pol.outline(96).slice(0, 96) as Array<[number, number]>;

  function squareErrors(scale: number) {
    const mesh = buildMesh({
      boundaries: [
        { pts: circlePts(2.5, 96), marker: 1 },
        { pts: square, marker: 2 },
      ],
      regions: [[1.9, 0, 1, 0.03 * scale]],
      holes: [[0, 0]],
    });
    const fem = solveStokesTri({
      mesh,
      muOfAttr: () => 1,
      bc: (marker, x, y) =>
        marker === 1 ? pol.velAt(x, y) : [(gr / 2) * y, -(gr / 2) * x],
    });
    const sample: Array<[number, number]> = [];
    for (let i = 0; i <= 30; i++) {
      const r = 1.35 + (1.05 * i) / 30;
      for (let j = 0; j < 72; j++) {
        const t = ((j + 0.31) * 2 * Math.PI) / 72;
        sample.push([r * Math.cos(t), r * Math.sin(t)]);
      }
    }
    let shiftSum = 0;
    let cnt = 0;
    for (const [x, y] of sample) {
      const f = fem.evalAt(x, y);
      if (!f) continue;
      shiftSum += f.p - pol.evalAt(x, y).p;
      cnt++;
    }
    const shift = shiftSum / cnt;
    let e2p = 0, n2p = 0, e2t = 0, n2t = 0;
    for (const [x, y] of sample) {
      const f = fem.evalAt(x, y);
      if (!f) continue;
      const a = pol.evalAt(x, y);
      e2p += (f.p - shift - a.p) ** 2;
      n2p += a.p ** 2 + 1e-12;
      e2t += (f.tau - a.tau) ** 2;
      n2t += a.tau ** 2;
    }
    return { p: Math.sqrt(e2p / n2p), tau: Math.sqrt(e2t / n2t), dofs: fem.dofs };
  }

  const coarse = squareErrors(1);
  const fine = squareErrors(0.25);
  console.log(
    `[tri square] coarse(${coarse.dofs} dofs): p=${coarse.p.toExponential(2)} tau=${coarse.tau.toExponential(2)}`,
  );
  console.log(
    `[tri square] fine  (${fine.dofs} dofs): p=${fine.p.toExponential(2)} tau=${fine.tau.toExponential(2)}`,
  );
  expectBelow('[tri square] coarse p', coarse.p, 0.2);
  expectBelow('[tri square] coarse tau', coarse.tau, 0.1);
  expectBelow('[tri square] fine p', fine.p, coarse.p / 1.3);
  expectBelow('[tri square] fine tau', fine.tau, coarse.tau / 1.3);
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
