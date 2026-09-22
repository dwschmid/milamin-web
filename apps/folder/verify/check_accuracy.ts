// Accuracy/cost checks on the ordinary power-law range. Keep app defaults;
// use the same cross-step warm start as the browser worker.
import assert from 'node:assert/strict';
import { initTriangle } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import { initialState, amplitude, resampleFaces, type SimState } from '../src/geometry';
import { solveState, stepHeun, timeSpan, type SimParams, type SolveOut } from '../src/sim';

await initTriangle();
await initSpchol({ forceSingleThread: true });
function params(nLayer: number, nSteps: number, nx = 193): SimParams {
  return { R: 100, nLayer, nMatrix: 1, mode: 'extension', layers: 1, spacing: 3,
    perturbation: 'sine', amp0: .01, wavelength: 16, seed: 1, boxWidth: 32,
    boxHeight: 16, nx, strainPct: 20, nSteps, areaLayer: .05, areaMatrix: .4, backend: 'sparse' };
}
function layerArea(s: SimState): number {
  const integral = (f: SimState['faces'][number]) => {
    let sum = 0;
    for (let i = 1; i < f.X.length; i++) sum += (f.X[i] - f.X[i - 1]) * (f.Y[i] + f.Y[i - 1]) / 2;
    return sum;
  };
  return integral(s.faces[1]) - integral(s.faces[0]);
}
function run(p: SimParams) {
  let state = initialState(p);
  const A0 = amplitude(state), area0 = layerArea(state);
  const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
  const warm: { evalAt?: SolveOut['evalAt'] } = {};
  let solves = 0, capped = 0;
  p.onPicard = (it, residual) => { if (it === 19 && residual >= .01) capped++; };
  p.onProgress = (stage) => { if (stage === 'solve') solves++; };
  const t0 = performance.now();
  for (let i = 0; i < p.nSteps; i++) {
    const sol = solveState(state, p, warm.evalAt);
    state = stepHeun(state, p, dt, sol, warm);
  }
  return { amplification: amplitude(state) / A0, areaError: Math.abs(layerArea(state) / area0 - 1),
    widthError: Math.abs(state.halfW / (p.boxWidth / 2) - (1 + p.strainPct / 100)), nodes: state.faces[1].X.length, solves, capped,
    seconds: (performance.now() - t0) / 1000 };
}
for (const n of [1, 3, 5]) {
  const rows = [2, 4, 8].map(steps => {
    const result = run(params(n, steps));
    console.log(JSON.stringify({ n, steps, ...result }));
    assert.equal(result.capped, 0, `n=${n}: ordinary-range test should converge at app defaults`);
    return result;
  });
  const coarseChange = Math.abs(rows[1].amplification - rows[0].amplification);
  const fineChange = Math.abs(rows[2].amplification - rows[1].amplification);
  assert.ok(fineChange < .8 * coarseChange, `n=${n}: amplitude should stabilize under timestep refinement`);
  assert.ok(fineChange / rows[2].amplification < .01, `n=${n}: 4 vs 8 steps differ by less than 1%`);
  assert.ok(rows[2].areaError < 1e-5, `n=${n}: fine-step layer area drift`);
  assert.ok(rows[2].areaError < rows[0].areaError, `n=${n}: area drift decreases`);
  assert.ok(rows[1].widthError / rows[2].widthError > 3.5, 'Heun box advection is second order');
}

// A larger extension triggers automatic resampling in the actual warm-start
// simulation. Refine interface spacing with the Stokes area limits held fixed.
const coupled = [97, 193].map(nx => {
  const p = { ...params(3, 8, nx), strainPct: 40 };
  const result = run(p);
  console.log(JSON.stringify({ coupledResampling: true, nx, ...result }));
  assert.ok(result.nodes > nx, 'extension should trigger interface resampling');
  assert.ok(result.areaError < .001, 'coupled layer area drift below 0.1%');
  return result;
});
assert.ok(Math.abs(coupled[0].amplification / coupled[1].amplification - 1) < .02,
  'coupled amplification should agree within 2% after interface refinement');

// Isolate resampling from Stokes/Heun: decimate a densely sampled smooth,
// non-uniformly thick layer, then compare its area with an exact integral.
let previousError = Infinity;
for (const nodes of [33, 65, 129]) {
  const p = params(3, 2, 1025);
  const state = initialState(p);
  const top = state.faces[1];
  for (let i = 0; i < top.X.length; i++) top.Y[i] += .1 * ((top.X[i] + p.boxWidth / 2) / p.boxWidth) ** 4;
  resampleFaces(state, p.boxWidth / (nodes - 1));
  const error = Math.abs(layerArea(state) - p.boxWidth * 1.02);
  console.log(JSON.stringify({ resampleNodes: nodes, actualNodes: state.faces[1].X.length, areaError: error }));
  assert.ok(error < previousError * .4, "resampled area should converge with interface spacing");
  previousError = error;
}
assert.ok(previousError / 32.64 < 1e-5, "fine resampling area error");
console.log("FOLDER accuracy checks passed");
