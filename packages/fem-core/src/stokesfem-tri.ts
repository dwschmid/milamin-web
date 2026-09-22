// Unstructured-mesh Stokes FEM: 7-node Crouzeix-Raviart-type triangles
// (quadratic velocity enriched by a cubic bubble, discontinuous linear
// pressure) — the MILAMIN element — on Triangle-generated meshes (trimesh.ts).
//
// The bubble is condensed at element level, so the global system holds only
// the 6 nodal velocities per triangle; reverse Cuthill-McKee ordering keeps
// the bandwidth small and the shared banded Cholesky (bandchol.ts) applies.
// Incompressibility: augmented-Lagrangian penalty + Powell-Hestenes, as in
// stokesfem.ts, with the bubble recovered element-by-element each iteration.
//
// Verified against the analytical circular inclusion and the rigid-polygon
// solutions in verify/check_femtri.ts.

import { TriMesh } from './trimesh';
import { bandFactor, bandSolve, rcmOrder } from './bandchol';
import { spcholFactor, spcholReady } from './spchol';

export interface StokesTriParams {
  mesh: TriMesh;
  /** viscosity by triangle region attribute */
  muOfAttr?: (attr: number) => number;
  /** per-element viscosity (overrides muOfAttr; for nonlinear iterations) */
  muPerElement?: Float64Array;
  /** Dirichlet velocity for a boundary marker, or null when unconstrained.
   *  A NaN component leaves that component free (free slip). */
  bc: (marker: number, x: number, y: number) => [number, number] | null;
  penalty?: number;
  phIterations?: number;
  /**
   * Linear-solver backend. 'banded' (default): pure-TS banded Cholesky on an
   * RCM ordering. 'sparse': CHOLMOD supernodal Cholesky + AMD in wasm —
   * requires initSpchol() to have resolved first.
   */
  backend?: 'banded' | 'sparse';
  /** Called as each solve phase starts (progress reporting for long runs). */
  onStage?: (stage: 'assemble' | 'factor' | 'ph') => void;
}

export interface StokesTriCore {
  nodes: number;
  dofs: number;
  elements: number;
  halfBandwidth: number;
  /** non-zeros in the Cholesky factor (sparse backend; 0 for banded) */
  nnzL: number;
  assembleMs: number;
  factorMs: number;
  phMs: number;
  divResidual: number;
  // mesh + solution data for the evaluator (all plain arrays)
  nodeX: Float64Array;
  nodeY: Float64Array;
  tri6: Int32Array;
  triMu: Float64Array;
  u: Float64Array; // nodal velocities, ORIGINAL node numbering
  ub: Float64Array; // bubble velocities, 2 per element
  elP: Float64Array;
  elCx: Float64Array;
  elCy: Float64Array;
  elH: Float64Array;
}

export interface StokesTriSolution extends StokesTriCore {
  evalAt(
    x: number,
    y: number,
  ): { u: number; v: number; p: number; tau: number; mu: number; eII: number; w: number } | null;
}

// 7-point degree-5 quadrature on the reference triangle (weights sum to 1)
const QW = [
  0.225,
  0.132394152788506, 0.132394152788506, 0.132394152788506,
  0.125939180544827, 0.125939180544827, 0.125939180544827,
];
const QA = 0.059715871789770;
const QB = 0.470142064105115;
const QC = 0.797426985353087;
const QD = 0.101286507323456;
const QL: Array<[number, number, number]> = [
  [1 / 3, 1 / 3, 1 / 3],
  [QA, QB, QB],
  [QB, QA, QB],
  [QB, QB, QA],
  [QC, QD, QD],
  [QD, QC, QD],
  [QD, QD, QC],
];

/**
 * Compress lower-triangle triplets into sorted, deduplicated CSC, applying
 * Dirichlet elimination on the way: entries coupling free and constrained
 * dofs move to the right-hand side, constrained rows/columns collapse to a
 * unit diagonal — identical to what the banded path does in-place.
 */
