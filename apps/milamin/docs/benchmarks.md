# Benchmark log: the browser solver across devices

Measurements of the MILAMIN web pipeline (Triangle mesh, 7-node
Crouzeix–Raviart assembly, sparse supernodal Cholesky in wasm,
Powell–Hestenes iterations) against the 2008 reference rate of one million
degrees of freedom per minute, total pipeline. Collected 2026-07-16 on the
live site (bench.html / million.html) and the Node twin
(`scripts/bench.ts`, `scripts/spbench.ts`). Raw sweep data:
`scripts/bench-results.json`.

The live chart plots the browser's assembly + factorization + pressure
iterations against two 2008 references: Table 2's 49 s assembly-plus-solution
at one million unknowns (the like-for-like point, used for the speed-up on
the million page) and Figure 5's total-time curve, digitized, whose scope is
slightly wider (the paper calls boundary conditions and post-processing
minor) but which is the only size-dependent reference. Meshing and rendering
remain in separately labelled pipeline totals. The problems and hardware
differ. Historical throughput numbers below describe the recorded browser
runs; they are not controlled speed-ups over the original benchmark.

Counting note (2026-09): the site now reports unknowns as MILAMIN 2008 did,
two per node with the bubble node included (2N + 2E). The numbers in this log
were recorded in the solver's own count, 2N after bubble condensation; the
"944k" runs are ~1.44 million in the 2008 count.

## Pixel 10, the million in 2008 counting (2026-09-18)

million.html at its default size, 1,000,158 unknowns counted as in 2008
(bubble node included; 166,263 elements, 667k nodal unknowns after
condensation), Chrome for Android, phone cool, one run each:

| threads | mesh | matrices & assembly | factorization | PH | render | total | 49 s / assembly + solution |
|---|---|---|---|---|---|---|---|
| 2 (default) | 185 ms | 1.5 s | 5.7 s | 1.8 s | 187 ms | **9.3 s** | 5.4× |
| 1 | 262 ms | 1.5 s | 5.3 s | 1.7 s | 185 ms | **9.0 s** | 5.8× |

An earlier 2-thread run gave 8.1 s and could not be reproduced: run-to-run
variance on the phone is ±10-15% (thermal state, background load), so quote
9 s. One thread and two are equal here, consistent with finding 5 below:
at this size one fast core already owns the memory bandwidth. The home page
quotes this run.

## Pixel 10 sweep, benchmark page (2026-09-22, 2 threads, 2008 counting)

bench.html on the Pixel 10, Chrome for Android, supernodal Cholesky (AMD),
2 threads (the phone default), unknowns in 2008 counting. One session up to
2.0 M, then the largest size on its own. This sweep is the phone curve
of Figure 1 of the paper.

| unknowns | elements | mesh | matrices & assembly | factorization | PH | total |
|---|---|---|---|---|---|---|
| 9,890 | 1,610 | 1 ms | 78 ms | 34 ms | 38 ms | 151 ms |
| 18,926 | 3,100 | 9 ms | 81 ms | 24 ms | 63 ms | 178 ms |
| 35,038 | 5,763 | 14 ms | 82 ms | 54 ms | 104 ms | 253 ms |
| 67,818 | 11,195 | 27 ms | 223 ms | 110 ms | 88 ms | 449 ms |
| 131,134 | 21,703 | 38 ms | 340 ms | 253 ms | 231 ms | 860 ms |
| 260,022 | 43,121 | 35 ms | 372 ms | 612 ms | 367 ms | 1.4 s |
| 510,230 | 84,733 | 54 ms | 707 ms | 1.7 s | 748 ms | 3.2 s |
| 1,009,078 | 167,748 | 87 ms | 1.6 s | 4.4 s | 1.6 s | 7.7 s |
| 1,996,706 | 332,174 | 201 ms | 2.9 s | 14.9 s | 3.4 s | 21.4 s |
| 2,498,358 | 415,711 | 230 ms | 3.3 s | 22.7 s | 7.3 s | 33.5 s |

Peak rate 260 k unknowns in 1.4 s, about 11 M/min. The million here is 7.7 s
for four stages against 9.3 s for five on million.html (2026-09-18 above):
the factorization was 4.4 s instead of 5.7 s. Three repeats of the million on
bench.html the same day (largest size only, 2 threads, 1,001,858 unknowns,
166,546 elements) gave

