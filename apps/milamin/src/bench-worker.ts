// Web Worker for the benchmark page: runs the solver sweep at increasing
// resolution, posting one result row per solve so the page can chart progress
// live. Same code path as the interactive pages — no benchmark specials.
import wasmUrl from '@fem/vendor/triangle/triangle.out.wasm?url';
import spcholWasmUrl from '@fem/wasm/spchol.wasm?url';
import spcholMtWasmUrl from '@fem/wasm/spchol-mt.wasm?url';
import { initTriangle, buildMesh } from '@fem/trimesh';
import { initSpchol, spcholThreads } from '@fem/spchol';
import { solveStokesTri } from '@fem/stokesfem-tri';
import { solve as solveCircle } from '@ana/circle';
import { unknowns2008 } from '@fem/unknowns';

export interface BenchRequest {
  maxDofs: number;
  /** worker threads for the sparse factorization; default = hardware concurrency */
  threads?: number;
  /** also run the O(n^1.9) banded solvers (slow at the larger sizes) */
  includeBanded?: boolean;
  /** solve only the largest size; the smaller refinement levels are still
   *  meshed (cheap) to locate it, but not assembled or factorized */
  largestOnly?: boolean;
}

export interface BenchRow {
  solver: 'tri' | 'sparse';
  /** unknowns in 2008 counting: 2 per node, bubble node included */
  dofs: number;
  elements: number;
  hbw: number;
  meshMs: number;
  assembleMs: number;
  factorMs: number;
  phMs: number;
  totalMs: number;
  bandMB: number;
}

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

self.onmessage = async (ev: MessageEvent<BenchRequest>) => {
  const { maxDofs, threads, includeBanded, largestOnly } = ev.data;
  await initTriangle(wasmUrl);
  await initSpchol({ wasmUrl: spcholWasmUrl, mtWasmUrl: spcholMtWasmUrl, threads });
  postMessage({
    threads: spcholThreads(),
    isolated: typeof crossOriginIsolated === 'undefined' || crossOriginIsolated,
  });
  const exact = solveCircle({ m: 1000, er: 0, gr: 1 });
  // banded is O(n^2): cap it so the sparse sweep can go deeper
  const maxBanded = Math.min(maxDofs, 30_000);

  try {
    // unstructured Triangle meshes, 7-node Crouzeix-Raviart (MILAMIN's element)
    const backends = includeBanded ? (['banded', 'sparse'] as const) : (['sparse'] as const);
    for (const backend of backends) {
      const cap = backend === 'banded' ? maxBanded : maxDofs;
      // The refinement ladder ends on the requested size: unknowns scale as
      // 1/scale (7,298 at scale 1 in 2008 counting), so start from the
      // target's scale and halve the size step by step down to the coarsest
      // mesh, then run the ladder upwards. The largest run lands within a few
      // percent of the target instead of stopping wherever a doubling from
      // the coarsest mesh happens to fall.
      const meshAt = (scale: number) =>
        buildMesh({
          boundaries: [
            { pts: circlePts(2.5, Math.round(96 / Math.sqrt(scale))), marker: 1 },
            { pts: circlePts(1, Math.round(64 / Math.sqrt(scale))), marker: 2 },
          ],
          regions: [
            [0, 0, 2, 0.02 * scale],
            [1.75, 0, 1, 0.04 * scale],
          ],
        });
      const countOf = (m: ReturnType<typeof buildMesh>) => unknowns2008(2 * m.nNodes, m.nTri);
      // unknowns grow as scale^-0.95 (7,298 at scale 1); estimate the target's
      // scale, mesh it once to see where it lands and correct
      const P = 0.95;
      let scaleTarget = (7298 / cap) ** (1 / P);
      postMessage({ stage: 'mesh' });
      scaleTarget *= (countOf(meshAt(scaleTarget)) / cap) ** (1 / P);
      const steps = Math.max(0, Math.floor(Math.log2(1 / scaleTarget)));
      const ladder = Array.from({ length: steps + 1 }, (_, i) => scaleTarget * 2 ** (steps - i));
      for (const scale of largestOnly ? ladder.slice(-1) : ladder) {
        postMessage({ stage: 'mesh' });
        const t0 = performance.now();
        const mesh = meshAt(scale);
        const meshMs = performance.now() - t0;
        const count = countOf(mesh);
        const fem = solveStokesTri({
          mesh,
          muOfAttr: (a) => (a === 2 ? 1000 : 1),
          bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
          backend,
          onStage: (stage) => postMessage({ stage, dofs: count }),
        });
        const row: BenchRow = {
          solver: backend === 'banded' ? 'tri' : 'sparse',
          dofs: unknowns2008(fem.dofs, fem.elements),
          elements: fem.elements,
          hbw: backend === 'banded' ? fem.halfBandwidth : fem.nnzL,
          meshMs,
          assembleMs: fem.assembleMs,
          factorMs: fem.factorMs,
          phMs: fem.phMs,
          totalMs: meshMs + fem.assembleMs + fem.factorMs + fem.phMs,
          bandMB:
            backend === 'banded'
              ? (fem.dofs * (fem.halfBandwidth + 1) * 8) / 1e6
              : (fem.nnzL * 12) / 1e6,
        };
        postMessage({ row });
      }
    }

    postMessage({ done: true });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
