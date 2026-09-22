// Time stepping for the folding/boudinage simulation, following FOLDER's
// scheme: the interface polylines are the state, every velocity evaluation is
// a full Triangle remesh plus Stokes solve, and one step is a Heun (RK2)
// update. Boundary conditions are free-slip pure shear at unit strain rate,
// so with time measured in logarithmic strain the box evolves exponentially.
// Power-law rheology is handled by Picard iterations: the effective viscosity
// mu * eII^(1/n - 1) is re-evaluated per element from the last solution until
// it stops changing. Converged tightly enough, this reproduces the analytical
// small-amplitude power-law growth rates (Fletcher 1974, Pollard & Fletcher
// 1994) - a Newton scheme would reach the same fixed point in fewer
// iterations, nothing more (verified in check_folding.ts).

import { buildMesh } from '@fem/trimesh';
import { solveStokesTri, triEvaluator, StokesTriCore } from '@fem/stokesfem-tri';
import { ModelParams, SimState, StrainMode, toMeshSpec, resampleFaces } from './geometry';

export interface SimParams extends ModelParams {
  /** layer/matrix viscosity ratio at the background strain rate */
  R: number;
  /** stress exponent of the layer (1 = linear viscous) */
  nLayer: number;
  /** stress exponent of the matrix */
  nMatrix: number;
  /** total shortening or extension in percent */
  strainPct: number;
  nSteps: number;
  areaLayer: number;
  areaMatrix: number;
  backend?: 'banded' | 'sparse';
  /** Picard stop: the max |log mu change| of an iteration, relative to the
   *  max |log mu deviation| of the effective viscosity from its background
   *  value (default 1e-2). Relative, so a small perturbation, whose viscosity
   *  deviation is itself small, converges to the same relative accuracy
   *  instead of exiting on the linear solution after one update. */
  picardTol?: number;
  /** Picard iteration cap (default 20) */
  picardMaxIt?: number;
  /** strain-rate floor of the power-law viscosity, relative to the background
   *  rate (default 1e-2); keeps hinges finite and the Picard map smooth */
  picardEMin?: number;
  /** progress callback per mesh and per Stokes solve (Picard iteration
   *  counted from 1); set locally by the worker, not part of the request */
  onProgress?: (phase: 'mesh' | 'solve', iteration: number) => void;
  /** per Picard iteration: the max |log viscosity change| that iteration made */
  onPicard?: (iteration: number, change: number) => void;
}

export interface SolveOut {
  core: StokesTriCore;
  evalAt: ReturnType<typeof triEvaluator>;
  meshMs: number;
  picardIterations: number;
  /** relative viscosity change of the last Picard iteration: max |log mu
   *  change| over max |log mu deviation from background| (0 = linear) */
  picardChange: number;
  /** wall time of the whole solveState call: mesh and every Stokes solve */
  solveMs: number;
}

/** +1 for shortening, -1 for extension. */
export function dirOf(mode: StrainMode): number {
  return mode === 'shortening' ? 1 : -1;
}

/** Total time span: uniform steps in log strain give a constant dt. */
export function timeSpan(strainPct: number, mode: StrainMode = 'shortening'): number {
  return mode === 'shortening' ? -Math.log(1 - strainPct / 100) : Math.log(1 + strainPct / 100);
}

/**
 * Free-slip pure shear: the normal velocity component is prescribed on each
 * wall, the tangential one left free (NaN). Decided from coordinates rather
 * than markers so wall/interface junction nodes and box corners are handled
 * uniformly.
 */
export function pureShearBC(halfW: number, halfH: number, dir: number) {
  const eps = 1e-9 * Math.max(halfW, halfH);
  return (_marker: number, x: number, y: number): [number, number] | null => {
    const onVertical = Math.abs(x) >= halfW - eps;
    const onHorizontal = Math.abs(y) >= halfH - eps;
    if (!onVertical && !onHorizontal) return null;
    return [onVertical ? -dir * x : NaN, onHorizontal ? dir * y : NaN];
  };
}

/** Strain-rate second invariant at each element centroid (the bubble's
 *  gradient vanishes there, so only the six nodal velocities contribute). */