| mesh | matrices & assembly | factorization | PH | total |
|---|---|---|---|---|
| 90 ms | 1.4 s | 6.3 s | 1.8 s | 9.6 s |
| 95 ms | 1.4 s | 5.5 s | 1.7 s | 8.7 s |
| 84 ms | 1.4 s | 5.5 s | 1.8 s | 8.7 s |

so the sweep's 4.4 s was a fast outlier and the million.html table stands;
run-to-run spread on the factorization is up to ±20%, not ±10-15%.

Full ladder to 2.5 M in one session, same day, 2 threads (the phone curve of
Figure 1 of the paper, data/pixel10-sweep.tsv there):

| unknowns | elements | mesh | matrices & assembly | factorization | PH | total |
|---|---|---|---|---|---|---|
| 12,210 | 1,992 | 1 ms | 78 ms | 47 ms | 50 ms | 176 ms |
| 22,630 | 3,711 | 10 ms | 85 ms | 33 ms | 65 ms | 194 ms |
| 42,970 | 7,076 | 5 ms | 242 ms | 64 ms | 55 ms | 365 ms |
| 83,346 | 13,770 | 17 ms | 160 ms | 137 ms | 111 ms | 425 ms |
| 164,446 | 27,237 | 36 ms | 278 ms | 344 ms | 225 ms | 883 ms |
| 323,498 | 53,675 | 52 ms | 435 ms | 867 ms | 463 ms | 1.8 s |
| 635,030 | 105,497 | 56 ms | 868 ms | 2.4 s | 997 ms | 4.3 s |
| 1,259,594 | 209,450 | 108 ms | 1.8 s | 6.4 s | 2.0 s | 10.3 s |
| 2,498,358 | 415,711 | 229 ms | 3.5 s | 17.7 s | 4.3 s | 25.7 s |

Ladder vs standalone at 2.5 M: 25.7 s vs 33.5 s, factorization 17.7 vs
22.7 s, the other stages equal. bench.html starts a fresh worker per run, so
a standalone run pays for wasm memory growth to the factor's size and for
V8's tier-up of the wasm code inside the timed factorization; in a ladder
both are done by the time the top size runs. Ladders are the "warm" numbers
(Figure 1), largest-only runs the conservative ones (thread sweeps,
million.html).

## Devices

| device | year | cores/threads | memory | context |
|---|---|---|---|---|
| "dev laptop" (WSL2) | 2013 | 12 threads | quad-channel DDR3 | Node 24 (≈ Chrome V8) under WSL2 on the i7-4930K below; earlier entries called it a ~2021 DDR4 laptop, which was wrong (lscpu, 2026-09-21) |
| Intel i7-4930K | 2013 | 6C/12T (HT) | quad-channel DDR3 | the same machine, desktop browser on Windows |
| Google Pixel 10 (Tensor) | 2025 | 8 heterogeneous (big.LITTLE) | LPDDR5X | Chrome for Android |

## Headline results (~945k dofs, full pipeline: mesh + assembly + factorization + PH)

| device | config | total | rate |
|---|---|---|---|
| Pixel 10 | 2 threads | **12.3 s** | 4.6 M dofs/min |
| Pixel 10 | 1 thread | 13.3 s | 4.3 M dofs/min |
| i7-4930K | 4 threads | 22.6 s | 2.5 M dofs/min |
| dev laptop | 12 threads | 26.5 s | 2.1 M dofs/min |
| i7-4930K | 12 threads | 33.9 s | 1.7 M dofs/min |
| dev laptop | 1 thread | 38.7 s | 1.5 M dofs/min |
| i7-4930K, old backend (Eigen SimplicialLDLT) | 1 thread | 127.6 s | 0.44 M dofs/min |

Current-backend runs exceed the title-claim rate of one million unknowns per minute in their recorded counting; that is a throughput observation, not a matched benchmark comparison.
Peak measured rate: **7.7 M dofs/min at 123k dofs, Pixel 10, single-threaded.**
Largest solved: 1.87 M dofs in 64 s (dev laptop, 12 threads) inside wasm's
4 GB. All-inclusive million.html runs (adds field rendering): Pixel 10
16.5 s (2 threads, warm), i7-4930K 28.5 s, dev laptop 35.0 s (headless).

