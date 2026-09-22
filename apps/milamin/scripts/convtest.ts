// Why is the velocity order capped at 2? Hypothesis: the polygonal
// approximation of the curved interface. Test: measure the velocity error
// separately near the interface and away from it — away from the interface
// the element's full (cubic) order should reappear.
// Run: npx tsx apps/milamin/scripts/convtest.ts
import { initTriangle, buildMesh } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import { solveStokesTri, triEvaluator } from '@fem/stokesfem-tri';
import { solve as solveCircle } from '@ana/circle';

await initTriangle();
await initSpchol({ forceSingleThread: true });

const exact = solveCircle({ m: 1000, er: 0, gr: 1 });
const R_OUT = 2.5;
const AREA0 = 0.08;

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

interface Errs { global: number; near: number; away: number; }
const prev: { [k in keyof Errs]?: number } = {};

for (let k = 0; k < 5; k++) {
  const area = AREA0 / 4 ** k;
  const mesh = buildMesh({
    boundaries: [
      { pts: circlePts(R_OUT, 48 * 2 ** k), marker: 1 },
      { pts: circlePts(1, 32 * 2 ** k), marker: 2 },
    ],
    regions: [
      [0, 0, 2, 2 * area],
      [(1 + R_OUT) / 2, 0, 1, area],
    ],
  });
  const sol = solveStokesTri({
    mesh,
    muOfAttr: (a) => (a === 2 ? 1000 : 1),
    bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
    backend: 'sparse',
  });
  const evalAt = triEvaluator(sol);
  const N = 200;
  const acc = { global: [0, 0], near: [0, 0], away: [0, 0] };
  for (let j = 0; j < N; j++) {
    const y = ((j + 0.5) / N - 0.5) * 2 * (R_OUT - 0.05);
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * 2 * (R_OUT - 0.05);
      const r = Math.hypot(x, y);
      if (r > R_OUT - 0.05) continue;
      const s = evalAt(x, y);
      if (!s) continue;
      const [ue, ve] = exact.velAt(x, y);
      const d = (s.u - ue) ** 2 + (s.v - ve) ** 2;
      const e = ue * ue + ve * ve;
      acc.global[0] += d; acc.global[1] += e;
      // near: annulus 0.8 < r < 1.2 around the interface; away: the rest
      if (r > 0.8 && r < 1.2) { acc.near[0] += d; acc.near[1] += e; }
      else { acc.away[0] += d; acc.away[1] += e; }
    }
  }
  const errs: Errs = {
    global: Math.sqrt(acc.global[0] / acc.global[1]),
    near: Math.sqrt(acc.near[0] / acc.near[1]),
    away: Math.sqrt(acc.away[0] / acc.away[1]),
  };
  const line = (Object.keys(errs) as Array<keyof Errs>)
    .map((key) => {
      const rate = prev[key] ? ` (p=${Math.log2(prev[key]! / errs[key]).toFixed(1)})` : '';
      prev[key] = errs[key];
      return `${key}=${errs[key].toExponential(2)}${rate}`;
    })
    .join('  ');
  console.log(`level ${k}  dofs=${String(sol.dofs).padStart(7)}  ${line}`);
}

// --- control experiment: exact polygonal geometry, smooth cubic solution ----
// psi = x^3 y - x y^3 is harmonic => biharmonic, potential flow, p = const.
// u = dpsi/dy = x^3 - 3xy^2, v = -dpsi/dx = -3x^2 y + y^3. No body force.
console.log('\nsquare domain (exact geometry), cubic exact solution:');
const uEx = (x: number, y: number): [number, number] => [x ** 3 - 3 * x * y * y, -3 * x * x * y + y ** 3];
let prevSq: number | undefined;
for (let k = 0; k < 5; k++) {
  const area = 0.08 / 4 ** k;
  const mesh = buildMesh({
    boundaries: [{ pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]], marker: 1 }],
    regions: [[0, 0, 1, area]],
  });
  const sol = solveStokesTri({
    mesh,
    muOfAttr: () => 1,
    bc: (marker, x, y) => (marker === 1 ? uEx(x, y) : null),
    backend: 'sparse',
  });
  const evalAt = triEvaluator(sol);
  const N = 160;
  let d = 0, e = 0;
  for (let j = 0; j < N; j++) {
    const y = ((j + 0.5) / N - 0.5) * 1.9;
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * 1.9;
      const s = evalAt(x, y);
      if (!s) continue;
      const [ue, ve] = uEx(x, y);
      d += (s.u - ue) ** 2 + (s.v - ve) ** 2;
      e += ue * ue + ve * ve;
    }
  }
  const err = Math.sqrt(d / e);
  console.log(
    `level ${k}  dofs=${String(sol.dofs).padStart(7)}  errV=${err.toExponential(2)}` +
      (prevSq ? ` (p=${Math.log2(prevSq / err).toFixed(1)})` : ''),
  );
  prevSq = err;
}

// --- second control: exact geometry AND non-trivial pressure ----------------
// psi = x^4 - y^4: biharmonic, not harmonic => rotational flow, p = -24 mu xy.
// u = dpsi/dy = -4y^3, v = -dpsi/dx = -4x^3, still no body force.
// If the P2+bubble / P1disc pair were pressure-limited, velocity would cap
// at O(h^2) here; if geometry was the cap in the inclusion study, this stays 3.
console.log('\nsquare domain, non-trivial pressure (p = -24xy):');
const uEx2 = (x: number, y: number): [number, number] => [-4 * y ** 3, -4 * x ** 3];
const tauEx2 = (x: number, y: number) => 6 * (x * x + y * y) * 2; // 2 mu |e_xy|, mu=1
let prevV: number | undefined, prevT: number | undefined;
for (let k = 0; k < 5; k++) {
  const area = 0.08 / 4 ** k;
  const mesh = buildMesh({
    boundaries: [{ pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]], marker: 1 }],
    regions: [[0, 0, 1, area]],
  });
  const sol = solveStokesTri({
    mesh,
    muOfAttr: () => 1,
    bc: (marker, x, y) => (marker === 1 ? uEx2(x, y) : null),
    backend: 'sparse',
  });
  const evalAt = triEvaluator(sol);
  const N = 160;
  let d = 0, e = 0, dt = 0, et = 0;
  for (let j = 0; j < N; j++) {
    const y = ((j + 0.5) / N - 0.5) * 1.9;
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * 1.9;
      const s = evalAt(x, y);
      if (!s) continue;
      const [ue, ve] = uEx2(x, y);
      d += (s.u - ue) ** 2 + (s.v - ve) ** 2;
      e += ue * ue + ve * ve;
      const te = tauEx2(x, y);
      dt += (s.tau - te) ** 2;
      et += te * te;
    }
  }
  const errV = Math.sqrt(d / e);
  const errT = Math.sqrt(dt / et);
  console.log(
    `level ${k}  dofs=${String(sol.dofs).padStart(7)}` +
      `  errV=${errV.toExponential(2)}${prevV ? ` (p=${Math.log2(prevV / errV).toFixed(1)})` : ''}` +
      `  errTau=${errT.toExponential(2)}${prevT ? ` (p=${Math.log2(prevT / errT).toFixed(1)})` : ''}`,
  );
  prevV = errV;
  prevT = errT;
}