function elementEII(core: StokesTriCore): Float64Array {
  const { nodeX, nodeY, tri6, u } = core;
  const out = new Float64Array(core.elements);
  for (let e = 0; e < core.elements; e++) {
    const c0 = tri6[e * 6], c1 = tri6[e * 6 + 1], c2 = tri6[e * 6 + 2];
    const x0 = nodeX[c0], y0 = nodeY[c0];
    const det = (nodeX[c1] - x0) * (nodeY[c2] - y0) - (nodeX[c2] - x0) * (nodeY[c1] - y0);
    const g1x = (nodeY[c2] - y0) / det, g1y = -(nodeX[c2] - x0) / det;
    const g2x = -(nodeY[c1] - y0) / det, g2y = (nodeX[c1] - x0) / det;
    const g0x = -g1x - g2x, g0y = -g1y - g2y;
    // quadratic shape gradients at the centroid (L = 1/3 each)
    const gx = [g0x / 3, g1x / 3, g2x / 3, (4 / 3) * (g1x + g2x), (4 / 3) * (g2x + g0x), (4 / 3) * (g0x + g1x)];
    const gy = [g0y / 3, g1y / 3, g2y / 3, (4 / 3) * (g1y + g2y), (4 / 3) * (g2y + g0y), (4 / 3) * (g0y + g1y)];
    let exx = 0, eyy = 0, exy = 0;
    for (let a = 0; a < 6; a++) {
      const ua = u[2 * tri6[e * 6 + a]];
      const va = u[2 * tri6[e * 6 + a] + 1];
      exx += gx[a] * ua;
      eyy += gy[a] * va;
      exy += 0.5 * (gy[a] * ua + gx[a] * va);
    }
    out[e] = Math.sqrt(((exx - eyy) / 2) ** 2 + exy ** 2);
  }
  return out;
}

/**
 * Mesh the state and solve Stokes on it. `warm` is the evaluator of a
 * previous solution of nearly the same state: the Picard iteration then
 * starts from that solution's strain rates instead of the background, which
 * saves most of the iterations once the fold has grown (the fixed point is the
 * same; only the start differs).
 */
export function solveState(state: SimState, p: SimParams, warm?: SolveOut['evalAt'] | null): SolveOut {
  const t0 = performance.now();
  p.onProgress?.('mesh', 0);
  const mesh = buildMesh(toMeshSpec(state, p.areaLayer, p.areaMatrix));
  const meshMs = performance.now() - t0;
  const bc = pureShearBC(state.halfW, state.halfH, dirOf(p.mode));
  const backend = p.backend ?? 'sparse';
  const baseMu = (attr: number) => (attr === 2 ? p.R : 1);

  if (p.nLayer === 1 && p.nMatrix === 1) {
    p.onProgress?.('solve', 1);
    const sol = solveStokesTri({ mesh, muOfAttr: baseMu, bc, backend });
    const { evalAt, ...core } = sol;
    return { core, evalAt, meshMs, picardIterations: 1, picardChange: 0, solveMs: performance.now() - t0 };
  }

  // Picard: mu_eff = mu(background) * eII^(1/n - 1), normalized so that the
  // background pure shear (eII = 1) reproduces the given viscosity ratio;
  // cutoffs three decades either side keep hinges and stagnant zones finite
  const expOf = (attr: number) => 1 / (attr === 2 ? p.nLayer : p.nMatrix) - 1;
  const muEl = new Float64Array(mesh.nTri);
  // Carreau-style regularization: the effective strain rate never drops below
  // eMin (relative to the background rate 1), so hinges and stagnant zones
  // get a finite, smoothly varying viscosity instead of jumping against the
  // hard cutoff, which is what stalled the Picard iteration at its cap
  const eMin = p.picardEMin ?? 1e-2;
  const muOf = (attr: number, eII: number) => {
    const base = baseMu(attr);
    const eEff = Math.sqrt(eII * eII + eMin * eMin);
    return Math.min(base * 1e3, Math.max(base * 1e-3, base * Math.pow(eEff, expOf(attr))));
  };
  for (let e = 0; e < mesh.nTri; e++) {
    let eII: number | null = null;
    if (warm) {
      const c0 = mesh.tri6[e * 6], c1 = mesh.tri6[e * 6 + 1], c2 = mesh.tri6[e * 6 + 2];
      const s = warm(
        (mesh.nodeX[c0] + mesh.nodeX[c1] + mesh.nodeX[c2]) / 3,
        (mesh.nodeY[c0] + mesh.nodeY[c1] + mesh.nodeY[c2]) / 3,
      );
      if (s) eII = s.eII;
    }
    muEl[e] = eII === null ? baseMu(mesh.triAttr[e]) : muOf(mesh.triAttr[e], eII);
  }
  const tol = p.picardTol ?? 1e-2;
  const maxIt = p.picardMaxIt ?? 20;
  p.onProgress?.('solve', 1);
  let sol = solveStokesTri({ mesh, muPerElement: muEl, bc, backend });
  let iterations = 1;
  let lastChange = 0;
  for (let it = 0; it < maxIt - 1; it++) {
    const eII = elementEII(sol);
    let change = 0;
    let deviation = 0;
    for (let e = 0; e < mesh.nTri; e++) {
      const target = muOf(mesh.triAttr[e], eII[e]);
      change = Math.max(change, Math.abs(Math.log(target / muEl[e])));
      deviation = Math.max(deviation, Math.abs(Math.log(target / baseMu(mesh.triAttr[e]))));
      muEl[e] = target;
    }
    lastChange = deviation > 0 ? change / deviation : 0;
    p.onPicard?.(iterations, lastChange);
    if (lastChange < tol) break;
    p.onProgress?.('solve', iterations + 1);
    sol = solveStokesTri({ mesh, muPerElement: muEl, bc, backend });
    iterations++;
  }
  const { evalAt, ...core } = sol;
  return { core, evalAt, meshMs, picardIterations: iterations, picardChange: lastChange, solveMs: performance.now() - t0 };
}

