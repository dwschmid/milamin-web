// Browser FEM for 2D incompressible Stokes flow with variable viscosity —
// a miniature MILAMIN (Dabrowski, Krotkiewski & Schmid 2008) in TypeScript.
//
// Discretization: Q2-P1 elements (biquadratic velocity, discontinuous linear
// pressure — the stable geodynamics standard, pressure jumps across material
// interfaces are represented exactly) on a polar-structured annular mesh
// r in [rIn, rOut] with one node ring placed exactly on the material
// interface. Incompressibility by the MILAMIN recipe: an augmented-Lagrangian
// penalty (kappa = penalty * mu_e per element) condensed into the velocity
// system, then Powell-Hestenes iterations — each one a cheap back-substitution
// against the single Cholesky factorization.
//
// Solver: banded Cholesky (LL^T) on typed arrays; nodes are numbered ring by
// ring so the half-bandwidth is O(nTheta). Dirichlet velocities on the inner
// and outer boundary rings come from a caller-supplied callback (the fem page
// uses the exact analytical solution, making the FEM error directly
// measurable).
//
// Verified against the closed-form circular-inclusion solution in
// verify/check_fem.ts (error magnitude and mesh-refinement decrease).

export interface StokesFemParams {
  /** sectors around the annulus */
  nTheta: number;
  /** element rings inside / outside the interface */
  nrIn: number;
  nrOut: number;
  rIn: number;
  rInterface: number;
  rOut: number;
  /** viscosity, evaluated at element centroids */
  mu: (x: number, y: number) => number;
  /** Dirichlet velocity on the inner and outer boundary rings */
  bcVel: (x: number, y: number) => [number, number];
  /** kappa_e = penalty * mu_e */
  penalty?: number;
  phIterations?: number;
}

/**
 * Plain-data result of a solve: nothing but numbers and typed arrays, so it
 * can be posted from a Web Worker (structured clone / transfer) and turned
 * back into an evaluator with femEvaluator().
 */
export interface StokesFemCore {
  nodes: number;
  dofs: number;
  halfBandwidth: number;
  assembleMs: number;
  factorMs: number;
  phMs: number;
  /** relative incompressibility residual after the last PH iteration */
  divResidual: number;
  nTheta: number;
  nr: number;
  rad: Float64Array;
  conn: Int32Array;
  nodeX: Float64Array;
  nodeY: Float64Array;
  u: Float64Array;
  elP: Float64Array;
  elCx: Float64Array;
  elCy: Float64Array;
  elH: Float64Array;
  elMu: Float64Array;
}

export interface StokesFemSolution extends StokesFemCore {
  /** fields at a point; null outside the annulus */
  evalAt(x: number, y: number): { u: number; v: number; p: number; tau: number; mu: number } | null;
}

const G3 = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const W3 = [5 / 9, 8 / 9, 5 / 9];

/** 1D quadratic Lagrange basis on {-1, 0, 1} and its derivative. */
function lag(t: number): [number[], number[]] {
  return [
    [(t * (t - 1)) / 2, 1 - t * t, (t * (t + 1)) / 2],
    [t - 0.5, -2 * t, t + 0.5],
  ];
}

