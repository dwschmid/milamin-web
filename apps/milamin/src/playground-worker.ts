// Web Worker for the model playground: evaluate the user's model definition
// (a JS function body returning { mesh, mu, bc }), mesh it with Triangle,
// solve Stokes with the requested backend, and post the solved core plus the
// input geometry for outline drawing. The user's code runs here, inside the
// worker, so a runaway model can be stopped by terminating the worker.
import wasmUrl from '@fem/vendor/triangle/triangle.out.wasm?url';
import spcholWasmUrl from '@fem/wasm/spchol.wasm?url';
import spcholMtWasmUrl from '@fem/wasm/spchol-mt.wasm?url';
import { initTriangle, buildMesh, findBoundaryCrossing, MeshSpec } from '@fem/trimesh';
import { initSpchol, spcholThreads } from '@fem/spchol';
import { solveStokesTri, StokesTriCore } from '@fem/stokesfem-tri';

export interface PlaygroundRequest {
  code: string;
  /** worker threads for the factorization; default = hardware concurrency */
  threads?: number;
}

/** polyline in world coordinates, drawn dashed over the fields */
export interface Outline {
  X: Float64Array;
  Y: Float64Array;
}

export type PlaygroundMessage =
  | { threads: number; isolated: boolean }
  | { stage: 'mesh' | 'assemble' | 'factor' | 'ph' }
  | { core: StokesTriCore; meshMs: number; outlines: Outline[]; view?: [number, number, number] }
  | { error: string };

/** hard cap so a stray maxArea cannot lock the browser tab for good */
const MAX_DOFS = 3_000_000; // in 2008 counting, bubble unknowns included

// --- geometry helpers available to model code -------------------------------

function circle(cx: number, cy: number, r: number, n = 64): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n = 64,
  angleDeg = 0,
): Array<[number, number]> {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca]);
  }
  return pts;
}

function rect(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

// --- model evaluation --------------------------------------------------------

interface Model {
  mesh: MeshSpec;
  mu: (attr: number) => number;
  bc: (marker: number, x: number, y: number) => [number, number] | null;
  /** optional initial view [cx, cy, halfWidth]; default frames the whole model */
  view?: [number, number, number];
}

function evalModel(code: string): Model {
  let raw: unknown;
  try {
    const factory = new Function('circle', 'ellipse', 'rect', `'use strict';\n${code}`);
    raw = factory(circle, ellipse, rect);
  } catch (err) {
    throw new Error(`model code failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('the model code must end with `return { mesh, mu, bc }`');
  }
  const m = raw as Record<string, unknown>;
  const mesh = m.mesh as MeshSpec | undefined;
  if (!mesh || typeof mesh !== 'object') throw new Error('model.mesh is missing');
  mesh.boundaries ??= [];
  if (!mesh.boundaries.length && !(mesh.points?.length && mesh.segments?.length)) {
    throw new Error('model.mesh needs `boundaries` (closed polylines) or `points` + `segments`');
  }
  if (!Array.isArray(mesh.regions) || !mesh.regions.length) {
    throw new Error('model.mesh.regions needs at least one seed: [x, y, attribute, maxArea]');
  }
  let mu: Model['mu'];
  if (typeof m.mu === 'function') mu = m.mu as Model['mu'];
  else if (typeof m.mu === 'number') mu = () => m.mu as number;
  else if (m.mu === undefined) mu = () => 1;
  else throw new Error('model.mu must be a function (attr) => viscosity, or a number');
  if (typeof m.bc !== 'function') {
    throw new Error('model.bc must be a function (marker, x, y) => [vx, vy] | null');
  }
  const hit = findBoundaryCrossing(mesh);
  if (hit) {
    throw new Error(
      `${hit.a} and ${hit.b} cross near (${hit.x.toFixed(3)}, ${hit.y.toFixed(3)}): boundaries ` +
        'may not intersect or touch each other; inclusions must lie fully inside the box and apart',
    );
  }
  const rawBc = m.bc as (marker: number, x: number, y: number) => unknown;
  const bc: Model['bc'] = (marker, x, y) => {
    const v = rawBc(marker, x, y);
    if (v === null || v === undefined) return null;
    if (Array.isArray(v) && v.length === 2) return [Number(v[0]), Number(v[1])];
    throw new Error('bc must return [vx, vy] (NaN component = free slip) or null');
  };
  let view: Model['view'];
  if (m.view !== undefined) {
    const v = m.view as unknown;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x))) || Number(v[2]) <= 0) {
      throw new Error('model.view must be [cx, cy, halfWidth] with halfWidth > 0');
    }
    view = [Number(v[0]), Number(v[1]), Number(v[2])];
  }
  return { mesh, mu, bc, view };
}

function outlinesOf(mesh: MeshSpec): Outline[] {
  const out: Outline[] = [];
  for (const b of mesh.boundaries) {
    const n = b.pts.length;
    const X = new Float64Array(n + 1);
    const Y = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      X[i] = b.pts[i % n][0];
      Y[i] = b.pts[i % n][1];
    }
    out.push({ X, Y });
  }
  for (const [a, b] of mesh.segments ?? []) {
    const pa = mesh.points![a];
    const pb = mesh.points![b];
    out.push({ X: Float64Array.of(pa[0], pb[0]), Y: Float64Array.of(pa[1], pb[1]) });
  }
  return out;
}

self.onmessage = async (ev: MessageEvent<PlaygroundRequest>) => {
  const post = postMessage as (msg: PlaygroundMessage, transfer?: Transferable[]) => void;
  try {
    await initTriangle(wasmUrl);
    await initSpchol({
      wasmUrl: spcholWasmUrl,
      mtWasmUrl: spcholMtWasmUrl,
      threads: ev.data.threads,
    });
    post({
      threads: spcholThreads(),
      isolated: typeof crossOriginIsolated === 'undefined' || crossOriginIsolated,
    });

    const model = evalModel(ev.data.code);

    post({ stage: 'mesh' });
    const t0 = performance.now();
    const mesh = buildMesh(model.mesh);
    const meshMs = performance.now() - t0;
    if (2 * mesh.nNodes + 2 * mesh.nTri > MAX_DOFS) {
      throw new Error(
        `mesh too large (~${(2 * mesh.nNodes + 2 * mesh.nTri).toLocaleString('en')} unknowns > ` +
          `${MAX_DOFS.toLocaleString('en')} cap) — increase the maxArea values in regions`,
      );
    }

    const sol = solveStokesTri({
      mesh,
      muOfAttr: model.mu,
      bc: model.bc,
      backend: 'sparse',
      onStage: (stage) => post({ stage }),
    });
    const { evalAt: _e, ...core } = sol;
    post({ core, meshMs, outlines: outlinesOf(model.mesh), view: model.view }, [
      core.nodeX.buffer,
      core.nodeY.buffer,
      core.tri6.buffer,
      core.triMu.buffer,
      core.u.buffer,
      core.ub.buffer,
      core.elP.buffer,
      core.elCx.buffer,
      core.elCy.buffer,
      core.elH.buffer,
    ]);
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
