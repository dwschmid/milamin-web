// Solver thread defaults shared by the pages that run the sparse backend.
//
// 2D Stokes problems have small supernodal fronts, so the factorization is
// memory-bandwidth-bound and gains little beyond a few threads; past the
// sweet spot extra threads regress (docs/benchmarks.md: the 2013 desktop
// plateaus at 4 threads and loses ~20% with all 12, the 2025 phone is best
// at 2). Hardware concurrency is therefore the upper bound, not the default.

export const hardwareThreads = navigator.hardwareConcurrency || 4;

/** Phones: big.LITTLE cores and one fast core owning the memory bandwidth
 *  made two threads the optimum on the phone we measured, and more threads
 *  slower. The hint is the platform's own, with a user-agent fallback. */
const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
export const isMobile: boolean =
  nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/** default thread count for a page: min(cap, hardware threads), two on a phone */
export function defaultThreads(cap: number): number {
  return Math.max(1, Math.min(isMobile ? Math.min(2, cap) : cap, hardwareThreads));
}

/** fill a thread select with 1 .. hardware threads, the default selected, and
 *  a tooltip explaining the cap (a select, not a number box: typing a number
 *  into a small field on a phone was the hard part) */
export function initThreadInput(select: HTMLSelectElement, cap: number): void {
  select.replaceChildren();
  for (let n = 1; n <= hardwareThreads; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === 1 ? '1 thread' : `${n} threads`;
    select.appendChild(opt);
  }
  select.value = String(defaultThreads(cap));
  select.title =
    `Default ${defaultThreads(cap)} of ${hardwareThreads} available: 2D factorizations ` +
    'are bandwidth-bound and rarely gain beyond a few threads' +
    (isMobile ? '; on phones two threads were the fastest setting measured' : '') +
    ' (see the benchmark page)';
}

/** the thread count to request from the worker for the current selection */
export function readThreads(select: HTMLSelectElement, cap: number): number {
  return Math.max(1, Math.min(hardwareThreads, Number(select.value) || defaultThreads(cap)));
}