## Factorization thread scaling (Cholesky stage at ~945k dofs)

| threads | i7-4930K (mean of 3) | dev laptop (Node) | Pixel 10 |
|---|---|---|---|
| 1 | 24.2 s | 27.8 s | 8.7 s |
| 2 | — | — | 7.6 s |
| 3 | — | 23.6 s | — |
| 6 | 17.5 s | 19.9 s | — |
| 8 (static split, pre-fix) | — | — | 14.5 s |
| 8 (dynamic split) | — | — | 7.8 s |
| 12 | 14.9 s | 18.1 s | — |

## Controlled thread sweep, i7-4930K (2026-08-17, 944k dofs)

Back-to-back in one browser session with the bench page's "Largest size
only" option, three repeats per configuration; since 2026-08-17 selecting
1 thread runs the plain single-thread wasm build (no pthreads runtime)
rather than the threaded build capped at one thread.

| threads | Cholesky (median of 3) | total (best) | rate |
|---|---|---|---|
| 1 (single-thread build) | 23.6 s | 34.2 s | 1.7 M dofs/min |
| 2 | 15.7 s | 25.8 s | 2.2 M dofs/min |
| 4 | 12.3 s | 22.6 s | 2.5 M dofs/min |
| 6 | 12.1 s | 22.5 s | 2.5 M dofs/min |
| 12 | 15.2 s | 24.7 s | 2.3 M dofs/min |

- Sweet spot: 4 threads (1.9× on the factorization, 1.5× total); the last
  two physical cores add nothing, and hyperthreading (12) regresses ~20%
  below the 4-6 thread plateau. This revises finding 3 below, which was
  measured before the dynamic BLAS split.
- The pthreads build capped at 1 thread (24.2 s, July) matches the plain
  build (23.6 s): no measurable threading-runtime baseline penalty on this
  machine.
- Repeats are tight (Cholesky within ±5%); unlike the phone, the desktop
  does not throttle across consecutive runs. Assembly and PH stay ~5 s
  each regardless of thread count, which caps the total speedup (finding 7).
- Caution: one earlier same-day session on this machine showed a different
  stage split (assembly 10.9 s, Cholesky 12.2 s, total 30.5 s) that the
  controlled sweep could not reproduce; suspected stale browser-cached
  older build, from before the site served HTML with no-cache
  headers. Cross-session comparisons predating 2026-08-17 are unreliable.

## Controlled thread sweep, Pixel 10 (2026-08-17, 944k dofs)

Same protocol as the desktop sweep: "Largest size only", three repeats per
configuration, run in the order 1, 2, 8 threads.

| threads | Cholesky (median of 3) | total (best) | rate |
|---|---|---|---|
| 1 (single-thread build) | 9.9 s | 14.4 s | 3.9 M dofs/min |
| 2 | 8.6 s | 13.3 s | 4.3 M dofs/min |
| 8 | 10.2 s | 15.0 s | 3.8 M dofs/min |

- Confirms finding 5: the optimum stays at 2 threads, and the second thread
  buys ~13% on the factorization (~8% total). 8 threads is slower than 1
  even with the dynamic BLAS split.
- Finding 6 in action: the third 8-thread run throttled visibly, with every
  stage inflated (assembly 2.0 → 3.4 s, PH 2.4 → 4.7 s, total 22.1 s), and
  the 8-thread block also ran last, i.e. warmest. Warm-phone numbers sit
  ~10-15% above the July first-run values (2t Cholesky 8.6 s vs 7.6 s cool).
- The phone still beats every desktop configuration: its worst controlled
  run out-rates the 4930K's best (3.8 vs 2.5 M dofs/min).

## Findings

1. **The supernodal algorithm was the main win, not threads.** Replacing
   Eigen's simplicial LDLT with CHOLMOD's supernodal Cholesky cut the
   single-threaded factorization at 945k from 105.8 s to 27.7 s on the dev
   laptop (~3.8×): the flops move into dense BLAS3 kernels that wasm SIMD
   can vectorize.
2. **The workload is memory-bandwidth-bound at these sizes.** 2D problems
   have small supernodal fronts, so thread scaling is modest and follows the
   isoefficiency law documented in the original 2011 MILAMIN notes,
   E = f(n/ncores²): ~1.6× on 12 desktop threads at 1M dofs, nothing below
   ~123k dofs.
