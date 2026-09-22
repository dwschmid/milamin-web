// Model geometry for the folding/boudinage simulation: a rectangular box of
// viscous matrix with one or more embedded stiff layers, following FOLDER
// (Adamuszek, Dabrowski & Schmid 2016). The layer interfaces are explicit
// polylines and form the time-stepping state; the mesh is rebuilt from them
// before every Stokes solve. Lengths are in units of the initial layer
// thickness, time is logarithmic strain (background strain rate 1).

import { MeshSpec } from '@fem/trimesh';

export const MARKER = { LEFT: 1, RIGHT: 2, BOTTOM: 3, TOP: 4, INTERFACE: 9 } as const;

export type StrainMode = 'shortening' | 'extension';

/** Interface perturbation types, as in FOLDER's perturbation.m: a sine, three
 *  kinds of noise (white: all box modes at equal amplitude with random
 *  phases; red: amplitude 1/n; fractal: amplitude n^-(H+1/2), H the Hurst
 *  exponent), and three single shapes (step, triangle wave, bell). */
export type Perturbation = 'sine' | 'white' | 'red' | 'fractal' | 'step' | 'triangle' | 'bell';

export interface ModelParams {
  /** box width over layer thickness at t = 0 */
  boxWidth: number;
  /** box height over layer thickness at t = 0 */
  boxHeight: number;
  /** nodes per interface polyline at t = 0 */
  nx: number;
  /** number of layers (stacked symmetrically about y = 0) */
  layers: number;
  /** center-to-center layer spacing over thickness (multilayer) */
  spacing: number;
  perturbation: Perturbation;
  /** initial perturbation amplitude over layer thickness (peak-to-peak / 2) */
  amp0: number;
  /** sine and triangle wavelength over layer thickness */
  wavelength: number;
  /** bell half-width over thickness, or the Hurst exponent of fractal noise */
  width?: number;
  /** RNG seed for the noise perturbation */
  seed: number;
  /**
   * Deformation mode. Also selects the sine perturbation symmetry: in-phase
   * interfaces seed folding under shortening, opposed interfaces seed
   * pinch-and-swell under extension.
   */
  mode: StrainMode;
}

export interface Face {
  X: Float64Array;
  Y: Float64Array;
}

export interface SimState {
  /** time = accumulated logarithmic strain */
  t: number;
  halfW: number;
  halfH: number;
  /** interface polylines ordered bottom to top; two per layer */
  faces: Face[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One perturbation profile, normalized as in FOLDER to peak-to-peak 2 amp0
 *  and centred (values in [-amp0, amp0]). Periodic shapes fit whole waves
 *  into the box so they meet the free-slip walls at zero slope; the noises
 *  have their end nodes flattened for the same reason. */
function perturbationProfile(p: ModelParams, faceIndex: number): Float64Array {
  const n = p.nx;
  const L = p.boxWidth;
  const pert = new Float64Array(n);
  const xs = (i: number) => -L / 2 + (L * i) / (n - 1);
  // extension: opposed interfaces (necking mode); shortening: in phase
  const sign = p.mode === 'extension' && faceIndex % 2 === 0 ? -1 : 1;
  const rand = mulberry32(p.seed + 1000 * faceIndex);
  const modes = Math.max(1, Math.floor(n / 2));
  const noise = (amp: (m: number) => number) => {
    for (let m = 1; m <= modes; m++) {
      const phi = 2 * Math.PI * rand();
      const a = amp(m);
      for (let i = 0; i < n; i++) pert[i] += a * Math.cos((2 * Math.PI * m * xs(i)) / L + phi);
    }
    pert[0] = pert[1];
    pert[n - 1] = pert[n - 2];
  };
  switch (p.perturbation) {
    case 'sine': {
      const waves = Math.max(1, Math.round(L / p.wavelength));
      const k = (2 * Math.PI * waves) / L;
      for (let i = 0; i < n; i++) pert[i] = sign * Math.cos(k * xs(i));
      break;
    }
    case 'white':
      noise(() => 1);
      break;
    case 'red':
      noise((m) => 1 / m);
      break;
    case 'fractal': {
      const H = Math.min(1, Math.max(0, p.width ?? 0.5));
      noise((m) => m ** -(H + 0.5));
      break;
    }
    case 'step':
      for (let i = 0; i < n; i++) pert[i] = sign * (xs(i) > 0 ? 1 : -1);
      break;
    case 'triangle': {
      const waves = Math.max(1, Math.round(L / p.wavelength));
      const half = L / waves / 2;
      for (let i = 0; i < n; i++) {
        // zigzag between +1 at the wave crests and -1 at the troughs
        const u = ((xs(i) + L / 2) / half) % 2;
        pert[i] = sign * (1 - 2 * Math.abs(u - 1));
      }
      break;
    }
    case 'bell': {
      const w = Math.max(0.1, p.width ?? 4);
      for (let i = 0; i < n; i++) pert[i] = sign / (1 + (xs(i) / w) ** 2);
      break;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (pert[i] < min) min = pert[i];
    if (pert[i] > max) max = pert[i];
  }
  if (max - min > 0) {
    const scale = (2 * p.amp0) / (max - min);
    for (let i = 0; i < n; i++) pert[i] = (pert[i] - min) * scale - p.amp0;
  }
  return pert;
}

export function initialState(p: ModelParams): SimState {
  const halfW = p.boxWidth / 2;
  const halfH = p.boxHeight / 2;
  const faces: Face[] = [];
  for (let l = 0; l < p.layers; l++) {
    const yc = (l - (p.layers - 1) / 2) * p.spacing;
    for (const off of [-0.5, 0.5]) {
      const idx = faces.length;
      const pert = perturbationProfile(p, idx);
      const X = new Float64Array(p.nx);
      const Y = new Float64Array(p.nx);
      for (let i = 0; i < p.nx; i++) {
        X[i] = -halfW + (p.boxWidth * i) / (p.nx - 1);
        Y[i] = yc + off + pert[i];
      }
      faces.push({ X, Y });
    }
  }
  return { t: 0, halfW, halfH, faces };
}

/** Fold/pinch amplitude: mean over interfaces of half their peak-to-peak
 *  deflection. Index-free, so it survives resampling. */
export function amplitude(s: SimState): number {
  let sum = 0;
  for (const f of s.faces) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < f.Y.length; i++) {
      if (f.Y[i] < min) min = f.Y[i];
      if (f.Y[i] > max) max = f.Y[i];
    }
    sum += (max - min) / 2;
  }
  return sum / s.faces.length;
}

/** Redistribute interface nodes uniformly in arc length when advection has
 *  stretched or crowded them too far from the target spacing. */
export function resampleFaces(s: SimState, targetSpacing: number): void {
  for (let fi = 0; fi < s.faces.length; fi++) {
    const { X, Y } = s.faces[fi];
    const n = X.length;
    const cum = new Float64Array(n);
    let maxSeg = 0;
    let minSeg = Infinity;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
      cum[i] = cum[i - 1] + d;
      if (d > maxSeg) maxSeg = d;
      if (d < minSeg) minSeg = d;
    }
    if (maxSeg < 1.5 * targetSpacing && minSeg > 0.5 * targetSpacing) continue;
    const total = cum[n - 1];
    const m = Math.max(9, Math.round(total / targetSpacing) + 1);
    const nX = new Float64Array(m);
    const nY = new Float64Array(m);
    let j = 1;
    for (let i = 0; i < m; i++) {
      const target = (total * i) / (m - 1);
      while (j < n - 1 && cum[j] < target) j++;
      const t = (target - cum[j - 1]) / (cum[j] - cum[j - 1] || 1e-300);
      nX[i] = X[j - 1] + t * (X[j] - X[j - 1]);
      nY[i] = Y[j - 1] + t * (Y[j] - Y[j - 1]);
    }
    nX[0] = X[0];
    nY[0] = Y[0];
    nX[m - 1] = X[n - 1];
    nY[m - 1] = Y[n - 1];
    s.faces[fi] = { X: nX, Y: nY };
  }
}