function buildCscLower(
  n: number,
  tN: number,
  tI: Int32Array,
  tJ: Int32Array,
  tV: Float64Array,
  isBC: Uint8Array,
  bcVal: Float64Array,
  rhsBase: Float64Array,
): { Ap: Int32Array; Ai: Int32Array; Ax: Float64Array } {
  // move free<->constrained couplings to the RHS; drop those entries
  for (let k = 0; k < tN; k++) {
    const i = tI[k];
    const j = tJ[k];
    if (isBC[i] && isBC[j]) continue; // dropped below, diag re-added as 1
    if (isBC[j]) rhsBase[i] -= tV[k] * bcVal[j];
    else if (isBC[i]) rhsBase[j] -= tV[k] * bcVal[i];
  }

  // count surviving entries per column (+1 unit diagonal per BC dof)
  const cnt = new Int32Array(n + 1);
  for (let k = 0; k < tN; k++) {
    if (isBC[tI[k]] || isBC[tJ[k]]) continue;
    cnt[tJ[k] + 1]++;
  }
  for (let d = 0; d < n; d++) if (isBC[d]) cnt[d + 1]++;
  for (let c = 0; c < n; c++) cnt[c + 1] += cnt[c];
  const Ap0 = cnt; // prefix sums; Ap0[c] = start of column c (with duplicates)
  const nnzDup = Ap0[n];
  const Ri = new Int32Array(nnzDup);
  const Rx = new Float64Array(nnzDup);
  const fill = Int32Array.from(Ap0.subarray(0, n));
  for (let k = 0; k < tN; k++) {
    const i = tI[k];
    const j = tJ[k];
    if (isBC[i] || isBC[j]) continue;
    const at = fill[j]++;
    Ri[at] = i;
    Rx[at] = tV[k];
  }
  for (let d = 0; d < n; d++) {
    if (!isBC[d]) continue;
    const at = fill[d]++;
    Ri[at] = d;
    Rx[at] = 1;
  }

  // per-column insertion sort by row, then merge duplicates
  const Ap = new Int32Array(n + 1);
  const Ai = new Int32Array(nnzDup);
  const Ax = new Float64Array(nnzDup);
  let out = 0;
  for (let c = 0; c < n; c++) {
    const lo = Ap0[c];
    const hi = fill[c];
    for (let a = lo + 1; a < hi; a++) {
      const ri = Ri[a];
      const rx = Rx[a];
      let b = a - 1;
      while (b >= lo && Ri[b] > ri) {
        Ri[b + 1] = Ri[b];
        Rx[b + 1] = Rx[b];
        b--;
      }
      Ri[b + 1] = ri;
      Rx[b + 1] = rx;
    }
    Ap[c] = out;
    for (let a = lo; a < hi; a++) {
      if (out > Ap[c] && Ai[out - 1] === Ri[a]) Ax[out - 1] += Rx[a];
      else {
        Ai[out] = Ri[a];
        Ax[out] = Rx[a];
        out++;
      }
    }
  }
  Ap[n] = out;
  return { Ap, Ai: Ai.subarray(0, out) as Int32Array, Ax: Ax.subarray(0, out) as Float64Array };
}

