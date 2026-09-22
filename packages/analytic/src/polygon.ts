// Rigid (quasi-)polygonal inclusions in general shear — matrix field of
// Schmid (2005), "Rigid polygons in shear", Geol. Soc. London Spec. Pub. 245,
// 421-431 (eqs. 1-8). The interior was FEM in the paper and is masked here.
// Pentagons and hexagons (n = 4, 5) extend the paper's construction: with
//   phi = A zeta + B zeta^{n-2},  B = -conj(A) m,  A = -L / (1 - (n-2) m^2),
// the spurious pole of the conjugate-transformed psi cancels exactly, leaving
//   psi = conj(A)(1 + (n-2) m^2 S)/zeta - A (1 + n m^2) zeta^3 S
//         + (n-2) conj(A) m zeta^n S,        S = 1/(n m zeta^{n+1} - 1),
// which reproduces the published n = 2 (B = 0, A = -L) and n = 3
// (B = 0, A = (m conj(L) - L)/(1 - m^2)) solutions as special cases. For
// n >= 4, phi'' != 0 and the full stress formula is used. The rigid boundary
// condition check in verify/check_polygon.ts validates the derivation.
//
// The hypotrochoid transform (eq. 1)
//   z = R (1/zeta + m zeta^n),   n + 1 = number of vertices,
// maps the INSIDE of the unit circle in zeta to the OUTSIDE of the polygon in
// z (zeta -> 0 is z -> infinity). Rigid triangles (n = 2) and squares (n = 3)
// have closed-form potentials (eqs. 2-5, after Savin 1961), here generalized
// from pure shear at inclination alpha to general shear via the complex
// loading constant
//   L = (er + i gr / 2) e^{2 i alpha}
// (for gr = 0 this is the paper's  edot e^{2 i alpha}; the substitution
// e^{2 i alpha} -> L / edot, e^{-2 i alpha} -> conj(L) / edot is exact because
// the solution is real-linear in the far field). The far-field deviatoric
// stress then comes out as E = i gr - 2 er, the same normalization as the
// other pages (tauFar = |E|). Equiangular polygons rotate at half the
// far-field vorticity (omega = -gr/2), so the co-rotating stress problem is
// exactly this pure-strain solution at every instant.
//
// With phi, psi as functions of zeta and w = omega-map:
//   p   = -2 Re( phi' / w' )                                      (eq. 6)
//   tau = | conj(w) (phi'' w' - phi' w'') / w'^3 + psi' / w' |
// (phi'' = 0 for both shapes: phi is linear in zeta).
//
// Verified in verify/check_polygon.ts: rigid-circle limit m -> 0 against
// src/circle.ts, the rigid boundary condition (velocity = 0 on |zeta| = 1 in
// the co-rotating frame), the paper's explicit pressure formulas (7)/(8)
// against the potential-derived pressure, and far-field limits.

export type PolygonShape = 'triangle' | 'square' | 'pentagon' | 'hexagon';

const SHAPE_N: Record<PolygonShape, number> = { triangle: 2, square: 3, pentagon: 4, hexagon: 5 };

export interface PolygonParams {
  shape: PolygonShape;
  /**
   * Vertex sharpness in [0, 1): |m| n of the mapping. 0 = circle, -> 1 =
   * cusped vertices (stresses diverge there).
   */
  sharp: number;
  /** Inclination of the far-field flow relative to the polygon, radians */
  alpha: number;
  /** Far-field pure shear strain rate (negative = horizontal shortening along x) */
  er: number;
  /** Far-field simple shear strain rate */
  gr: number;
}

interface Cx {
  re: number;
  im: number;
}
const cx = (re: number, im = 0): Cx => ({ re, im });
const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
const sub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const conj = (a: Cx): Cx => cx(a.re, -a.im);
const scale = (a: Cx, s: number): Cx => cx(a.re * s, a.im * s);
const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const abs2 = (a: Cx): number => a.re * a.re + a.im * a.im;

