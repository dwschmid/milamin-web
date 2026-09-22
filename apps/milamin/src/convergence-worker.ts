// Web Worker for the convergence lab: solve the circular-inclusion benchmark
// on a sequence of uniformly refined meshes, measure the true error against
// the analytical solution at each level, and finally transfer the finest
// solution so the page can map where the error lives.
import wasmUrl from '@fem/vendor/triangle/triangle.out.wasm?url';
import spcholWasmUrl from '@fem/wasm/spchol.wasm?url';
import spcholMtWasmUrl from '@fem/wasm/spchol-mt.wasm?url';
import { initTriangle } from '@fem/trimesh';
import { initSpchol, spcholThreads } from '@fem/spchol';
import type { StokesTriCore } from '@fem/stokesfem-tri';
import { exactSolution, meshLevel, solveLevel, levelErrors } from './convergence-study';

export interface ConvergenceRequest {
  /** worker threads for the factorization; default = hardware concurrency */
  threads?: number;
  /** refinement levels (default 5) */
  levels?: number;
}

export interface LevelRow {
  level: number;
  /** representative element size, sqrt(matrix maxArea) */
  h: number;
  dofs: number;
  elements: number;
  /** relative L2 velocity error against the analytical solution, integrated
   *  over the mesh with the element quadrature rule */
  errV: number;
  /** relative L2 max-shear-stress error, same norm */
  errTau: number;
  /** share of the squared stress error that lives in the polygon-circle sliver */
  sliverShareTau: number;
  solveMs: number;
}

export type ConvergenceMessage =
  | { threads: number; isolated: boolean }
  | { level: number; of: number }
  | { row: LevelRow }
  | { core: StokesTriCore }
  | { error: string };

self.onmessage = async (ev: MessageEvent<ConvergenceRequest>) => {
  const post = postMessage as (msg: ConvergenceMessage, transfer?: Transferable[]) => void;
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

    const exact = exactSolution();
    const levels = ev.data.levels ?? 5;
    let finest: StokesTriCore | null = null;

    for (let k = 0; k < levels; k++) {
      post({ level: k + 1, of: levels });
      const t0 = performance.now();
      const { mesh, area } = meshLevel(k);
      const sol = solveLevel(mesh, exact);
      const solveMs = performance.now() - t0;
      const err = levelErrors(sol, k, exact);
      post({
        row: {
          level: k,
          h: Math.sqrt(area),
          dofs: sol.dofs + 2 * sol.elements, // 2008 counting
          elements: sol.elements,
          errV: err.errV,
          errTau: err.errTau,
          sliverShareTau: err.sliverShareTau,
          solveMs,
        },
      });
      if (k === levels - 1) {
        const { evalAt: _e, ...core } = sol;
        finest = core;
      }
    }

    if (finest) {
      post({ core: finest }, [
        finest.nodeX.buffer,
        finest.nodeY.buffer,
        finest.tri6.buffer,
        finest.triMu.buffer,
        finest.u.buffer,
        finest.ub.buffer,
        finest.elP.buffer,
        finest.elCx.buffer,
        finest.elCy.buffer,
        finest.elH.buffer,
      ]);
    }
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