export function solveStokesTri(params: StokesTriParams): StokesTriSolution {
  const { mesh, muOfAttr, bc } = params;
  const penalty = params.penalty ?? 1e3;
  const phIterations = params.phIterations ?? 10;
  const { nNodes, nodeX, nodeY, tri6, triAttr, nTri, marker } = mesh;

  const backend = params.backend ?? 'banded';
  if (backend === 'sparse' && !spcholReady()) {
    throw new Error('backend "sparse" requires initSpchol() to have resolved');
  }
  params.onStage?.('assemble');
  const t0 = performance.now();

  // banded: RCM node ordering -> dof numbering (bandwidth). sparse: identity
  // (CHOLMOD applies AMD internally).
  const perm =
    backend === 'banded'
      ? rcmOrder(nNodes, tri6, 6)
      : Int32Array.from({ length: nNodes }, (_, i) => i);
  const dofOf = (nd: number, c: number) => 2 * perm[nd] + c;
  const n = 2 * nNodes;

  const triMu = new Float64Array(nTri);
  if (params.muPerElement) {
    if (params.muPerElement.length !== nTri) throw new Error('muPerElement length mismatch');
    triMu.set(params.muPerElement);
  } else if (muOfAttr) {
    for (let e = 0; e < nTri; e++) triMu[e] = muOfAttr(triAttr[e]);
  } else {
    throw new Error('provide muOfAttr or muPerElement');
  }

  let hbw = 0;
  if (backend === 'banded') {
    for (let e = 0; e < nTri; e++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let l = 0; l < 6; l++) {
        const p = perm[tri6[e * 6 + l]];
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      hbw = Math.max(hbw, 2 * hi + 1 - 2 * lo);
    }
  }
  const hb1 = hbw + 1;
  const band = backend === 'banded' ? new Float64Array(n * hb1) : new Float64Array(0);

  // sparse: lower-triangle triplets, deduplicated into CSC after assembly
  let tI = new Int32Array(backend === 'sparse' ? 1 << 20 : 0);
  let tJ = new Int32Array(tI.length);
  let tV = new Float64Array(tI.length);
  let tN = 0;

  // per-element storage for PH and evaluation
  const elQ = new Float64Array(nTri * 3 * 14);
  const elKinvM = new Float64Array(nTri * 9);
  const elKbbInv = new Float64Array(nTri * 4);
  const elKbc = new Float64Array(nTri * 2 * 12);
  const elP = new Float64Array(nTri * 3);
  const ub = new Float64Array(nTri * 2);
  const elCx = new Float64Array(nTri);
  const elCy = new Float64Array(nTri);
  const elH = new Float64Array(nTri);

  const K = new Float64Array(14 * 14);
  const Q = new Float64Array(3 * 14);
  const M = new Float64Array(9);
  const gN = new Float64Array(14); // dN/dx then dN/dy interleaved use below
  const gx = new Float64Array(7);
  const gy = new Float64Array(7);
  const NN = new Float64Array(7);

  const addSym =
    backend === 'banded'
      ? (gi: number, gj: number, v: number) => {
          if (gi >= gj) band[gi * hb1 + (gi - gj)] += v;
        }
      : (gi: number, gj: number, v: number) => {
          if (gi < gj) return;
          if (tN === tI.length) {
            const cap = tI.length * 2;
            const nI = new Int32Array(cap);
            nI.set(tI);
            tI = nI;
            const nJ = new Int32Array(cap);
            nJ.set(tJ);
            tJ = nJ;
            const nV = new Float64Array(cap);
            nV.set(tV);
            tV = nV;
          }
          tI[tN] = gi;
          tJ[tN] = gj;
          tV[tN] = v;
          tN++;
        };

  for (let e = 0; e < nTri; e++) {
    K.fill(0);
    Q.fill(0);
    M.fill(0);
    const mue = triMu[e];
    const kap = penalty * mue;
    const n0 = tri6[e * 6], n1 = tri6[e * 6 + 1], n2 = tri6[e * 6 + 2];
    const x0 = nodeX[n0], y0 = nodeY[n0];
    const x1 = nodeX[n1], y1 = nodeY[n1];
    const x2 = nodeX[n2], y2 = nodeY[n2];
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const area = det / 2;
    // gradients of the barycentric coordinates (constant, affine element)
    const g1x = (y2 - y0) / det, g1y = -(x2 - x0) / det;
    const g2x = -(y1 - y0) / det, g2y = (x1 - x0) / det;
    const g0x = -g1x - g2x, g0y = -g1y - g2y;

    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const hE = Math.sqrt(Math.abs(area));
    elCx[e] = cx;
    elCy[e] = cy;
    elH[e] = hE;

    for (let q = 0; q < 7; q++) {
      const [L0, L1, L2] = QL[q];
      const w = QW[q] * area;
      NN[0] = L0 * (2 * L0 - 1);
      NN[1] = L1 * (2 * L1 - 1);
      NN[2] = L2 * (2 * L2 - 1);
      NN[3] = 4 * L1 * L2;
      NN[4] = 4 * L2 * L0;
      NN[5] = 4 * L0 * L1;
      NN[6] = 27 * L0 * L1 * L2;
      gx[0] = (4 * L0 - 1) * g0x;
      gy[0] = (4 * L0 - 1) * g0y;
      gx[1] = (4 * L1 - 1) * g1x;
      gy[1] = (4 * L1 - 1) * g1y;
      gx[2] = (4 * L2 - 1) * g2x;
      gy[2] = (4 * L2 - 1) * g2y;
      gx[3] = 4 * (L2 * g1x + L1 * g2x);
      gy[3] = 4 * (L2 * g1y + L1 * g2y);
      gx[4] = 4 * (L0 * g2x + L2 * g0x);
      gy[4] = 4 * (L0 * g2y + L2 * g0y);
      gx[5] = 4 * (L1 * g0x + L0 * g1x);
      gy[5] = 4 * (L1 * g0y + L0 * g1y);
      gx[6] = 27 * (L1 * L2 * g0x + L0 * L2 * g1x + L0 * L1 * g2x);
      gy[6] = 27 * (L1 * L2 * g0y + L0 * L2 * g1y + L0 * L1 * g2y);

      const xq = L0 * x0 + L1 * x1 + L2 * x2;
      const yq = L0 * y0 + L1 * y1 + L2 * y2;
      const pi1 = (xq - cx) / hE;
      const pi2 = (yq - cy) / hE;

      for (let a = 0; a < 7; a++) {
        for (let b = 0; b < 7; b++) {
          K[(2 * a) * 14 + 2 * b] += w * mue * (2 * gx[a] * gx[b] + gy[a] * gy[b]);
          K[(2 * a) * 14 + 2 * b + 1] += w * mue * (gy[a] * gx[b]);
          K[(2 * a + 1) * 14 + 2 * b] += w * mue * (gx[a] * gy[b]);
          K[(2 * a + 1) * 14 + 2 * b + 1] += w * mue * (2 * gy[a] * gy[b] + gx[a] * gx[b]);
        }
        Q[0 * 14 + 2 * a] += w * gx[a];
        Q[0 * 14 + 2 * a + 1] += w * gy[a];
        Q[1 * 14 + 2 * a] += w * pi1 * gx[a];
        Q[1 * 14 + 2 * a + 1] += w * pi1 * gy[a];
        Q[2 * 14 + 2 * a] += w * pi2 * gx[a];
        Q[2 * 14 + 2 * a + 1] += w * pi2 * gy[a];
      }
      M[0] += w;
      M[1] += w * pi1;
      M[2] += w * pi2;
      M[4] += w * pi1 * pi1;
      M[5] += w * pi1 * pi2;
      M[8] += w * pi2 * pi2;
    }
    M[3] = M[1];
    M[6] = M[2];
    M[7] = M[5];
    const iM = invert3(M);
    for (let a = 0; a < 9; a++) elKinvM[e * 9 + a] = kap * iM[a];
    for (let a = 0; a < 3 * 14; a++) elQ[e * 42 + a] = Q[a];

    // K += kappa Q^T M^{-1} Q (full 14x14)
    for (let i = 0; i < 14; i++) {
      for (let j = 0; j < 14; j++) {
        let s = 0;
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) s += Q[a * 14 + i] * iM[a * 3 + b] * Q[b * 14 + j];
        }
        K[i * 14 + j] += kap * s;
      }
    }

    // condense the bubble dofs (12, 13)
    const kbb00 = K[12 * 14 + 12], kbb01 = K[12 * 14 + 13], kbb11 = K[13 * 14 + 13];
    const dbb = kbb00 * kbb11 - kbb01 * kbb01;
    const i00 = kbb11 / dbb, i01 = -kbb01 / dbb, i11 = kbb00 / dbb;
    elKbbInv[e * 4] = i00;
    elKbbInv[e * 4 + 1] = i01;
    elKbbInv[e * 4 + 2] = i01;
    elKbbInv[e * 4 + 3] = i11;
    for (let j = 0; j < 12; j++) {
      elKbc[e * 24 + j] = K[12 * 14 + j];
      elKbc[e * 24 + 12 + j] = K[13 * 14 + j];
    }
    // Kcond = Kcc - Kcb Kbb^{-1} Kbc
    for (let i = 0; i < 12; i++) {
      const kb0 = K[i * 14 + 12];
      const kb1 = K[i * 14 + 13];
      const t0i = kb0 * i00 + kb1 * i01;
      const t1i = kb0 * i01 + kb1 * i11;
      for (let j = 0; j < 12; j++) {
        K[i * 14 + j] -= t0i * K[12 * 14 + j] + t1i * K[13 * 14 + j];
      }
    }

    // scatter (nodal dofs only)
    for (let a = 0; a < 6; a++) {
      const ga = tri6[e * 6 + a];
      for (let b = 0; b < 6; b++) {
        const gb = tri6[e * 6 + b];
        addSym(dofOf(ga, 0), dofOf(gb, 0), K[(2 * a) * 14 + 2 * b]);
        addSym(dofOf(ga, 0), dofOf(gb, 1), K[(2 * a) * 14 + 2 * b + 1]);
        addSym(dofOf(ga, 1), dofOf(gb, 0), K[(2 * a + 1) * 14 + 2 * b]);
        addSym(dofOf(ga, 1), dofOf(gb, 1), K[(2 * a + 1) * 14 + 2 * b + 1]);
      }
    }
  }

  // Dirichlet
  const rhsBase = new Float64Array(n);
  const bcVal = new Float64Array(n);
  const isBC = new Uint8Array(n);
  for (let nd = 0; nd < nNodes; nd++) {
    if (!marker[nd]) continue;
    const g = bc(marker[nd], nodeX[nd], nodeY[nd]);
    if (!g) continue;
    for (const c of [0, 1] as const) {
      if (!Number.isFinite(g[c])) continue;
      const d = dofOf(nd, c);
      bcVal[d] = g[c];
      isBC[d] = 1;
    }
  }
  let csc: { Ap: Int32Array; Ai: Int32Array; Ax: Float64Array } | null = null;
  if (backend === 'banded') {
    for (let d = 0; d < n; d++) {
      if (!isBC[d]) continue;
      const g = bcVal[d];
      for (let i = d + 1; i <= Math.min(d + hbw, n - 1); i++) {
        const k = i * hb1 + (i - d);
        if (band[k] !== 0 && !isBC[i]) rhsBase[i] -= band[k] * g;
        band[k] = 0;
      }
      for (let j = Math.max(0, d - hbw); j < d; j++) {
        const k = d * hb1 + (d - j);
        if (band[k] !== 0 && !isBC[j]) rhsBase[j] -= band[k] * g;
        band[k] = 0;
      }
      band[d * hb1] = 1;
    }
  } else {
    csc = buildCscLower(n, tN, tI, tJ, tV, isBC, bcVal, rhsBase);
  }
  const assembleMs = performance.now() - t0;

  params.onStage?.('factor');
  const t1 = performance.now();
  let nnzL = 0;
  let solve: (rhs: Float64Array) => Float64Array;
  let freeFactor = () => {};
  if (backend === 'banded') {
    bandFactor(band, n, hbw);
    solve = (rhs) => bandSolve(band, n, hbw, rhs);
  } else {
    const f = spcholFactor(n, csc!.Ap, csc!.Ai, csc!.Ax);
    nnzL = f.nnzL();
    freeFactor = () => f.free();
    solve = (rhs) => {
      const x = rhs.slice();
      f.solveInPlace(x);
      return x;
    };
  }
  const factorMs = performance.now() - t1;

  // Powell-Hestenes with element-level bubble recovery
  params.onStage?.('ph');
  const t2 = performance.now();
  let uPerm: Float64Array = new Float64Array(n);
  let divResidual = Infinity;
  const rhs = new Float64Array(n);
  const uc = new Float64Array(12);
  for (let it = 0; it < phIterations; it++) {
    rhs.set(rhsBase);
    for (let e = 0; e < nTri; e++) {
      // f_c = Qc^T p - Kcb Kbb^{-1} (Qb^T p)
      const p0 = elP[e * 3], p1 = elP[e * 3 + 1], p2 = elP[e * 3 + 2];
      const fb0 = elQ[e * 42 + 12] * p0 + elQ[e * 42 + 14 + 12] * p1 + elQ[e * 42 + 28 + 12] * p2;
      const fb1 = elQ[e * 42 + 13] * p0 + elQ[e * 42 + 14 + 13] * p1 + elQ[e * 42 + 28 + 13] * p2;
      const s0 = elKbbInv[e * 4] * fb0 + elKbbInv[e * 4 + 1] * fb1;
      const s1 = elKbbInv[e * 4 + 2] * fb0 + elKbbInv[e * 4 + 3] * fb1;
      for (let a = 0; a < 6; a++) {
        const nd = tri6[e * 6 + a];
        for (const c of [0, 1] as const) {
          const d = dofOf(nd, c);
          if (isBC[d]) continue;
          const col = 2 * a + c;
          const fc =
            elQ[e * 42 + col] * p0 + elQ[e * 42 + 14 + col] * p1 + elQ[e * 42 + 28 + col] * p2;
          rhs[d] += fc - (elKbc[e * 24 + col] * s0 + elKbc[e * 24 + 12 + col] * s1);
        }
      }
    }
    for (let d = 0; d < n; d++) if (isBC[d]) rhs[d] = bcVal[d];
    uPerm = solve(rhs);

    // bubble recovery + pressure update
    let dpMax = 0;
    let pMax = 0;
    for (let e = 0; e < nTri; e++) {
      const p0 = elP[e * 3], p1 = elP[e * 3 + 1], p2 = elP[e * 3 + 2];
      for (let a = 0; a < 6; a++) {
        const nd = tri6[e * 6 + a];
        uc[2 * a] = uPerm[dofOf(nd, 0)];
        uc[2 * a + 1] = uPerm[dofOf(nd, 1)];
      }
      const fb0 = elQ[e * 42 + 12] * p0 + elQ[e * 42 + 14 + 12] * p1 + elQ[e * 42 + 28 + 12] * p2;
      const fb1 = elQ[e * 42 + 13] * p0 + elQ[e * 42 + 14 + 13] * p1 + elQ[e * 42 + 28 + 13] * p2;
      let kbc0 = 0;
      let kbc1 = 0;
      for (let j = 0; j < 12; j++) {
        kbc0 += elKbc[e * 24 + j] * uc[j];
        kbc1 += elKbc[e * 24 + 12 + j] * uc[j];
      }
      const b0 = elKbbInv[e * 4] * (fb0 - kbc0) + elKbbInv[e * 4 + 1] * (fb1 - kbc1);
      const b1 = elKbbInv[e * 4 + 2] * (fb0 - kbc0) + elKbbInv[e * 4 + 3] * (fb1 - kbc1);
      ub[e * 2] = b0;
      ub[e * 2 + 1] = b1;

      const qu = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        let s = 0;
        for (let j = 0; j < 12; j++) s += elQ[e * 42 + a * 14 + j] * uc[j];
        s += elQ[e * 42 + a * 14 + 12] * b0 + elQ[e * 42 + a * 14 + 13] * b1;
        qu[a] = s;
      }
      // the three coefficients are comparable: the slopes are scaled by the
      // element size, so all of them enter the stopping measure
      for (let a = 0; a < 3; a++) {
        let s = 0;
        for (let b = 0; b < 3; b++) s += elKinvM[e * 9 + a * 3 + b] * qu[b];
        elP[e * 3 + a] -= s;
        dpMax = Math.max(dpMax, Math.abs(s));
        pMax = Math.max(pMax, Math.abs(elP[e * 3 + a]));
      }
    }
    divResidual = dpMax / Math.max(pMax, 1e-300);
    if (divResidual < 1e-11) break;
  }
  const phMs = performance.now() - t2;
  freeFactor();

  // un-permute nodal velocities to the original node numbering
  const u = new Float64Array(n);
  for (let nd = 0; nd < nNodes; nd++) {
    u[2 * nd] = uPerm[2 * perm[nd]];
    u[2 * nd + 1] = uPerm[2 * perm[nd] + 1];
  }

  const core: StokesTriCore = {
    nodes: nNodes,
    dofs: n,
    elements: nTri,
    halfBandwidth: hbw,
    nnzL,
    assembleMs,
    factorMs,
    phMs,
    divResidual,
    nodeX,
    nodeY,
    tri6,
    triMu,
    u,
    ub,
    elP,
    elCx,
    elCy,
    elH,
  };
  return { ...core, evalAt: triEvaluator(core) };
}