export interface PolygonSolution {
  params: PolygonParams;
  /** Mapping parameters: z = 1/zeta + m zeta^n (R = 1, the length unit) */
  n: number;
  m: number;
  tauFar: number;
  /** Rigid-body rotation rate, -gr/2 (equiangular shapes) */
  omega: number;
  /** Maximum |p| and tau on the interface, and the pressure/stress ratio */
  pInterfMax: number;
  tauInterfMax: number;
  /** Field at a physical point; inside the rigid clast fields are undefined */
  evalAt(x: number, y: number): { p: number; tau: number; inside: boolean };
  /**
   * Velocity in the matrix; on the clast boundary it equals the rigid-body
   * rotation (-gr/2 y', gr/2 x')... i.e. i Omega z with Omega = -gr/2, and far
   * away it tends to the applied general shear. Inside the clast the rigid
   * rotation is returned.
   */
  velAt(x: number, y: number): [number, number];
  /** Polygon outline, n points */
  outline(k: number): Array<[number, number]>;
  /** Fields as a function of zeta on/outside the interface (|zeta| <= 1) */
  fieldsAtZeta(zeta: Cx): { p: number; tau: number; z: Cx };
}

/**
 * Newton fast path for the preimage: solves m zeta^{n+1} - z zeta + 1 = 0
 * from a warm start (the neighbouring pixel's preimage). Returns null when it
 * does not converge cleanly into the closed unit disk.
 */
function newtonInvert(n: number, m: number, z: Cx, guess: Cx): Cx | null {
  let w = guess;
  for (let iter = 0; iter < 24; iter++) {
    // f = m w^{n+1} - z w + 1;  f' = (n+1) m w^n - z
    let wn = cx(m, 0);
    for (let k = 0; k < n; k++) wn = mul(wn, w); // m w^n
    const f = add(sub(mul(wn, w), mul(z, w)), cx(1, 0));
    const fp = sub(scale(wn, n + 1), z);
    if (abs2(fp) < 1e-280) return null;
    const step = div(f, fp);
    w = sub(w, step);
    if (abs2(step) < 1e-26) {
      return abs2(w) <= 1 + 1e-9 ? w : null;
    }
  }
  return null;
}

/**
 * Preimage of z under the hypotrochoid: the unique root of
 *   m zeta^{n+1} - z zeta + 1 = 0
 * inside the closed unit disk, or null if none (z inside the polygon).
 * Durand-Kerner on the full root set; `warm` seeds the previous pixel's
 * preimage for faster convergence along scanlines.
 */
export function invertMap(n: number, m: number, z: Cx, warm?: Cx | null): Cx | null {
  const deg = n + 1;
  if (Math.abs(m) < 1e-14) {
    // z = 1/zeta
    const d = abs2(z);
    if (d < 1) return null;
    return cx(z.re / d, -z.im / d);
  }
  // roots of m w^deg - z w + 1
  const roots: Cx[] = [];
  let seed = cx(0.4, 0.9);
  let acc = cx(1, 0);
  for (let k = 0; k < deg; k++) {
    acc = mul(acc, seed);
    roots.push(acc);
  }
  if (warm) roots[0] = warm;
  const evalP = (w: Cx): Cx => {
    // m w^deg - z w + 1 (deg is 3 or 4: unroll via repeated multiply)
    let p = cx(m, 0);
    for (let k = 0; k < deg - 1; k++) p = mul(p, w);
    p = sub(mul(p, w), mul(z, w));
    return add(p, cx(1, 0));
  };
  for (let iter = 0; iter < 80; iter++) {
    let maxStep = 0;
    for (let i = 0; i < deg; i++) {
      let denom = cx(m, 0);
      for (let j = 0; j < deg; j++) {
        if (j !== i) denom = mul(denom, sub(roots[i], roots[j]));
      }
      if (abs2(denom) < 1e-300) {
        // coincident iterates: nudge apart
        roots[i] = add(roots[i], cx(1e-6, 1e-6));
        maxStep = 1;
        continue;
      }
      const step = div(evalP(roots[i]), denom);
      roots[i] = sub(roots[i], step);
      maxStep = Math.max(maxStep, abs2(step));
    }
    if (maxStep < 1e-28) break;
  }
  let best: Cx | null = null;
  let bestR = Infinity;
  for (const r of roots) {
    const a = abs2(r);
    if (a < bestR) {
      bestR = a;
      best = r;
    }
  }
  return bestR <= 1 + 1e-9 ? best : null;
}

