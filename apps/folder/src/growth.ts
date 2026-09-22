// Analytical growth rates for a single linear-viscous layer under layer-
// parallel pure shear, ported from FOLDER's growth_rate.m (Adamuszek,
// Dabrowski & Schmid 2016, BSD 3-Clause). Conventions: R is the layer/matrix
// viscosity ratio, k = 2*pi*h/lambda the dimensionless wavenumber, and the
// fold amplitude amplifies as dA/dt = (1 + q) * strainRate * A, the 1 being
// the kinematic (passive) part and q the dynamic growth rate.

/** Thin-plate growth rate, Biot (1961). */
export function qBiotThin(k: number, R: number): number {
  return (12 * k * R) / (R * k * k * k + 12);
}

/** Thick-plate growth rate, Fletcher (1977), matrix of infinite extent. */
export function qFletcherThick(k: number, R: number): number {
  return (
    (4 * k * (1 - R) * R) /
    (2 * k * (R * R - 1) - (R + 1) ** 2 * Math.exp(k) + (R - 1) ** 2 * Math.exp(-k))
  );
}

/**
 * Thick-plate growth rate with free-slip boundaries at finite distance:
 * H is half the box height over the layer thickness (growth_rate.m passes
 * boxH/2). Exponential ratios are formed in log space so large k*H does not
 * overflow.
 */
export function qFletcherBounded(k: number, R: number, H: number): number {
  const sinhK = Math.sinh(k);
  const a2b4 = Math.exp(2 * k - 4 * k * H); // AA^2 / BB^4
  const a4b4 = Math.exp(4 * k - 4 * k * H); // AA^4 / BB^4
  const invB4 = Math.exp(-4 * k * H); // 1 / BB^4
  const ab2 = Math.exp(k - 2 * k * H); // AA / BB^2
  const num =
    -4 * k * (R - 1) * (R * (1 - a2b4) - 2 * ab2 * (2 * H - 1) * (k * (R - 1) - sinhK));
  const den =
    (R - 1) ** 2 * (1 + a4b4) * Math.exp(-k) -
    (R + 1) ** 2 * Math.exp(k) * (1 + invB4) +
    2 * k * (R * R - 1) * (1 - a2b4) -
    4 * ab2 * ((2 * H - 1) * k * k * (R - 1) ** 2 + 2 * R - k * (2 * H - 1) * sinhK * (R * R - 1));
  return num / den;
}

/** Thick-plate boudinage (necking) growth rate under extension for linear
 *  materials, Johnson & Fletcher (1994): the folding expression with the
 *  matrix-response signs flipped. Negative for R > 1: linear viscous layers
 *  do not neck. */
export function qNeckThick(k: number, R: number): number {
  return (
    (4 * k * (1 - R) * R) /
    (2 * k * (R * R - 1) + (R + 1) ** 2 * Math.exp(k) - (R - 1) ** 2 * Math.exp(-k))
  );
}

/** Thick-plate boudinage growth rate with free-slip boundaries at finite
 *  distance, ported from growth_rate.m; H = (box height / thickness) / 2. */
export function qNeckBounded(k: number, R: number, H: number): number {
  const sinhK = Math.sinh(k);
  const a2b4 = Math.exp(2 * k - 4 * k * H);
  const a4b4 = Math.exp(4 * k - 4 * k * H);
  const invB4 = Math.exp(-4 * k * H);
  const ab2 = Math.exp(k - 2 * k * H);
  const num =
    4 * k * (R - 1) * (R * (1 - a2b4) - 2 * ab2 * (2 * H - 1) * (k * (R - 1) + sinhK));
  const den =
    (R - 1) ** 2 * (1 + a4b4) * Math.exp(-k) -
    (R + 1) ** 2 * Math.exp(k) * (1 + invB4) -
    2 * k * (R * R - 1) * (1 - a2b4) +
    4 * ab2 * ((2 * H - 1) * k * k * (R - 1) ** 2 + 2 * R + k * (2 * H - 1) * sinhK * (R * R - 1));
  return num / den;
}

/**
 * Thick-plate growth rate for power-law materials: Fletcher (1974) for
 * folding, Pollard & Fletcher (2005) for necking; the two differ only in the
 * sign of the layer-thickness term. nl, nm are the layer and matrix stress
 * exponents (nudged off 1 where the expression degenerates, as in
 * growth_rate.m).
 */
export function qPowerLawThick(k: number, R: number, nl: number, nm: number, neck = false): number {
  if (nl === 1) nl = 1.0001;
  if (nm === 1) nm = 1.0001;
  const alpha = Math.sqrt(1 / nl);
  const beta = Math.sqrt(1 - 1 / nl);
  const Q = Math.sqrt(nl / nm) / R;
  const t3 = Math.sqrt(nl - 1) / (2 * Math.sin(beta * k));
  const t4 = (1 + Q * Q) * (Math.exp(alpha * k) - Math.exp(-alpha * k));
  const t5 = 2 * Q * (Math.exp(alpha * k) + Math.exp(-alpha * k));
  const num = -2 * nl * (1 - 1 / R);
  return num / (1 - Q * Q + (neck ? 1 : -1) * t3 * (t4 + t5));
}

/** Dominant wavelength over thickness, Biot (1961): 2*pi*(R/6)^(1/3). */
export function dominantWavelength(R: number): number {
  return 2 * Math.PI * Math.cbrt(R / 6);
}

/** Dominant wavelength of an arbitrary growth-rate curve, by scanning
 *  lambda/h; returns null when the curve has no interior positive maximum
 *  (e.g. linear viscous necking, which is stable). */
export function dominantWavelengthOf(q: (k: number) => number, lamMin = 2, lamMax = 200): number | null {
  let best = -Infinity;
  let bestLam = null as number | null;
  for (let i = 0; i <= 400; i++) {
    const lam = lamMin * Math.pow(lamMax / lamMin, i / 400);
    const v = q((2 * Math.PI) / lam);
    if (Number.isFinite(v) && v > best) {
      best = v;
      bestLam = lam;
    }
  }
  return best > 0 && bestLam !== lamMax ? bestLam : null;
}

/**
 * Predicted amplitude history under pure shear for a given growth-rate curve
 * q(k). dir = +1 (shortening): the layer thickens as e^t, the wavelength
 * shortens as e^-t, so k grows as e^(2t) and dlnA/dt = 1 + q. dir = -1
 * (extension): k shrinks as e^(-2t) and both the kinematic flattening and
 * the dynamic term flip sign, dlnA/dt = -(1 + q) (verified against the FEM
 * in check_folding.ts). ln(A/A0) by trapezoid on a uniform grid.
 */
export function amplitudeTheory(
  k0: number,
  dir: number,
  tEnd: number,
  q: (k: number) => number,
  n = 256,
): { t: Float64Array; lnA: Float64Array } {
  const t = new Float64Array(n + 1);
  const lnA = new Float64Array(n + 1);
  const dt = tEnd / n;
  let prev = dir * (1 + q(k0));
  for (let i = 1; i <= n; i++) {
    t[i] = i * dt;
    const cur = dir * (1 + q(k0 * Math.exp(2 * dir * t[i])));
    lnA[i] = lnA[i - 1] + (dt * (prev + cur)) / 2;
    prev = cur;
  }
  return { t, lnA };
}