/**
 * PSLG for the current geometry: the box walls are split at the interface
 * endpoints (a valid PSLG only lets segments meet at shared points), the
 * interfaces are internal segments, and region seeds set the material
 * attribute (1 = matrix, 2 = layer) and mesh density. Faces are assumed
 * ordered bottom to top on both walls.
 */
export function toMeshSpec(s: SimState, areaLayer: number, areaMatrix: number): MeshSpec {
  const { halfW, halfH } = s;
  const points: Array<[number, number]> = [
    [-halfW, -halfH], // 0 bottom-left
    [halfW, -halfH], // 1 bottom-right
    [halfW, halfH], // 2 top-right
    [-halfW, halfH], // 3 top-left
  ];
  const faceStart: number[] = [];
  for (const f of s.faces) {
    faceStart.push(points.length);
    for (let i = 0; i < f.X.length; i++) points.push([f.X[i], f.Y[i]]);
  }
  const left = (fi: number) => faceStart[fi];
  const right = (fi: number) => faceStart[fi] + s.faces[fi].X.length - 1;

  const segments: Array<[number, number, number]> = [[0, 1, MARKER.BOTTOM], [2, 3, MARKER.TOP]];
  // walls, split at each interface endpoint (faces ordered bottom to top)
  let prev = 1;
  for (let fi = 0; fi < s.faces.length; fi++) {
    segments.push([prev, right(fi), MARKER.RIGHT]);
    prev = right(fi);
  }
  segments.push([prev, 2, MARKER.RIGHT]);
  prev = 0;
  for (let fi = 0; fi < s.faces.length; fi++) {
    segments.push([prev, left(fi), MARKER.LEFT]);
    prev = left(fi);
  }
  segments.push([prev, 3, MARKER.LEFT]);
  for (let fi = 0; fi < s.faces.length; fi++) {
    for (let i = 0; i < s.faces[fi].X.length - 1; i++) {
      segments.push([faceStart[fi] + i, faceStart[fi] + i + 1, MARKER.INTERFACE]);
    }
  }

  // region seeds at a mid-column node: matrix below, then alternating layer /
  // matrix between consecutive interfaces, matrix above
  const regions: Array<[number, number, number, number]> = [];
  const midOf = (fi: number) => {
    const f = s.faces[fi];
    const m = f.X.length >> 1;
    return [f.X[m], f.Y[m]] as const;
  };
  {
    const [x0, y0] = midOf(0);
    regions.push([x0, (y0 - halfH) / 2, 1, areaMatrix]);
    for (let fi = 0; fi + 1 < s.faces.length; fi++) {
      const [xa, ya] = midOf(fi);
      const [xb, yb] = midOf(fi + 1);
      const layer = fi % 2 === 0; // between bottom and top of the same layer
      regions.push([(xa + xb) / 2, (ya + yb) / 2, layer ? 2 : 1, layer ? areaLayer : areaMatrix]);
    }
    const [x1, y1] = midOf(s.faces.length - 1);
    regions.push([x1, (y1 + halfH) / 2, 1, areaMatrix]);
  }

  return { boundaries: [], points, segments, regions };
}