export function solve(params: PolygonParams): PolygonSolution {
  const { shape, er, gr, alpha } = params;
  const sharp = Math.min(Math.max(params.sharp, 0), 0.995);
  const n = SHAPE_N[shape];
  // Canonical orientations (m sign only rotates the shape): square (m < 0)
  // has flat sides facing the axes (fig. 1 of the paper); the others have a
  // vertex on +x.
  const m = shape === 'square' ? -sharp / n : sharp / n;

  const tauFar = Math.hypot(2 * er, gr);

  // Loading constant L = (er + i gr/2) e^{2 i alpha}
  const e2a = cx(Math.cos(2 * alpha), Math.sin(2 * alpha));
  const L = mul(cx(er, gr / 2), e2a);
  const Lc = conj(L);
  // phi/2 = A zeta + B zeta^{n-2}
  let A: Cx;
  let B: Cx;
  if (n === 2) {
    A = scale(L, -1);
    B = cx(0);
  } else if (n === 3) {
    A = scale(sub(scale(Lc, m), L), 1 / (1 - m * m));
    B = cx(0);
  } else {
    A = scale(L, -1 / (1 - (n - 2) * m * m));
    B = scale(conj(A), -m);
  }

  // w(zeta)   = 1/zeta + m zeta^n
  // w'(zeta)  = -1/zeta^2 + n m zeta^{n-1}
  // w''(zeta) = 2/zeta^3 + n (n-1) m zeta^{n-2}
  // phi/2  = A zeta + B zeta^{n-2}   (B = 0 for n <= 3)
  // phi'/2 = A + (n-2) B zeta^{n-3};  phi''/2 = (n-2)(n-3) B zeta^{n-4}
  // psi'/2: published forms for n = 2, 3; the derived general form for n >= 4
  // (see header). All with S = 1/(n m zeta^{n+1} - 1).

  const cpowN = (z: Cx, k: number): Cx => {
    let r = cx(1, 0);
    for (let i = 0; i < k; i++) r = mul(r, z);
    return r;
  };

  /** phi/2 and psi/2 as VALUES (for the velocity; derivatives live in fieldsAtZeta). */
  function potentialsAtZeta(zeta: Cx): { phiH: Cx; psiH: Cx } {
    const z2 = mul(zeta, zeta);
    const z3 = mul(z2, zeta);
    const iz = div(cx(1, 0), zeta);
    const zn = cpowN(zeta, n);
    const zn1 = mul(zn, zeta);
    const S = div(cx(1, 0), sub(scale(zn1, n * m), cx(1, 0)));
    const phiH = add(mul(A, zeta), mul(B, cpowN(zeta, n - 2)));
    let psiH: Cx;
    if (n === 2) {
      // psi/2 = conj(A)/zeta - A (zeta^3 + m) S
      psiH = sub(mul(conj(A), iz), mul(mul(A, add(z3, cx(m, 0))), S));
    } else if (n === 3) {
      // psi/2 = -conj(L)/zeta - (3 m^2 + 1) zeta^3 S A
      psiH = sub(scale(mul(Lc, iz), -1), scale(mul(mul(z3, S), A), 3 * m * m + 1));
    } else {
      // psi/2 = conj(A)(1 + (n-2) m^2 S)/zeta - A (1 + n m^2) zeta^3 S
      //         + (n-2) conj(A) m zeta^n S
      const Ac = conj(A);
      psiH = add(
        sub(
          mul(mul(Ac, add(cx(1, 0), scale(S, (n - 2) * m * m))), iz),
          scale(mul(mul(A, z3), S), 1 + n * m * m),
        ),
        scale(mul(mul(Ac, zn), S), (n - 2) * m),
      );
    }
    return { phiH, psiH };
  }

  function fieldsAtZeta(zeta: Cx): { p: number; tau: number; z: Cx } {
    const z2 = mul(zeta, zeta);
    const z3 = mul(z2, zeta);
    const iz = div(cx(1, 0), zeta);
    const iz2 = mul(iz, iz);
    const iz3 = mul(iz2, iz);
    const zn = cpowN(zeta, n);
    const zn1 = mul(zn, zeta);

    const w = add(iz, scale(zn, m));
    const wp = add(scale(iz2, -1), scale(cpowN(zeta, n - 1), n * m));
    const wpp = add(scale(iz3, 2), scale(cpowN(zeta, n - 2), n * (n - 1) * m));

    const S = div(cx(1, 0), sub(scale(zn1, n * m), cx(1, 0)));
    const S2 = mul(S, S);

    let phip: Cx;
    let phipp: Cx;
    let psip: Cx;
    if (n === 2) {
      phip = scale(A, 2);
      phipp = cx(0);
      // psi'/2 = conj(L)/zeta^2 - 3 (1 + 2 m^2) zeta^2 S^2 L
      psip = scale(add(mul(Lc, iz2), scale(mul(mul(z2, S2), L), -3 * (1 + 2 * m * m))), 2);
    } else if (n === 3) {
      phip = scale(A, 2);
      phipp = cx(0);
      // psi'/2 = conj(L)/zeta^2 + 3 (3 m^2 + 1) zeta^2 (m zeta^4 + 1) S^2 A
      const num = add(scale(zn1, m), cx(1, 0)); // m zeta^4 + 1
      psip = scale(add(mul(Lc, iz2), scale(mul(mul(mul(z2, num), S2), A), 3 * (3 * m * m + 1))), 2);
    } else {
      phip = scale(add(A, scale(mul(B, cpowN(zeta, n - 3)), n - 2)), 2);
      phipp = scale(mul(B, cpowN(zeta, n - 4)), 2 * (n - 2) * (n - 3));
      const Sp = scale(mul(zn, S2), -n * m * (n + 1)); // S'
      const Ac = conj(A);
      const t1 = mul(
        Ac,
        add(
          scale(mul(add(cx(1, 0), scale(S, (n - 2) * m * m)), iz2), -1),
          scale(mul(Sp, iz), (n - 2) * m * m),
        ),
      );
      const t2 = scale(mul(A, add(scale(mul(z2, S), 3), mul(z3, Sp))), -(1 + n * m * m));
      const t3 = scale(mul(Ac, add(scale(mul(cpowN(zeta, n - 1), S), n), mul(zn, Sp))), (n - 2) * m);
      psip = scale(add(add(t1, t2), t3), 2);
    }

    const Phi = div(phip, wp);
    const p = -2 * Phi.re;

    // s = conj(w) (phi'' w' - phi' w'') / w'^3 + psi' / w'
    const wp3 = mul(mul(wp, wp), wp);
    const t1s = mul(conj(w), div(sub(mul(phipp, wp), mul(phip, wpp)), wp3));
    const s = add(t1s, div(psip, wp));
    return { p, tau: Math.sqrt(abs2(s)), z: w };
  }

  // Star-shape radius LUT of the boundary: classifies clearly-interior /
  // clearly-exterior points without inverting the mapping. The ambiguous band
  // near the boundary falls through to the exact inversion.
  const BINS = 512;
  const rbMin = new Float64Array(BINS).fill(Infinity);
  const rbMax = new Float64Array(BINS).fill(-Infinity);
  {
    for (let k = 0; k < 8192; k++) {
      const t = (2 * Math.PI * k) / 8192;
      const zr = Math.cos(t) + m * Math.cos(n * t);
      const zi = -Math.sin(t) + m * Math.sin(n * t); // w(e^{-it}) traced; angle from atan2
      const r = Math.hypot(zr, zi);
      let b = Math.floor(((Math.atan2(zi, zr) + Math.PI) / (2 * Math.PI)) * BINS);
      if (b === BINS) b = 0;
      if (r < rbMin[b]) rbMin[b] = r;
      if (r > rbMax[b]) rbMax[b] = r;
    }
    // widen each bin by its neighbours so bin-edge effects stay conservative
    const lo = rbMin.slice();
    const hi = rbMax.slice();
    for (let b = 0; b < BINS; b++) {
      const p = (b + BINS - 1) % BINS;
      const q = (b + 1) % BINS;
      rbMin[b] = Math.min(lo[p], lo[b], lo[q]);
      rbMax[b] = Math.max(hi[p], hi[b], hi[q]);
    }
  }
  const BAND = 0.02;

  /** velocity 2 mu (u+iv) = phi - w conj(phi'/w') - conj(psi), plus the
   *  stress-free rigid rotation i Omega z (Omega = -gr/2). mu_matrix = 1. */
  function velAtZeta(zeta: Cx): Cx {
    const { phiH, psiH } = potentialsAtZeta(zeta);
    const iz = div(cx(1, 0), zeta);
    const iz2 = mul(iz, iz);
    const zn = cpowN(zeta, n);
    const w = add(iz, scale(zn, m));
    const wp = add(scale(iz2, -1), scale(cpowN(zeta, n - 1), n * m));
    const phip = scale(add(A, scale(mul(B, cpowN(zeta, n - 3)), n - 2)), 2);
    const vPot = scale(
      sub(sub(scale(phiH, 2), mul(w, conj(div(phip, wp)))), conj(scale(psiH, 2))),
      0.5,
    );
    // + i Omega z, Omega = -gr/2
    const rot = mul(cx(0, -gr / 2), w);
    return add(vPot, rot);
  }

  function velAt(x: number, y: number): [number, number] {
    const zeta = invertMap(n, m, cx(x, y), null);
    if (!zeta) {
      // rigid interior: pure rotation at Omega = -gr/2
      return [(gr / 2) * y, -(gr / 2) * x];
    }
    const v = velAtZeta(zeta);
    return [v.re, v.im];
  }

  let warm: Cx | null = null;
  function evalAt(x: number, y: number): { p: number; tau: number; inside: boolean } {
    const r = Math.hypot(x, y);
    let b = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * BINS);
    if (b === BINS) b = 0;
    if (r < rbMin[b] - BAND) {
      return { p: 0, tau: 0, inside: true };
    }
    let zeta: Cx | null = null;
    if (r > rbMax[b] + BAND && warm) {
      zeta = newtonInvert(n, m, cx(x, y), warm);
    }
    if (!zeta) zeta = invertMap(n, m, cx(x, y), warm);
    if (!zeta) {
      warm = null;
      return { p: 0, tau: 0, inside: true };
    }
    warm = zeta;
    const f = fieldsAtZeta(zeta);
    return { p: f.p, tau: f.tau, inside: false };
  }

  function outline(k: number): Array<[number, number]> {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= k; i++) {
      const t = (2 * Math.PI * i) / k;
      const f = fieldsAtZeta(cx(Math.cos(t), Math.sin(t)));
      pts.push([f.z.re, f.z.im]);
    }
    return pts;
  }

  // Interface extrema, sampled just outside |zeta| = 1 for numerical safety.
  let pInterfMax = 0;
  let tauInterfMax = 0;
  for (let i = 0; i < 1440; i++) {
    const t = (2 * Math.PI * i) / 1440;
    const f = fieldsAtZeta(cx(0.999999 * Math.cos(t), 0.999999 * Math.sin(t)));
    pInterfMax = Math.max(pInterfMax, Math.abs(f.p));
    tauInterfMax = Math.max(tauInterfMax, f.tau);
  }

  return {
    params: { ...params, sharp },
    n,
    m,
    tauFar,
    omega: -gr / 2,
    pInterfMax,
    tauInterfMax,
    evalAt,
    velAt,
    outline,
    fieldsAtZeta,
  };
}