3. **Hyperthreading adds ~15% on the desktop** (6→12 threads on the 4930K):
   in a bandwidth-bound kernel the sibling thread hides memory stalls
   rather than competing for FP ports. *Revised 2026-08-17: with the
   dynamic 4×-block BLAS split, 12 threads regress ~20% below the 4-6
   thread plateau on the 4930K (15.2 s vs 12.1 s); see the controlled
   sweep above.*
4. **Heterogeneous mobile cores break static work splits.** With
   one-block-per-thread static OpenMP scheduling, 8 threads on the Pixel
   were 1.7× *slower* than one thread (14.5 s vs 8.7 s): every parallel
   region waited for a little core to finish the same-sized block as the
   prime core. Fixed by splitting into 4× more blocks than threads with
   dynamic scheduling (`wasm/blas_shim.cpp`); desktop timings unchanged.
5. **One flagship ARM core nearly saturates the phone's memory system.**
   The Pixel's optimum is 2 threads at every size, and the second thread
   buys only 10–15% in the factorization (~8% total). A single Tensor core
   factors as fast as 12 threads of the 2013 desktop, and the phone's
   single-threaded JS stages (assembly, PH, mesh) run ~3× faster than both
   desktops': per-core memory bandwidth, not FLOPS, sets the pace, and a
   2025 phone core commands more of it than a 2013 desktop had in total.
6. **Phones thermal-throttle across consecutive runs.** Factorization times
   in one Pixel session drifted 7.6 → 10.8 → 10.7 → 15.9 s on equal or
   easier configurations. Quotable numbers need cool-down pauses or
   first-run values. Desktop variance comes from background load instead
   (assembly, single-threaded TypeScript, varied 5.3–17 s at 944k on the
   4930K across runs).
7. **The factorization is no longer the whole story.** In the best
   configurations of the thread sweeps its share of the total is 54% on the
   desktop (4 threads, 12.3 / 22.6 s) and 65% on the phone (2 threads,
   8.6 / 13.3 s); the single-threaded stages take the rest, so the next
   optimization target on desktops is the TypeScript assembly, not the
   solver. (Earlier entries said 57% / 76% without a derivation.)

## Reproducing

- Browser: bench.html (choose size, threads, optionally the banded
  solvers), million.html for the all-inclusive single run.
- Node: `npx tsx scripts/bench.ts [--max-dofs N]` regenerates
  `scripts/bench-results.json`; `SPCHOL_THREADS=k npx tsx
  scripts/spbench.ts <scale...>` for quick single-case A/B runs;
  `SPCHOL_ST=1` forces the single-thread build.

## Node under WSL2: thread count and run-to-run variance (2026-09-21)

Same i7-4930K, machine otherwise idle (WSL2 load 0.3, 28 GB free), the
committed `bench-results.json` sweep (12 threads) as the reference:

| run | 1.44 M unknowns (2008 count): asm / chol / PH / total | 2.8 M: total |
|---|---|---|
| committed sweep, 12 threads | 6.2 / 13.7 / 6.3 / 26.5 s | 63.8 s |
| spbench single case, 4 threads | 5.3 / 15.6 / 4.7 / 26.1 s | – |
| spbench single case, 12 threads | 6.1 / 25.0 / 5.6 / 37.2 s | – |
| full sweep, 4 threads (busy afternoon) | 7.5 / 18.3 / 7.0 / 33.2 s | 92.9 s |
| full sweep, 4 threads (idle evening) | – / 14.1 / 8.0 / 34.1 s | 62.6 s |

- Twelve Node threads over-subscribe the six cores: the factorization took
  25 s against 15.6 s with four in back-to-back single cases, the same
  hyperthreading regression the browser sweep showed. The committed
  12-thread sweep's 13.7 s is therefore a favourable run.
- Run-to-run variance under Node in WSL2 is 20-30 % at 1.44 M even on an
  idle machine, and it hits the single-threaded stages too (PH 4.7 s and
  8.0 s within minutes, same size, same threads). A full sweep is also
  slower than a fresh single case at the same size, so garbage-collector
  state matters. Quote Node numbers as indicative; the browser sweeps with
  three repeats are the controlled ones.
- `bench.ts` now honours `SPCHOL_THREADS=k`.
