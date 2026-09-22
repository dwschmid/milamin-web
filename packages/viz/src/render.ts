// Field rendering: evaluate the solution per pixel of the physical plane and
// fill RGBA buffers for the pressure and max-shear-stress panels in a single
// pass. Canvas-independent (plain Uint8ClampedArray) so the same code runs in
// the headless verification harness.

import type { Colormap } from './colormap';
export interface FieldSample {
  p: number;
  tau: number;
  inside: boolean;
}

/** Anything that can be probed pointwise — a solution or a rotated view of one. */
export interface FieldSource {
  evalAt(x: number, y: number): FieldSample;
}

export interface Extent {
  cx: number;
  cy: number;
  halfWidth: number; // world half-width; the box is square
}

export interface FieldRange {
  pMin: number;
  pMax: number;
  tauMin: number;
  tauMax: number;
}

/**
 * Automatic color ranges: the actual extremes of the fields sampled on a
 * grid over the home view, rounded outward to two significant digits. The
 * pressure range is kept symmetric about zero so the diverging map stays
 * centred on p = 0 and the middle tick reads 0. Manual limits on the pages
 * override this when a user wants to stretch the far field.
 */
export function fieldRanges(sol: FieldSource, ext: Extent, n = 160): FieldRange {
  let pAbs = 0;
  let tauMax = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ext.cx + ((i + 0.5) / n - 0.5) * 2 * ext.halfWidth;
      const y = ext.cy + ((j + 0.5) / n - 0.5) * 2 * ext.halfWidth;
      const s = sol.evalAt(x, y);
      if (Number.isFinite(s.p) && Math.abs(s.p) > pAbs) pAbs = Math.abs(s.p);
      if (Number.isFinite(s.tau) && s.tau > tauMax) tauMax = s.tau;
    }
  }
  const pMax = niceNum(pAbs || 1e-12);
  return { pMin: -pMax, pMax, tauMin: 0, tauMax: niceNum(tauMax || 1e-12) };
}

/** Round up to 2 significant digits for clean colorbar labels. */
export function niceNum(v: number): number {
  if (!(v > 0)) return 1;
  const e = Math.floor(Math.log10(v));
  const f = v / 10 ** e;
  return Math.ceil(f * 10) / 10 * 10 ** e;
}

const LUT_N = 1024;

/** Precompute a colormap into an RGB lookup table (the OKLab math is too slow per pixel). */
export function colormapLut(map: Colormap): Uint8Array {
  const lut = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const [r, g, b] = map(i / (LUT_N - 1));
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

/**
 * Fills two RGBA buffers (pressure, tau) of size w*h*4.
 * World mapping: square extent, y up (row 0 = top = +y).
 */
export function renderFields(
  sol: FieldSource,
  ext: Extent,
  w: number,
  h: number,
  range: FieldRange,
  pLut: Uint8Array,
  tauLut: Uint8Array,
  pBuf: Uint8ClampedArray,
  tauBuf: Uint8ClampedArray,
): void {
  const scale = (2 * ext.halfWidth) / w;
  const clampIdx = (t: number) => Math.max(0, Math.min(LUT_N - 1, Math.round(t * (LUT_N - 1))));
  const pSpan = range.pMax - range.pMin || 1e-12;
  const tauSpan = range.tauMax - range.tauMin || 1e-12;
  for (let j = 0; j < h; j++) {
    const y = ext.cy + (h / 2 - (j + 0.5)) * scale;
    for (let i = 0; i < w; i++) {
      const x = ext.cx + ((i + 0.5) - w / 2) * scale;
      const s = sol.evalAt(x, y);
      const k = (j * w + i) * 4;

      const pi = clampIdx((s.p - range.pMin) / pSpan) * 3;
      pBuf[k] = pLut[pi]; pBuf[k + 1] = pLut[pi + 1]; pBuf[k + 2] = pLut[pi + 2]; pBuf[k + 3] = 255;

      const ti = clampIdx((s.tau - range.tauMin) / tauSpan) * 3;
      tauBuf[k] = tauLut[ti]; tauBuf[k + 1] = tauLut[ti + 1]; tauBuf[k + 2] = tauLut[ti + 2]; tauBuf[k + 3] = 255;
    }
  }
}
