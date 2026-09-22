// Web Worker running the folding/boudinage simulation: initialize the wasm
// modules, then march the Heun remesh-solve loop, posting one frame per
// completed step so the page can animate while the run is still going.
// Frame n carries the solution at time t_n; it is posted after the step that
// consumed it, so its typed arrays can be transferred instead of copied.
import wasmUrl from '@fem/vendor/triangle/triangle.out.wasm?url';
import spcholWasmUrl from '@fem/wasm/spchol.wasm?url';
import spcholMtWasmUrl from '@fem/wasm/spchol-mt.wasm?url';
import { initTriangle } from '@fem/trimesh';
import { initSpchol, spcholThreads } from '@fem/spchol';
import { StokesTriCore } from '@fem/stokesfem-tri';
import { Face, SimState, initialState, amplitude } from './geometry';
import { SimParams, SolveOut, solveState, stepHeun, timeSpan } from './sim';

export interface FoldingRequest {
  params: SimParams;
  /** worker threads for the factorization; default = hardware concurrency */
  threads?: number;
}

export interface FoldingFrame {
  step: number;
  nSteps: number;
  /** logarithmic strain */
  t: number;
  /** shortening or extension in percent */
  strain: number;
  halfW: number;
  halfH: number;
  /** interface polylines, bottom to top; two per layer */
  faces: Face[];
  /** fold/pinch amplitude (mean half peak-to-peak over the interfaces) */
  amplitude: number;
  core: StokesTriCore;
  meshMs: number;
  picardIterations: number;
  /** relative viscosity change of the last Picard iteration */
  picardChange: number;
  /** meshing and every Stokes solve of this step, wall time */
  solveMs: number;
  /** instantaneous amplitude growth rate dlnA/dt of the top interface from
   *  this step's velocity field (peak minus trough velocity over twice the
   *  amplitude); the quantity the analytical growth rates predict */
  growthRate: number;
}

export type FoldingMessage =
  | { booted: true }
  | { threads: number; isolated: boolean }
  | { frame: FoldingFrame }
  | { progress: { step: number; nSteps: number; phase: 'mesh' | 'solve'; iteration: number } }
  | { done: true; totalMs: number }
  | { error: string };

const post = postMessage as (msg: FoldingMessage, transfer?: Transferable[]) => void;

/** dlnA/dt of the top interface: the vertical velocity difference between
 *  its highest and lowest node over twice its half peak-to-peak amplitude */
function instantaneousGrowth(state: SimState, s: SolveOut): number {
  const top = state.faces[state.faces.length - 1];
  let iMax = 0, iMin = 0;
  for (let i = 1; i < top.Y.length; i++) {
    if (top.Y[i] > top.Y[iMax]) iMax = i;
    if (top.Y[i] < top.Y[iMin]) iMin = i;
  }
  const A = (top.Y[iMax] - top.Y[iMin]) / 2;
  if (!(A > 0)) return NaN;
  const vMax = s.evalAt(top.X[iMax], top.Y[iMax])?.v;
  const vMin = s.evalAt(top.X[iMin], top.Y[iMin])?.v;
  if (vMax === undefined || vMin === undefined) return NaN;
  return (vMax - vMin) / 2 / A;
}

function postFrame(step: number, p: SimParams, state: SimState, s: SolveOut, halfW0: number) {
  const frame: FoldingFrame = {
    step,
    nSteps: p.nSteps,
    t: state.t,
    // shortening: 1 - W/W0, extension: W/W0 - 1, both as positive percent
    strain: 100 * Math.abs(state.halfW / halfW0 - 1),
    halfW: state.halfW,
    halfH: state.halfH,
    faces: state.faces.map((f) => ({ X: f.X.slice(), Y: f.Y.slice() })),
    amplitude: amplitude(state),
    core: s.core,
    meshMs: s.meshMs,
    picardIterations: s.picardIterations,
    picardChange: s.picardChange,
    solveMs: s.solveMs,
    growthRate: instantaneousGrowth(state, s),
  };
  const transfer: Transferable[] = [
    frame.core.nodeX.buffer,
    frame.core.nodeY.buffer,
    frame.core.tri6.buffer,
    frame.core.triMu.buffer,
    frame.core.u.buffer,
    frame.core.ub.buffer,
    frame.core.elP.buffer,
    frame.core.elCx.buffer,
    frame.core.elCy.buffer,
    frame.core.elH.buffer,
  ];
  for (const f of frame.faces) transfer.push(f.X.buffer, f.Y.buffer);
  post({ frame }, transfer);
}

self.onmessage = async (ev: MessageEvent<FoldingRequest>) => {
  try {
    // before any wasm loading, so the page can tell a dead worker script
    // from a failing wasm fetch
    post({ booted: true });
    const p = ev.data.params;
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

    const t0 = performance.now();
    const dt = timeSpan(p.strainPct, p.mode) / p.nSteps;
    let state = initialState(p);
    const halfW0 = state.halfW;
    let current = 0;
    p.onProgress = (phase, iteration) =>
      post({ progress: { step: current, nSteps: p.nSteps, phase, iteration } });
    // each step's Picard iteration starts from the previous solve's strain
    // rates (the corrector's evaluator survives the frame transfer)
    const warm: { evalAt?: SolveOut['evalAt'] } = {};
    for (let step = 0; step < p.nSteps; step++) {
      current = step;
      const s1 = solveState(state, p, warm.evalAt);
      const prev = state;
      state = stepHeun(state, p, dt, s1, warm); // consumes s1.evalAt
      postFrame(step, p, prev, s1, halfW0);
      // let queued messages and GC breathe between steps
      await new Promise((r) => setTimeout(r, 0));
    }
    current = p.nSteps;
    const sFinal = solveState(state, p, warm.evalAt);
    postFrame(p.nSteps, p, state, sFinal, halfW0);
    post({ done: true, totalMs: performance.now() - t0 });
  } catch (err) {
    post({ error: String(err) });
  }
};
