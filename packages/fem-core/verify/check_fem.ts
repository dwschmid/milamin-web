// Checks the browser Stokes FEM (src/stokesfem.ts) against the closed-form
// circular-inclusion solution (src/circle.ts): with exact analytical
// velocities imposed on the inner and outer boundary rings, the FEM fields
// must converge to the analytical ones under mesh refinement.
// Run: npm run verify

import { solve as solveCircle } from '../../analytic/src/circle';
import { solveStokesFem } from '../src/stokesfem';

let failures = 0;
let checks = 0;

function expectBelow(what: string, got: number, bound: number) {
  checks++;
  if (!(got < bound) || Number.isNaN(got)) {
    failures++;
    console.error(`FAIL ${what}: ${got} not below ${bound}`);
  }
}

function errors(m: number, er: number, gr: number, nTheta: number, nrIn: number, nrOut: number) {
  const exact = solveCircle({ m, er, gr });
  const fem = solveStokesFem({
    nTheta,
    nrIn,
    nrOut,
    rIn: 0.2,
    rInterface: 1,
    rOut: 2.5,
    mu: (x, y) => (x * x + y * y <= 1 ? m : 1),
    bcVel: (x, y) => exact.velAt(x, y),
  });

  // sample on a polar grid strictly inside the annulus
  const NR = 40;
  const NT = 72;
  // first pass: best constant shift for the pressure (defined up to a constant)
  let shiftSum = 0;
  let cnt = 0;
  const sample: Array<[number, number]> = [];
  for (let i = 0; i <= NR; i++) {
    const r = 0.21 + (2.28 * i) / NR;
    for (let j = 0; j < NT; j++) {
      const t = ((j + 0.31) * 2 * Math.PI) / NT;
      sample.push([r * Math.cos(t), r * Math.sin(t)]);
    }
  }
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
  };
}

for (const { m, er, gr } of [
  { m: 1000, er: 0, gr: 1 },
  { m: 0.01, er: 1, gr: 0.3 },
]) {
  const label = `m=${m} er=${er} gr=${gr}`;
  const coarse = errors(m, er, gr, 24, 6, 10);
  const fine = errors(m, er, gr, 48, 12, 20);
  console.log(
    `[${label}] coarse(${coarse.dofs} dofs): u=${coarse.u.toExponential(2)} p=${coarse.p.toExponential(2)} tau=${coarse.tau.toExponential(2)} div=${coarse.div.toExponential(1)}`,
  );
  console.log(
    `[${label}] fine  (${fine.dofs} dofs): u=${fine.u.toExponential(2)} p=${fine.p.toExponential(2)} tau=${fine.tau.toExponential(2)} div=${fine.div.toExponential(1)}`,
  );
  expectBelow(`[${label}] coarse u error`, coarse.u, 0.02);
  expectBelow(`[${label}] coarse tau error`, coarse.tau, 0.1);
  expectBelow(`[${label}] coarse p error`, coarse.p, 0.15);
  expectBelow(`[${label}] fine u error`, fine.u, coarse.u / 1.5);
  expectBelow(`[${label}] fine tau error`, fine.tau, coarse.tau / 1.5);
  expectBelow(`[${label}] fine p error`, fine.p, coarse.p / 1.5);
  expectBelow(`[${label}] div residual`, fine.div, 1e-8);
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
