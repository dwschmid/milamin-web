// TypeScript wrapper around the CHOLMOD supernodal wasm module
// (wasm/spchol.cpp): factor a lower-triangular CSC matrix once, then solve
// repeatedly in place — the shape Powell-Hestenes iterations need.
//
// Two artifacts exist: spchol.js (single-thread, runs everywhere) and
// spchol-mt.js (pthreads + OpenMP BLAS). The threaded one needs
// SharedArrayBuffer, which browsers only hand out on cross-origin isolated
// pages (COOP/COEP headers); initSpchol picks automatically.

interface SpcholModule {
  _spchol_factor(n: number, ap: number, ai: number, ax: number): number;
  _spchol_solve(handle: number, b: number): void;
  _spchol_nnzL(handle: number): number;
  _spchol_free(handle: number): void;
  _spchol_threads(t: number): void;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
}

let mod: SpcholModule | null = null;
let activeThreads = 1;

export interface SpcholInitOpts {
  /** vite `?url` of spchol.wasm (single-thread artifact) */
  wasmUrl?: string;
  /** vite `?url` of spchol-mt.wasm (threaded artifact) */
  mtWasmUrl?: string;
  /**
   * worker threads for the BLAS kernels; default = hardware concurrency.
   * An explicit 1 loads the plain single-thread build: the pthreads build
   * pays a large baseline penalty on some machines (bounds-checked shared
   * memory, allocator atomics), so capping it at one thread is never what
   * the caller wants.
   */
  threads?: number;
  /** force the single-thread build even when threads are available */
  forceSingleThread?: boolean;
}

/** True when the environment can run the pthreads build. */
export function spcholCanThread(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated)
  );
}

/** Load the wasm module once (pass the vite `?url` assets in the browser). */
export async function initSpchol(opts: SpcholInitOpts | string = {}): Promise<void> {
  if (mod) return;
  const o: SpcholInitOpts = typeof opts === 'string' ? { wasmUrl: opts } : opts;
  if (spcholCanThread() && !o.forceSingleThread && o.threads !== 1) {
    // Safari in particular can fail to instantiate or grow the large shared
    // memory the pthreads build reserves; fall back to the single-thread
    // module instead of failing the whole solve.
    try {
      const create = (await import('./wasm/spchol-mt.js')).default;
      const mtUrl = o.mtWasmUrl;
      mod = (await create(mtUrl ? { locateFile: () => mtUrl } : {})) as SpcholModule;
      const hw =
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency
          ? navigator.hardwareConcurrency
          : 4;
      activeThreads = Math.max(1, o.threads ?? hw);
      mod._spchol_threads(activeThreads);
      return;
    } catch {
      mod = null;
    }
  }
  const create = (await import('./wasm/spchol.js')).default;
  const stUrl = o.wasmUrl;
  mod = (await create(stUrl ? { locateFile: () => stUrl } : {})) as SpcholModule;
  activeThreads = 1;
}

export function spcholReady(): boolean {
  return mod !== null;
}

/** Threads the factorization kernels use (1 for the single-thread build). */
export function spcholThreads(): number {
  return activeThreads;
}

export interface SpcholFactor {
  solveInPlace(b: Float64Array): void;
  nnzL(): number;
  free(): void;
}

/**
 * Factor the symmetric positive definite matrix given as LOWER-triangular CSC.
 * Throws if the module is not initialized or the factorization fails.
 */
export function spcholFactor(
  n: number,
  Ap: Int32Array,
  Ai: Int32Array,
  Ax: Float64Array,
): SpcholFactor {
  if (!mod) throw new Error('spchol: call initSpchol() first');
  const m = mod;
  const nnz = Ap[n];
  const pAp = m._malloc(4 * (n + 1));
  const pAi = m._malloc(4 * nnz);
  const pAx = m._malloc(8 * nnz);
  m.HEAP32.set(Ap.subarray(0, n + 1), pAp >>> 2);
  m.HEAP32.set(Ai.subarray(0, nnz), pAi >>> 2);
  m.HEAPF64.set(Ax.subarray(0, nnz), pAx >>> 3);
  const handle = m._spchol_factor(n, pAp, pAi, pAx);
  m._free(pAp);
  m._free(pAi);
  m._free(pAx);
  if (!handle) throw new Error('spchol: factorization failed (matrix not SPD?)');
  const pB = m._malloc(8 * n);
  let freed = false;
  return {
    solveInPlace(b: Float64Array) {
      m.HEAPF64.set(b, pB >>> 3);
      m._spchol_solve(handle, pB);
      b.set(m.HEAPF64.subarray(pB >>> 3, (pB >>> 3) + n));
    },
    nnzL: () => m._spchol_nnzL(handle),
    free() {
      if (freed) return;
      freed = true;
      m._free(pB);
      m._spchol_free(handle);
    },
  };
}