/** Point evaluator with a uniform background bin grid for element lookup. */
export function triEvaluator(core: StokesTriCore): StokesTriSolution['evalAt'] {
  const { nodeX, nodeY, tri6, triMu, u, ub, elP, elCx, elCy, elH } = core;
  const nTri = core.elements;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < core.nodes; i++) {
    minX = Math.min(minX, nodeX[i]);
    maxX = Math.max(maxX, nodeX[i]);
    minY = Math.min(minY, nodeY[i]);
    maxY = Math.max(maxY, nodeY[i]);
  }
  const NB = 96;
  const bx = (maxX - minX) / NB;
  const by = (maxY - minY) / NB;
  const bins: number[][] = Array.from({ length: NB * NB }, () => []);
  for (let e = 0; e < nTri; e++) {
    const c0 = tri6[e * 6], c1 = tri6[e * 6 + 1], c2 = tri6[e * 6 + 2];
    const exMin = Math.min(nodeX[c0], nodeX[c1], nodeX[c2]);
    const exMax = Math.max(nodeX[c0], nodeX[c1], nodeX[c2]);
    const eyMin = Math.min(nodeY[c0], nodeY[c1], nodeY[c2]);
    const eyMax = Math.max(nodeY[c0], nodeY[c1], nodeY[c2]);
    const i0 = Math.max(0, Math.floor((exMin - minX) / bx));
    const i1 = Math.min(NB - 1, Math.floor((exMax - minX) / bx));
    const j0 = Math.max(0, Math.floor((eyMin - minY) / by));
    const j1 = Math.min(NB - 1, Math.floor((eyMax - minY) / by));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bins[j * NB + i].push(e);
  }

  return function evalAt(x: number, y: number) {
    if (x < minX || x > maxX || y < minY || y > maxY) return null;
    const bi = Math.min(NB - 1, Math.max(0, Math.floor((x - minX) / bx)));
    const bj = Math.min(NB - 1, Math.max(0, Math.floor((y - minY) / by)));
    for (const e of bins[bj * NB + bi]) {
      const c0 = tri6[e * 6], c1 = tri6[e * 6 + 1], c2 = tri6[e * 6 + 2];
      const x0 = nodeX[c0], y0 = nodeY[c0];
      const det = (nodeX[c1] - x0) * (nodeY[c2] - y0) - (nodeX[c2] - x0) * (nodeY[c1] - y0);
      const L1 = ((x - x0) * (nodeY[c2] - y0) - (y - y0) * (nodeX[c2] - x0)) / det;
      const L2 = ((y - y0) * (nodeX[c1] - x0) - (x - x0) * (nodeY[c1] - y0)) / det;
      const L0 = 1 - L1 - L2;
      const tol = -1e-9;
      if (L0 < tol || L1 < tol || L2 < tol) continue;

      const g1x = (nodeY[c2] - y0) / det, g1y = -(nodeX[c2] - x0) / det;
      const g2x = -(nodeY[c1] - y0) / det, g2y = (nodeX[c1] - x0) / det;
      const g0x = -g1x - g2x, g0y = -g1y - g2y;
      const N = [
        L0 * (2 * L0 - 1),
        L1 * (2 * L1 - 1),
        L2 * (2 * L2 - 1),
        4 * L1 * L2,
        4 * L2 * L0,
        4 * L0 * L1,
        27 * L0 * L1 * L2,
      ];
      const gxA = [
        (4 * L0 - 1) * g0x,
        (4 * L1 - 1) * g1x,
        (4 * L2 - 1) * g2x,
        4 * (L2 * g1x + L1 * g2x),
        4 * (L0 * g2x + L2 * g0x),
        4 * (L1 * g0x + L0 * g1x),
        27 * (L1 * L2 * g0x + L0 * L2 * g1x + L0 * L1 * g2x),
      ];
      const gyA = [
        (4 * L0 - 1) * g0y,
        (4 * L1 - 1) * g1y,
        (4 * L2 - 1) * g2y,
        4 * (L2 * g1y + L1 * g2y),
        4 * (L0 * g2y + L2 * g0y),
        4 * (L1 * g0y + L0 * g1y),
        27 * (L1 * L2 * g0y + L0 * L2 * g1y + L0 * L1 * g2y),
      ];
      let uu = 0, vv = 0, exx = 0, eyy = 0, exy = 0, rot = 0;
      for (let a = 0; a < 7; a++) {
        const ua = a < 6 ? u[2 * tri6[e * 6 + a]] : ub[e * 2];
        const va = a < 6 ? u[2 * tri6[e * 6 + a] + 1] : ub[e * 2 + 1];
        uu += N[a] * ua;
        vv += N[a] * va;
        exx += gxA[a] * ua;
        eyy += gyA[a] * va;
        exy += 0.5 * (gyA[a] * ua + gxA[a] * va);
        rot += 0.5 * (gxA[a] * va - gyA[a] * ua);
      }
      const p =
        elP[e * 3] + (elP[e * 3 + 1] * (x - elCx[e])) / elH[e] + (elP[e * 3 + 2] * (y - elCy[e])) / elH[e];
      const eII = Math.sqrt(((exx - eyy) / 2) ** 2 + exy ** 2);
      const tau = 2 * triMu[e] * eII;
      return { u: uu, v: vv, p, tau, mu: triMu[e], eII, w: rot };
    }
    return null;
  };
}