/** Velocities at the polyline nodes; the background pure-shear field covers
 *  the rare lookup miss when a node sits exactly on the mesh hull. */
function sampleVel(
  evalAt: SolveOut['evalAt'],
  X: Float64Array,
  Y: Float64Array,
  dir: number,
): { u: Float64Array; v: Float64Array } {
  const n = X.length;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = evalAt(X[i], Y[i]);
    u[i] = s ? s.u : -dir * X[i];
    v[i] = s ? s.v : dir * Y[i];
  }
  return { u, v };
}

function clamp(s: SimState): void {
  for (const f of s.faces) {
    const n = f.X.length;
    for (let i = 0; i < n; i++) {
      f.X[i] = Math.min(s.halfW, Math.max(-s.halfW, f.X[i]));
      f.Y[i] = Math.min(s.halfH, Math.max(-s.halfH, f.Y[i]));
    }
    // interface endpoints ride on the walls
    f.X[0] = -s.halfW;
    f.X[n - 1] = s.halfW;
  }
}

/**
 * One Heun step from `state`; `s1` must be the solve of `state` (the caller
 * keeps it for rendering). Runs the second stage solve internally. The box
 * factors are the same Heun update applied to dW/dt = -dir*W and
 * dH/dt = +dir*H, so wall nodes and walls move identically to machine
 * precision. Afterwards the interfaces are resampled to uniform arc length
 * if advection has distorted the node spacing.
 */
export function stepHeun(
  state: SimState,
  p: SimParams,
  dt: number,
  s1: SolveOut,
  /** receives the corrector solve's evaluator, a warm start for the next step */
  warmOut?: { evalAt?: SolveOut['evalAt'] },
): SimState {
  const dir = dirOf(p.mode);
  const k1 = state.faces.map((f) => sampleVel(s1.evalAt, f.X, f.Y, dir));

  const advance = (factorW: number, factorH: number, comb: (fi: number, i: number) => [number, number]): SimState => {
    const next: SimState = {
      t: state.t + dt,
      halfW: state.halfW * factorW,
      halfH: state.halfH * factorH,
      faces: state.faces.map((f, fi) => {
        const X = new Float64Array(f.X.length);
        const Y = new Float64Array(f.Y.length);
        for (let i = 0; i < X.length; i++) {
          const [du, dv] = comb(fi, i);
          X[i] = f.X[i] + du;
          Y[i] = f.Y[i] + dv;
        }
        return { X, Y };
      }),
    };
    clamp(next);
    return next;
  };

  const euler = advance(1 - dir * dt, 1 + dir * dt, (fi, i) => [dt * k1[fi].u[i], dt * k1[fi].v[i]]);

  const s2 = solveState(euler, p, s1.evalAt);
  if (warmOut) warmOut.evalAt = s2.evalAt;
  const k2 = euler.faces.map((f) => sampleVel(s2.evalAt, f.X, f.Y, dir));

  const half = dt / 2;
  const next = advance(
    1 - dir * dt + (dt * dt) / 2,
    1 + dir * dt + (dt * dt) / 2,
    (fi, i) => [half * (k1[fi].u[i] + k2[fi].u[i]), half * (k1[fi].v[i] + k2[fi].v[i])],
  );

  // target node spacing follows the layer thickness e^(dir*t)
  const spacing0 = p.boxWidth / (p.nx - 1);
  resampleFaces(next, spacing0 * Math.exp(dir * next.t));
  return next;
}
