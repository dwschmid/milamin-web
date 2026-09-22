// Checks the folding/boudinage simulation end to end:
//  1. the ported growth-rate formulas against each other in their common
//     limits (bounded -> unbounded, power-law -> linear),
//  2. the FEM small-amplitude growth rate against the analytical linear
//     rates, for folding (shortening) and thinning (extension); the
//     extension check also pins the sign convention dlnA/dt = -(1 + q),
//  3. power-law runs: tightly-converged Picard iterations must reproduce
//     the small-amplitude power-law rates (Fletcher 1974 folding, Pollard &
//     Fletcher 1994 necking) - Newton would only get there in fewer
//     iterations; at finite amplitude a power-law layer under extension
//     must localize (amplitude grows) while a linear layer thins passively,
//  4. multilayer and noise runs execute and amplify.
// Run: npm run verify (about 10 minutes)

import { initTriangle } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import { initialState, amplitude } from '../src/geometry';
import { SimParams, solveState, stepHeun, timeSpan } from '../src/sim';
import {
  qBiotThin,
  qFletcherThick,
  qFletcherBounded,
  qNeckThick,
  qNeckBounded,
  qPowerLawThick,
  dominantWavelength,
  dominantWavelengthOf,
} from '../src/growth';

let failures = 0;
let checks = 0;

function expectClose(what: string, got: number, want: number, rtol: number) {
  checks++;
  const err = Math.abs(got - want) / Math.abs(want);
  const ok = err < rtol && !Number.isNaN(got);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: got ${got.toFixed(4)}, want ${want.toFixed(4)} (rel err ${(err * 100).toFixed(2)}%)`);
}

function expectAbove(what: string, got: number, bound: number) {
  checks++;
  const ok = got > bound && !Number.isNaN(got);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got} ${ok ? '>' : 'not >'} ${bound}`);
}

