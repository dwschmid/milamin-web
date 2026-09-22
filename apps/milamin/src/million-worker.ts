// Web Worker for the million-dof showcase: one circular-inclusion Stokes
// problem at the requested size, solved with the sparse supernodal backend,
// reporting each pipeline stage as it starts so the page can show live
// progress. The solved core is transferred back for rendering.
import wasmUrl from '@fem/vendor/triangle/triangle.out.wasm?url';
import spcholWasmUrl from '@fem/wasm/spchol.wasm?url';
import spcholMtWasmUrl from '@fem/wasm/spchol-mt.wasm?url';
import { initTriangle, buildMesh } from '@fem/trimesh';
import { initSpchol, spcholThreads } from '@fem/spchol';
import { solveStokesTri, StokesTriCore } from '@fem/stokesfem-tri';
import { solve as solveCircle } from '@ana/circle';
import { nodalTargetFor2008 } from '@fem/unknowns';

export interface MillionRequest {
  /** wanted size in 2008 counting (bubble unknowns included) */
  targetDofs: number;
  /** worker threads for the factorization; default = hardware concurrency */
  threads?: number;
}

export type MillionMessage =
  | { threads: number; isolated: boolean }
  | { stage: 'mesh' | 'assemble' | 'factor' | 'ph' }
  | { core: StokesTriCore; meshMs: number }
  | { error: string };

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

self.onmessage = async (ev: MessageEvent<MillionRequest>) => {
  const post = postMessage as (msg: MillionMessage, transfer?: Transferable[]) => void;
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

    // empirical: this geometry yields ~3700/scale nodal dofs
    const scale = 3700 / nodalTargetFor2008(ev.data.targetDofs);
    const exact = solveCircle({ m: 1000, er: 0, gr: 1 });

    post({ stage: 'mesh' });
    const t0 = performance.now();
    const mesh = buildMesh({
      boundaries: [
        { pts: circlePts(2.5, Math.round(96 / Math.sqrt(scale))), marker: 1 },
        { pts: circlePts(1, Math.round(64 / Math.sqrt(scale))), marker: 2 },
      ],
      regions: [
        [0, 0, 2, 0.02 * scale],
        [1.75, 0, 1, 0.04 * scale],
      ],
    });
    const meshMs = performance.now() - t0;

    const sol = solveStokesTri({
      mesh,
      muOfAttr: (a) => (a === 2 ? 1000 : 1),
      bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
      backend: 'sparse',
      onStage: (stage) => post({ stage }),
    });
    const { evalAt: _e, ...core } = sol;
    post({ core, meshMs }, [
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
    post({ error: String(err) });
  }
};