/** Fields of the discrete solution at one quadrature point. */
export interface TriQuadSample {
  x: number;
  y: number;
  /** quadrature weight (element area times rule weight) */
  w: number;
  u: number;
  v: number;
  p: number;
  tau: number;
  mu: number;
}

/**
 * Visit the solution at the 7-point (degree-5) quadrature rule of every
 * element, the same rule the assembly integrates with. This is what proper
 * L2 norms over the mesh are built from: sum w * f(sample) over all calls.
 */
export function integrateTri(core: StokesTriCore, fn: (s: TriQuadSample) => void): void {
  const { nodeX, nodeY, tri6, triMu, u, ub, elP, elCx, elCy, elH } = core;
  const N = new Float64Array(7);
  const gx = new Float64Array(7);
  const gy = new Float64Array(7);
  const s: TriQuadSample = { x: 0, y: 0, w: 0, u: 0, v: 0, p: 0, tau: 0, mu: 0 };
  for (let e = 0; e < core.elements; e++) {
    const c0 = tri6[e * 6], c1 = tri6[e * 6 + 1], c2 = tri6[e * 6 + 2];
    const x0 = nodeX[c0], y0 = nodeY[c0];
    const x1 = nodeX[c1], y1 = nodeY[c1];
    const x2 = nodeX[c2], y2 = nodeY[c2];
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const area = Math.abs(det) / 2;
    const g1x = (y2 - y0) / det, g1y = -(x2 - x0) / det;
    const g2x = -(y1 - y0) / det, g2y = (x1 - x0) / det;
    const g0x = -g1x - g2x, g0y = -g1y - g2y;
    for (let q = 0; q < 7; q++) {
      const [L0, L1, L2] = QL[q];
      N[0] = L0 * (2 * L0 - 1);
      N[1] = L1 * (2 * L1 - 1);
      N[2] = L2 * (2 * L2 - 1);
      N[3] = 4 * L1 * L2;
      N[4] = 4 * L2 * L0;
      N[5] = 4 * L0 * L1;
      N[6] = 27 * L0 * L1 * L2;
      gx[0] = (4 * L0 - 1) * g0x;
      gy[0] = (4 * L0 - 1) * g0y;
      gx[1] = (4 * L1 - 1) * g1x;
      gy[1] = (4 * L1 - 1) * g1y;
      gx[2] = (4 * L2 - 1) * g2x;
      gy[2] = (4 * L2 - 1) * g2y;
      gx[3] = 4 * (L2 * g1x + L1 * g2x);
      gy[3] = 4 * (L2 * g1y + L1 * g2y);
      gx[4] = 4 * (L0 * g2x + L2 * g0x);
      gy[4] = 4 * (L0 * g2y + L2 * g0y);
      gx[5] = 4 * (L1 * g0x + L0 * g1x);
      gy[5] = 4 * (L1 * g0y + L0 * g1y);
      gx[6] = 27 * (L1 * L2 * g0x + L0 * L2 * g1x + L0 * L1 * g2x);
      gy[6] = 27 * (L1 * L2 * g0y + L0 * L2 * g1y + L0 * L1 * g2y);
      let uu = 0, vv = 0, exx = 0, eyy = 0, exy = 0;
      for (let a = 0; a < 7; a++) {
        const ua = a < 6 ? u[2 * tri6[e * 6 + a]] : ub[e * 2];
        const va = a < 6 ? u[2 * tri6[e * 6 + a] + 1] : ub[e * 2 + 1];
        uu += N[a] * ua;
        vv += N[a] * va;
        exx += gx[a] * ua;
        eyy += gy[a] * va;
        exy += 0.5 * (gy[a] * ua + gx[a] * va);
      }
      const xq = L0 * x0 + L1 * x1 + L2 * x2;
      const yq = L0 * y0 + L1 * y1 + L2 * y2;
      s.x = xq;
      s.y = yq;
      s.w = QW[q] * area;
      s.u = uu;
      s.v = vv;
      s.p = elP[e * 3] + (elP[e * 3 + 1] * (xq - elCx[e])) / elH[e] + (elP[e * 3 + 2] * (yq - elCy[e])) / elH[e];
      s.mu = triMu[e];
      s.tau = 2 * triMu[e] * Math.sqrt(((exx - eyy) / 2) ** 2 + exy ** 2);
      fn(s);
    }
  }
}

function invert3(M: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const out = new Float64Array(9);
  out[0] = A / det;
  out[1] = -(b * i - c * h) / det;
  out[2] = (b * f - c * e) / det;
  out[3] = B / det;
  out[4] = (a * i - c * g) / det;
  out[5] = -(a * f - c * d) / det;
  out[6] = C / det;
  out[7] = -(a * h - b * g) / det;
  out[8] = (a * e - b * d) / det;
  return out;
}