export function solveStokesFem(params: StokesFemParams): StokesFemSolution {
  const { nTheta, nrIn, nrOut, rIn, rInterface, rOut, mu, bcVel } = params;
  const penalty = params.penalty ?? 1e3;
  const phIterations = params.phIterations ?? 10;

  // --- mesh ---------------------------------------------------------------
  const nr = nrIn + nrOut;
  const rad = new Float64Array(nr + 1);
  for (let i = 0; i <= nrIn; i++) rad[i] = rIn + ((rInterface - rIn) * i) / nrIn;
  for (let i = 1; i <= nrOut; i++) rad[nrIn + i] = rInterface + ((rOut - rInterface) * i) / nrOut;

  const nodeRings = 2 * nr + 1;
  const perRing = 2 * nTheta;
  const nNodes = nodeRings * perRing;
  const n = 2 * nNodes;

  const nodeR = new Float64Array(nodeRings);
  for (let i = 0; i < nr; i++) {
    nodeR[2 * i] = rad[i];
    nodeR[2 * i + 1] = (rad[i] + rad[i + 1]) / 2;
  }
  nodeR[2 * nr] = rad[nr];
  const dTheta = (2 * Math.PI) / nTheta;

  // "Fold" ordering around each ring: physical theta index j is stored at
  // position 2j (first half) or 2(perRing - j) - 1 (second half), so the
  // periodic wrap neighbours j = 0 and j = perRing - 1 sit next to each other
  // in memory. This keeps the matrix half-bandwidth at ~2 node rings instead
  // of a full ring (the factorization cost scales with bandwidth squared).
  const fold = (j: number) => (2 * j < perRing ? 2 * j : 2 * (perRing - j) - 1);
  const nid = (ir: number, j: number) => ir * perRing + fold(j);

  const nodeX = new Float64Array(nNodes);
  const nodeY = new Float64Array(nNodes);
  for (let ir = 0; ir < nodeRings; ir++) {
    for (let j = 0; j < perRing; j++) {
      const t = (j * dTheta) / 2;
      nodeX[nid(ir, j)] = nodeR[ir] * Math.cos(t);
      nodeY[nid(ir, j)] = nodeR[ir] * Math.sin(t);
    }
  }

  const nEl = nr * nTheta;
  // local node l = b*3 + a: a = radial offset (xi), b = angular offset (eta)
  const conn = new Int32Array(nEl * 9);
  const elMu = new Float64Array(nEl);
  for (let i = 0; i < nr; i++) {
    for (let js = 0; js < nTheta; js++) {
      const e = i * nTheta + js;
      for (let b = 0; b < 3; b++) {
        for (let a = 0; a < 3; a++) {
          const ir = 2 * i + a;
          const j = (2 * js + b) % perRing;
          conn[e * 9 + b * 3 + a] = nid(ir, j);
        }
      }
      const rc = (rad[i] + rad[i + 1]) / 2;
      const tc = (js + 0.5) * dTheta;
      elMu[e] = mu(rc * Math.cos(tc), rc * Math.sin(tc));
    }
  }

  // --- assembly -----------------------------------------------------------
  const t0 = performance.now();

  // half-bandwidth from connectivity
  let hbw = 0;
  for (let e = 0; e < nEl; e++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let l = 0; l < 9; l++) {
      const nd = conn[e * 9 + l];
      if (nd < lo) lo = nd;
      if (nd > hi) hi = nd;
    }
    hbw = Math.max(hbw, 2 * hi + 1 - 2 * lo);
  }
  const hb1 = hbw + 1;
  const band = new Float64Array(n * hb1); // lower: A[i,j] at i*hb1 + (i-j)

  // per-element data kept for the PH updates and pressure evaluation
  const elQ = new Float64Array(nEl * 3 * 18); // divergence coupling
  const elKinvM = new Float64Array(nEl * 9); // kappa_e * M_e^{-1}
  const elP = new Float64Array(nEl * 3); // pressure coefficients
  const elCx = new Float64Array(nEl);
  const elCy = new Float64Array(nEl);
  const elH = new Float64Array(nEl); // pressure-basis length scale

  const Ke = new Float64Array(18 * 18);
  const Ae = new Float64Array(18 * 18);
  const Qe = new Float64Array(3 * 18);
  const Me = new Float64Array(9);
  const dNdx = new Float64Array(9);
  const dNdy = new Float64Array(9);
  const NN = new Float64Array(9);

  const addSym = (gi: number, gj: number, v: number) => {
    if (gi >= gj) band[gi * hb1 + (gi - gj)] += v;
  };

  for (let e = 0; e < nEl; e++) {
    Ae.fill(0);
    Qe.fill(0);
    Me.fill(0);
    const mue = elMu[e];
    const kap = penalty * mue;

    // centroid and length scale for the (unmapped) P1 pressure basis
    let cx = 0;
    let cy = 0;
    for (let l = 0; l < 9; l++) {
      cx += nodeX[conn[e * 9 + l]] / 9;
      cy += nodeY[conn[e * 9 + l]] / 9;
    }
    const i0 = conn[e * 9 + 0];
    const i2 = conn[e * 9 + 2];
    const hE = Math.max(1e-9, Math.hypot(nodeX[i2] - nodeX[i0], nodeY[i2] - nodeY[i0]));
    elCx[e] = cx;
    elCy[e] = cy;
    elH[e] = hE;

    for (let q2 = 0; q2 < 3; q2++) {
      for (let q1 = 0; q1 < 3; q1++) {
        const xi = G3[q1];
        const eta = G3[q2];
        const [Lx, dLx] = lag(xi);
        const [Ly, dLy] = lag(eta);
        let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
        let xq = 0, yq = 0;
        for (let b = 0; b < 3; b++) {
          for (let a = 0; a < 3; a++) {
            const l = b * 3 + a;
            const nd = conn[e * 9 + l];
            const Nl = Lx[a] * Ly[b];
            const dXi = dLx[a] * Ly[b];
            const dEta = Lx[a] * dLy[b];
            NN[l] = Nl;
            J11 += dXi * nodeX[nd];
            J12 += dXi * nodeY[nd];
            J21 += dEta * nodeX[nd];
            J22 += dEta * nodeY[nd];
            xq += Nl * nodeX[nd];
            yq += Nl * nodeY[nd];
            dNdx[l] = dXi; // reused below after inverse map
            dNdy[l] = dEta;
          }
        }
        const det = J11 * J22 - J12 * J21;
        const w = W3[q1] * W3[q2] * det;
        for (let l = 0; l < 9; l++) {
          const dXi = dNdx[l];
          const dEta = dNdy[l];
          dNdx[l] = (J22 * dXi - J12 * dEta) / det;
          dNdy[l] = (-J21 * dXi + J11 * dEta) / det;
        }
        const pi1 = (xq - cx) / hE;
        const pi2 = (yq - cy) / hE;

        for (let l1 = 0; l1 < 9; l1++) {
          const dx1 = dNdx[l1];
          const dy1 = dNdy[l1];
          for (let l2 = 0; l2 < 9; l2++) {
            const dx2 = dNdx[l2];
            const dy2 = dNdy[l2];
            Ae[(2 * l1) * 18 + 2 * l2] += w * mue * (2 * dx1 * dx2 + dy1 * dy2);
            Ae[(2 * l1) * 18 + 2 * l2 + 1] += w * mue * (dy1 * dx2);
            Ae[(2 * l1 + 1) * 18 + 2 * l2] += w * mue * (dx1 * dy2);
            Ae[(2 * l1 + 1) * 18 + 2 * l2 + 1] += w * mue * (2 * dy1 * dy2 + dx1 * dx2);
          }
          Qe[0 * 18 + 2 * l1] += w * dx1;
          Qe[0 * 18 + 2 * l1 + 1] += w * dy1;
          Qe[1 * 18 + 2 * l1] += w * pi1 * dx1;
          Qe[1 * 18 + 2 * l1 + 1] += w * pi1 * dy1;
          Qe[2 * 18 + 2 * l1] += w * pi2 * dx1;
          Qe[2 * 18 + 2 * l1 + 1] += w * pi2 * dy1;
        }
        Me[0] += w;
        Me[1] += w * pi1;
        Me[2] += w * pi2;
        Me[4] += w * pi1 * pi1;
        Me[5] += w * pi1 * pi2;
        Me[8] += w * pi2 * pi2;
      }
    }
    Me[3] = Me[1];
    Me[6] = Me[2];
    Me[7] = Me[5];

    // invert the 3x3 pressure mass matrix
    const iM = invert3(Me);
    for (let a = 0; a < 9; a++) elKinvM[e * 9 + a] = kap * iM[a];
    for (let a = 0; a < 3 * 18; a++) elQ[e * 54 + a] = Qe[a];

    // K_e = A_e + kappa Q^T M^{-1} Q
    Ke.set(Ae);
    for (let i = 0; i < 18; i++) {
      for (let j = 0; j < 18; j++) {
        let s = 0;
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            s += Qe[a * 18 + i] * iM[a * 3 + b] * Qe[b * 18 + j];
          }
        }
        Ke[i * 18 + j] += kap * s;
      }
    }

    // scatter into the band (lower triangle)
    for (let l1 = 0; l1 < 9; l1++) {
      const g1 = 2 * conn[e * 9 + l1];
      for (let l2 = 0; l2 < 9; l2++) {
        const g2 = 2 * conn[e * 9 + l2];
        addSym(g1, g2, Ke[(2 * l1) * 18 + 2 * l2]);
        addSym(g1, g2 + 1, Ke[(2 * l1) * 18 + 2 * l2 + 1]);
        addSym(g1 + 1, g2, Ke[(2 * l1 + 1) * 18 + 2 * l2]);
        addSym(g1 + 1, g2 + 1, Ke[(2 * l1 + 1) * 18 + 2 * l2 + 1]);
      }
    }
  }

  // --- Dirichlet boundary conditions ---------------------------------------
  const rhsBase = new Float64Array(n);
  const bcVal = new Float64Array(n);
  const isBC = new Uint8Array(n);
  for (const ir of [0, nodeRings - 1]) {
    for (let j = 0; j < perRing; j++) {
      const nd = nid(ir, j);
      const [ub, vb] = bcVel(nodeX[nd], nodeY[nd]);
      bcVal[2 * nd] = ub;
      bcVal[2 * nd + 1] = vb;
      isBC[2 * nd] = 1;
      isBC[2 * nd + 1] = 1;
    }
  }
  for (let d = 0; d < n; d++) {
    if (!isBC[d]) continue;
    const g = bcVal[d];
    // entries (i, d) with i > d and (d, j) with j < d
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
  const assembleMs = performance.now() - t0;

  // --- banded Cholesky ------------------------------------------------------
  // Inner loops run over the band OFFSET o = j - k with fixed row bases, so
  // both factor accesses are unit-stride for the JIT.
  const t1 = performance.now();
  for (let j = 0; j < n; j++) {
    const bj = j * hb1;
    let s = band[bj];
    const oMaxJ = Math.min(j, hbw);
    for (let o = 1; o <= oMaxJ; o++) {
      const L = band[bj + o];
      s -= L * L;
    }
    if (s <= 0) throw new Error(`stokesfem: matrix not SPD at dof ${j}`);
    const Ljj = Math.sqrt(s);
    band[bj] = Ljj;
    const iMax = Math.min(j + hbw, n - 1);
    for (let i = j + 1; i <= iMax; i++) {
      const bi = i * hb1 + (i - j); // band[bi + o] = A[i, j - o]
      let t = band[bi];
      const oMax = Math.min(j, hbw - (i - j));
      for (let o = 1; o <= oMax; o++) {
        t -= band[bi + o] * band[bj + o];
      }
      band[bi] = t / Ljj;
    }
  }
  const factorMs = performance.now() - t1;

  function bandSolve(b: Float64Array): Float64Array {
    const x = Float64Array.from(b);
    for (let i = 0; i < n; i++) {
      let s = x[i];
      const k0 = Math.max(0, i - hbw);
      for (let k = k0; k < i; k++) s -= band[i * hb1 + (i - k)] * x[k];
      x[i] = s / band[i * hb1];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      const kMax = Math.min(i + hbw, n - 1);
      for (let k = i + 1; k <= kMax; k++) s -= band[k * hb1 + (k - i)] * x[k];
      x[i] = s / band[i * hb1];
    }
    return x;
  }

  // --- Powell-Hestenes iterations -------------------------------------------
  const t2 = performance.now();
  let u: Float64Array = new Float64Array(n);
  let divResidual = Infinity;
  const rhs = new Float64Array(n);
  const ue = new Float64Array(18);
  for (let it = 0; it < phIterations; it++) {
    rhs.set(rhsBase);
    // rhs += Q^T p (element scatter), skipping constrained rows
    for (let e = 0; e < nEl; e++) {
      for (let l = 0; l < 9; l++) {
        const nd = conn[e * 9 + l];
        for (let c = 0; c < 2; c++) {
          const d = 2 * nd + c;
          if (isBC[d]) continue;
          let s = 0;
          for (let a = 0; a < 3; a++) s += elQ[e * 54 + a * 18 + 2 * l + c] * elP[e * 3 + a];
          rhs[d] += s;
        }
      }
    }
    for (let d = 0; d < n; d++) if (isBC[d]) rhs[d] = bcVal[d];
    u = bandSolve(rhs);

    // pressure update: p_e -= kappa M^{-1} Q u_e; converged when the relative
    // pressure increment is negligible (MILAMIN's criterion)
    let dpMax = 0;
    let pMax = 0;
    for (let e = 0; e < nEl; e++) {
      for (let l = 0; l < 9; l++) {
        const nd = conn[e * 9 + l];
        ue[2 * l] = u[2 * nd];
        ue[2 * l + 1] = u[2 * nd + 1];
      }
      const qu = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        let s = 0;
        for (let i = 0; i < 18; i++) s += elQ[e * 54 + a * 18 + i] * ue[i];
        qu[a] = s;
      }
      for (let a = 0; a < 3; a++) {
        let s = 0;
        for (let b = 0; b < 3; b++) s += elKinvM[e * 9 + a * 3 + b] * qu[b];
        elP[e * 3 + a] -= s;
        if (a === 0) dpMax = Math.max(dpMax, Math.abs(s));
      }
      pMax = Math.max(pMax, Math.abs(elP[e * 3]));
    }
    divResidual = dpMax / Math.max(pMax, 1e-300);
    if (divResidual < 1e-11) break;
  }
  const phMs = performance.now() - t2;

  const core: StokesFemCore = {
    nodes: nNodes,
    dofs: n,
    halfBandwidth: hbw,
    assembleMs,
    factorMs,
    phMs,
    divResidual,
    nTheta,
    nr,
    rad,
    conn,
    nodeX,
    nodeY,
    u,
    elP,
    elCx,
    elCy,
    elH,
    elMu,
  };
  return { ...core, evalAt: femEvaluator(core) };
}

