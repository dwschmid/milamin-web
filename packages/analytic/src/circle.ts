// The circular viscous inclusion in general shear — the simplest of the
// Muskhelishvili solutions, in explicit closed form (cyl_p_matrix.m /
// cyl_p_interf.m of github.com/dwschmid/muskhelishvili, plus the interior
// and deviatoric fields).
//
// The inclusion has radius 1 (the length unit) and viscosity m relative to
// the matrix (mu_m = 1). Everything is controlled by a single number,
//   A = (m - 1) / (m + 1)  in (-1, 1],
// the dipole strength: -1 = inviscid hole, 0 = no inclusion, 1 = rigid.
// With F = i gr + 2 er and tauFar = |F|:
//
//   matrix:    p   = -2 A Re( F / z^2 )                       (pure dipole)
//              tau = | E - 2 A conj(z) F / z^3 + 3 A F / z^4 |, E = i gr - 2 er
//   interior:  p   = 0,   tau = 2m/(m+1) tauFar               (uniform, Eshelby)
//
// The inclusion rotates rigidly at omega = -gr/2 (half the far-field
// vorticity) for ANY viscosity — circular shapes cannot feel torque
// anisotropy. Verified against the N-rim solver in verify/check_circle.ts.

export interface CircleParams {
  /** Viscosity ratio mu_inclusion / mu_matrix */
  m: number;
  /** Far-field pure shear strain rate (negative = horizontal shortening along x) */
  er: number;
  /** Far-field simple shear strain rate */
  gr: number;
}

export interface CircleSolution {
  params: CircleParams;
  /** Dipole strength A = (m-1)/(m+1) */
  A: number;
  tauFar: number;
  /** Uniform interior max shear stress, 2m/(m+1) tauFar */
  tauIn: number;
  /** Maximum pressure on the interface (matrix side), 2|A| tauFar */
  pInterfMax: number;
  /** Rigid-body rotation rate, -gr/2 for any viscosity */
  omega: number;
  evalAt(x: number, y: number): { p: number; tau: number; inside: boolean };
  /** Velocity (u, v); far field u = er x + gr y, v = -er y */
  velAt(x: number, y: number): [number, number];
  /** Matrix-side continuation, also valid just inside r=1 for interface quadrature. Singular at r=0. */
  evalMatrixAt(x: number, y: number): { p: number; tau: number; inside: boolean };
  velMatrixAt(x: number, y: number): [number, number];
  /** Stream function of the matrix domain (valid for r >= 1) */
  psiMatrix(x: number, y: number): number;
  circle(n: number): Array<[number, number]>;
}