function expectBelow(what: string, got: number, bound: number) {
  checks++;
  const ok = got < bound && !Number.isNaN(got);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got} ${ok ? '<' : 'not <'} ${bound}`);
}

await initTriangle();
await initSpchol();

// --- formula consistency ------------------------------------------------------

// far boundaries: the bounded expressions must reduce to the infinite-matrix ones
for (const [k, R] of [
  [0.4, 100],
  [1.2, 25],
  [2.5, 500],
] as const) {
  expectClose(
    `fold bounded -> thick limit (k=${k}, R=${R})`,
    qFletcherBounded(k, R, 50),
    qFletcherThick(k, R),
    1e-6,
  );
  expectClose(
    `neck bounded -> thick limit (k=${k}, R=${R})`,
    qNeckBounded(k, R, 50),
    qNeckThick(k, R),
    1e-6,
  );
}

// power-law expressions reduce to the linear ones as nl, nm -> 1
for (const [k, R] of [
  [0.4, 100],
  [1.0, 25],
] as const) {
  expectClose(`power law -> linear fold (k=${k}, R=${R})`, qPowerLawThick(k, R, 1, 1, false), qFletcherThick(k, R), 0.01);
  expectClose(`power law -> linear neck (k=${k}, R=${R})`, qPowerLawThick(k, R, 1, 1, true), qNeckThick(k, R), 0.01);
}

// thin and thick plate agree in the thin-plate regime (long wavelength, high R)
expectClose('thin vs thick plate (k=0.15, R=1000)', qBiotThin(0.15, 1000), qFletcherThick(0.15, 1000), 0.08);

// Biot dominant wavelength: thin-plate growth rate peaks there; the numeric
// scan on the thick-plate curve lands nearby
{
  const R = 100;
  const kd = (2 * Math.PI) / dominantWavelength(R);
  expectAbove('q(kd) > q(0.8 kd)', qBiotThin(kd, R) - qBiotThin(0.8 * kd, R), 0);
  expectAbove('q(kd) > q(1.2 kd)', qBiotThin(kd, R) - qBiotThin(1.2 * kd, R), 0);
  const ld = dominantWavelengthOf((k) => qFletcherThick(k, R));
  expectClose('numeric dominant wavelength (R=100)', ld ?? NaN, dominantWavelength(R), 0.1);
  // linear viscous necking is stable everywhere
  checks++;
  const ldNeck = dominantWavelengthOf((k) => qNeckThick(k, R));
  if (ldNeck !== null) {
    failures++;
    console.log(`FAIL linear necking has no growing wavelength: got ${ldNeck}`);
  } else {
    console.log('ok   linear necking has no growing wavelength');
  }
}

// --- FEM growth rates vs analytical ----------------------------------------------

function baseParams(over: Partial<SimParams>): SimParams {
  return {
    R: 100,
    nLayer: 1,
    nMatrix: 1,
    mode: 'shortening',
    layers: 1,
    spacing: 3,
    perturbation: 'sine',
    amp0: 1e-3,
    wavelength: 16,
    seed: 1,
    boxWidth: 32,
    boxHeight: 16,
    nx: 193,
    strainPct: 1,
    nSteps: 2,
    areaLayer: 0.02,
    areaMatrix: 0.2,
    backend: 'sparse',
    ...over,
  };
}

/** ln(A/A0) per unit log strain over a short run. */
function measureGrowth(p: SimParams): number {
  let state = initialState(p);
  const A0 = amplitude(state);
  const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
  for (let s = 0; s < p.nSteps; s++) {
    const s1 = solveState(state, p);
    state = stepHeun(state, p, dt, s1);
  }
  return Math.log(amplitude(state) / A0) / timeSpan(p.strainPct, p.mode);
}

// folding, linear: dlnA/dt = 1 + q (banded once to cover that backend)
for (const [R, wl, backend] of [
  [100, 16, 'banded'],
  [25, 10, 'sparse'],
] as const) {
  const waves = Math.max(1, Math.round(32 / wl));
  const p = baseParams({ R, wavelength: wl, boxWidth: waves * wl, nx: Math.round(6 * waves * wl) + 1, backend });
  const qNum = measureGrowth(p) - 1;
  expectClose(`FEM fold growth rate (R=${R}, wavelength=${wl}h)`, qNum, qFletcherBounded((2 * Math.PI) / wl, R, 8), 0.05);
}

// thinning under extension, linear: dlnA/dt = -(1 + q), q < 0
{
  const p = baseParams({ mode: 'extension' });
  const qNum = -measureGrowth(p) - 1;
  expectClose('FEM neck growth rate (R=100, wavelength=16h)', qNum, qNeckBounded((2 * Math.PI) / 16, 100, 8), 0.05);
}

// power law at small amplitude: converged Picard reproduces the analytical
// power-law rates (unbounded-matrix formulas, so a few % boundary effect
// remain); a loose tolerance would exit on the linear solution instead
{
  const tight = { picardTol: 1e-4, picardMaxIt: 60 } as const;
  const k = (2 * Math.PI) / 16;
  const pFold = baseParams({ nLayer: 3, ...tight });
  expectClose(
    'FEM power-law fold rate (nl=3, converged Picard)',
    measureGrowth(pFold) - 1,
    qPowerLawThick(k, 100, 3, 1, false),
    0.06,
  );
  const pNeck = baseParams({ mode: 'extension', nLayer: 3, ...tight });
  expectClose(
    'FEM power-law neck rate (nl=3, converged Picard)',
    -measureGrowth(pNeck) - 1,
    qPowerLawThick(k, 100, 3, 1, true),
    0.08,
  );
}

// the same at the app's DEFAULT Picard settings: the relative stopping
// criterion must reach the power-law rate for a small perturbation too (the
// earlier absolute criterion exited on the linear solution here, 67% low)
{
  const k = (2 * Math.PI) / 16;
  const pNeckDefault = baseParams({ mode: 'extension', nLayer: 3 });
  expectClose(
    'FEM power-law neck rate at default Picard settings (nl=3, amp 1e-3)',
    -measureGrowth(pNeckDefault) - 1,
    qPowerLawThick(k, 100, 3, 1, true),
    0.06,
  );
}

// finite amplitude: power-law layer localizes under extension, linear thins
function finiteAmplitudeRun(nl: number, nm: number): number {
  const p = baseParams({
    R: 50,
    nLayer: nl,
    nMatrix: nm,
    mode: 'extension',
    amp0: 0.1,
    nx: 129,
    strainPct: 60,
    nSteps: 6,
    areaLayer: 0.05,
    areaMatrix: 0.4,
  });
  let state = initialState(p);
  const A0 = amplitude(state);
  const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
  for (let s = 0; s < p.nSteps; s++) {
    const s1 = solveState(state, p);
    state = stepHeun(state, p, dt, s1);
  }
  return amplitude(state) / A0;
}
expectBelow('finite-amplitude linear layer thins (A/A0 at 60% ext)', finiteAmplitudeRun(1, 1), 1);
expectAbove('finite-amplitude power-law layer necks (A/A0 at 60% ext)', finiteAmplitudeRun(5, 3), 1.8);

// --- multilayer and noise runs ------------------------------------------------------

{
  const p = baseParams({
    layers: 3,
    spacing: 3,
    boxHeight: 20,
    amp0: 0.02,
    strainPct: 20,
    nSteps: 3,
    areaLayer: 0.05,
    areaMatrix: 0.4,
    nx: 129,
  });
  let state = initialState(p);
  const A0 = amplitude(state);
  const s1 = solveState(state, p);
  const attrs = new Set<number>();
  for (const a of s1.core.triMu) attrs.add(a);
  expectAbove('multilayer mesh has layer and matrix viscosities', attrs.size, 1);
  const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
  state = stepHeun(state, p, dt, s1);
  for (let s = 1; s < p.nSteps; s++) {
    const si = solveState(state, p);
    state = stepHeun(state, p, dt, si);
  }
  expectAbove('multilayer run amplifies (A/A0)', amplitude(state) / A0, 1.5);
}

{
  const p = baseParams({
    perturbation: 'white',
    amp0: 0.02,
    strainPct: 20,
    nSteps: 4,
    areaLayer: 0.05,
    areaMatrix: 0.4,
    nx: 193,
  });
  let state = initialState(p);
  const A0 = amplitude(state);
  const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
  for (let s = 0; s < p.nSteps; s++) {
    const s1 = solveState(state, p);
    state = stepHeun(state, p, dt, s1);
  }
  expectAbove('noise run amplifies (A/A0)', amplitude(state) / A0, 1.2);
}

console.log(`\n${checks} checks, ${failures} failures`);
if (failures) process.exit(1);