/** Rebuild a point evaluator from the plain solve data (e.g. after a worker transfer). */
export function femEvaluator(core: StokesFemCore): StokesFemSolution['evalAt'] {
  const { nTheta, nr, rad, conn, nodeX, nodeY, u, elP, elCx, elCy, elH, elMu } = core;
  const dTheta = (2 * Math.PI) / nTheta;
  const NN = new Float64Array(9);
  const dNdx = new Float64Array(9);
  const dNdy = new Float64Array(9);

  return function evalAt(x: number, y: number) {
    const r = Math.hypot(x, y);
    if (r < rad[0] - 1e-9 || r > rad[nr] + 1e-9) return null;
    let theta = Math.atan2(y, x);
    if (theta < 0) theta += 2 * Math.PI;
    // ring index
    let lo = 0;
    let hi = nr - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r >= rad[mid]) lo = mid;
      else hi = mid - 1;
    }
    const i = Math.min(lo, nr - 1);
    const js = Math.min(Math.floor(theta / dTheta), nTheta - 1);
    const e = i * nTheta + js;
    const xi = Math.max(-1, Math.min(1, (2 * (r - rad[i])) / (rad[i + 1] - rad[i]) - 1));
    const eta = Math.max(-1, Math.min(1, (2 * (theta - js * dTheta)) / dTheta - 1));

    const [Lx, dLx] = lag(xi);
    const [Ly, dLy] = lag(eta);
    let J11 = 0, J12 = 0, J21 = 0, J22 = 0;
    for (let b = 0; b < 3; b++) {
      for (let a = 0; a < 3; a++) {
        const l = b * 3 + a;
        const nd = conn[e * 9 + l];
        NN[l] = Lx[a] * Ly[b];
        const dXi = dLx[a] * Ly[b];
        const dEta = Lx[a] * dLy[b];
        J11 += dXi * nodeX[nd];
        J12 += dXi * nodeY[nd];
        J21 += dEta * nodeX[nd];
        J22 += dEta * nodeY[nd];
        dNdx[l] = dXi;
        dNdy[l] = dEta;
      }
    }
    const det = J11 * J22 - J12 * J21;
    let uu = 0, vv = 0, exx = 0, eyy = 0, exy = 0;
    for (let l = 0; l < 9; l++) {
      const gx = (J22 * dNdx[l] - J12 * dNdy[l]) / det;
      const gy = (-J21 * dNdx[l] + J11 * dNdy[l]) / det;
      const nd = conn[e * 9 + l];
      const ul = u[2 * nd];
      const vl = u[2 * nd + 1];
      uu += NN[l] * ul;
      vv += NN[l] * vl;
      exx += gx * ul;
      eyy += gy * vl;
      exy += 0.5 * (gy * ul + gx * vl);
    }
    const p = elP[e * 3] + (elP[e * 3 + 1] * (x - elCx[e])) / elH[e] + (elP[e * 3 + 2] * (y - elCy[e])) / elH[e];
    const tau = 2 * elMu[e] * Math.sqrt(((exx - eyy) / 2) ** 2 + exy ** 2);
    return { u: uu, v: vv, p, tau, mu: elMu[e] };
  };
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