export function solve(params: CircleParams): CircleSolution {
  const { m, er, gr } = params;
  const A = (m - 1) / (m + 1);
  const tauFar = Math.hypot(2 * er, gr);
  const tauIn = ((2 * m) / (m + 1)) * tauFar;
  const pInterfMax = 2 * Math.abs(A) * tauFar;

  // Complex constants: F = i gr + 2 er (loading), E = i gr - 2 er (far-field
  // deviatoric stress). Matrix potentials phi = -A F / z, psi = E z - A F / z^3.
  const Fr = 2 * er, Fi = gr;
  const Er = -2 * er, Ei = gr;

  function evalAt(x: number, y: number): { p: number; tau: number; inside: boolean } {
    const r2 = x * x + y * y;
    if (r2 <= 1) {
      return { p: 0, tau: tauIn, inside: true };
    }
    return evalMatrixAt(x, y);
  }

  function evalMatrixAt(x: number, y: number): { p: number; tau: number; inside: boolean } {
    const r2 = x * x + y * y;
    const z2r = x * x - y * y, z2i = 2 * x * y; // z^2
    const r4 = r2 * r2;
    const i2r = z2r / r4, i2i = -z2i / r4; // 1/z^2

    // p = -2 A Re(F / z^2)
    const p = -2 * A * (Fr * i2r - Fi * i2i);

    // tau = | E - 2 A conj(z) F / z^3 + 3 A F / z^4 |
    const z3r = z2r * x - z2i * y, z3i = z2r * y + z2i * x;
    const r6 = r4 * r2;
    const i3r = z3r / r6, i3i = -z3i / r6; // 1/z^3
    const z4r = z2r * z2r - z2i * z2i, z4i = 2 * z2r * z2i;
    const r8 = r4 * r4;
    const i4r = z4r / r8, i4i = -z4i / r8; // 1/z^4
    const g3r = Fr * i3r - Fi * i3i, g3i = Fr * i3i + Fi * i3r; // F / z^3
    const sr = Er - 2 * A * (x * g3r + y * g3i) + 3 * A * (Fr * i4r - Fi * i4i);
    const si = Ei - 2 * A * (x * g3i - y * g3r) + 3 * A * (Fr * i4i + Fi * i4r);
    return { p, tau: Math.hypot(sr, si), inside: false };
  }

  // Matrix stream function: STREAM_FUN_MAT of cyl_w_rim.m with the uniform-
  // inclusion coefficients Q7 = -A, Q8 = -A (radius 1).
  function psiMatrix(x: number, y: number): number {
    const r2 = x * x + y * y;
    const Q7 = -A;
    const Q8 = -A;
    return (
      er * ((-2 * Q7 * y * x) / r2 + (Q8 * y * x) / (r2 * r2) - x * y) +
      (-0.5 * y * y + (Q7 * x * x) / r2 + 0.5 * Q8 * (-(x * x) / (r2 * r2) + 0.5 / r2)) * gr
    );
  }

  // Velocity from the potentials, 2 mu (u + i v) = phi - z conj(phi') - conj(psi),
  // plus the stress-free rigid rotation i Omega z (Omega = -gr/2) that the
  // stress-only potentials omit. Interior: uniform strain rate (Eshelby
  // scaling 2/(m+1)) plus the same rotation. Verified in check_circle.ts
  // (interface continuity, far field, finite-difference Stokes residual).
  function velAt(x: number, y: number): [number, number] {
    const r2 = x * x + y * y;
    const uRot = (gr / 2) * y;
    const vRot = -(gr / 2) * x;
    if (r2 <= 1) {
      const s = 2 / (m + 1);
      return [s * (er * x + (gr / 2) * y) + uRot, s * ((gr / 2) * x - er * y) + vRot];
    }
    return velMatrixAt(x, y);
  }

  function velMatrixAt(x: number, y: number): [number, number] {
    const r2 = x * x + y * y;
    const uRot = (gr / 2) * y;
    const vRot = -(gr / 2) * x;
    // matrix: u + i v = (c/z + conj(c) z^3/r^4 + F conj(z) - conj(e) z^3/r^6)/2 + rot
    // with c = e = -A F, F = 2 er + i gr (so conj(c) = conj(e) = -A conj(F))
    const cr = -A * Fr, ci = -A * Fi;
    const z3r = x * (x * x - 3 * y * y);
    const z3i = y * (3 * x * x - y * y);
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    // c/z = c conj(z)/r2
    let ur = (cr * x + ci * y) / r2;
    let ui = (ci * x - cr * y) / r2;
    // + conj(c) z^3 / r^4
    ur += (cr * z3r + ci * z3i) / r4;
    ui += (cr * z3i - ci * z3r) / r4;
    // + F conj(z)
    ur += Fr * x + Fi * y;
    ui += Fi * x - Fr * y;
    // - conj(e) z^3 / r^6  (e = c)
    ur -= (cr * z3r + ci * z3i) / r6;
    ui -= (cr * z3i - ci * z3r) / r6;
    return [ur / 2 + uRot, ui / 2 + vRot];
  }

  function circle(n: number): Array<[number, number]> {
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= n; k++) {
      const t = (2 * Math.PI * k) / n;
      pts.push([Math.cos(t), Math.sin(t)]);
    }
    return pts;
  }

  return { params, A, tauFar, tauIn, pInterfMax, omega: -gr / 2, evalAt, velAt, evalMatrixAt, velMatrixAt, psiMatrix, circle };
}
