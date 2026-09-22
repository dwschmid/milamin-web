# MilAMin – Million A Minute

The revival of [milamin.org](http://milamin.org): MILAMIN, the fast MATLAB finite
element solver for Earth science (Dabrowski, Krotkiewski & Schmid 2008,
[doi:10.1029/2007GC001719](https://doi.org/10.1029/2007GC001719)), brought to the
modern web — the original package and its record, plus the solver strategies
re-implemented to run live in the browser.

## Site chrome

Since 2026-09 the site is a conventional website with a menu, modelled on
bergwerk.com's layout language (sticky header with brand and right-aligned
menu, one dropdown, mono eyebrows, quiet cards on a warm ground, arrow
links, a three-column footer) in MilAMin's own palette, keyed to
the red 1e6/1 road sign. Pieces:

- `site-chrome.ts`: Vite plugin that injects the header (menu, current page
  marked from the filename) and the footer at `<!-- site:header -->` and
  `<!-- site:footer -->` in every page, dev and build. The menu lives in its
  `MENU` table; add a page there and in `vite.config.ts`.
- `src/site.ts`: every page entry imports this first (shared `@viz/styles.css`,
  then `src/site.css`); it also closes the mobile menu after a tap.
- `src/site.css`: tokens (light + dark), self-hosted OFL fonts (Schibsted
  Grotesk variable, IBM Plex Mono 400/500 in `src/fonts/`), header/menu
  (CSS-only burger and sub-menu toggles, as on bergwerk.com), home sections,
  footer, and restyles of the page headers (`nav.crumbs` is now the eyebrow).
- `index.html` is the home: hero with the million thumbnail (the buttons and
  the facts strip under it were dropped 2026-09-20), the four browser cards, the original-MILAMIN band, fine
  print. `about/` holds About, how it works, the personal note and the
  licenses; the chrome plugin derives each page's depth for its links.

## Pages

- `index.html` — home (see Site chrome above): the four browser cards in
  narrative order — million (the claim), bench (the proof), playground (the
  tool), convergence lab (the check) — the original MILAMIN band, a sources &
  acknowledgements note.
- `about/index.html` — the two stories (2008 package, 2026 browser), the people with
  then/now affiliations, what it is built on.
- `million.html` — the 2008 claim as one click: a ~1M-dof circular-inclusion
  Stokes problem meshed, assembled, factorized (sparse supernodal backend),
  iterated and rendered live, with per-stage timings; problem size and solver
  thread count selectable.
- `bench.html` — live benchmark: runs the solver at increasing size in a Web
  Worker and plots total time against unknowns, with MILAMIN 2008's own
  curve for comparison: the mechanical test problem's total time from the
  paper's Figure 5, digitized (7 points, 6.4e4 to 3.9e6 unknowns, slope ≈1.1
  in log-log), its million point 49 s = Table 2's 15 s matrices+assembly +
  34 s solve on an AMD Opteron with MATLAB 2007a. Not a constant-rate line,
  nothing extrapolated; the 2008 test problem differed (box with a hole,
  10× inclusion, pure shear), which the page says. Timed: mesh, element
  matrices & assembly, factorization, Powell–Hestenes; post-processing is not
  included, unlike the 2008 minute (the page says so). Solver thread count is
  selectable (1 = the plain single-thread wasm build, no pthreads runtime);
  the banded Cholesky comparison is off by default (checkbox, ≤30k unknowns;
  the structured Q2–P1 series was dropped 2026-09: different mesh sizes made
  it incomparable), and "Largest size only" meshes the refinement ladder
  without solving it, then solves just the final size — the status line
  narrates the probe and the pipeline stages with elapsed seconds.
  Counting (2026-09): the pages report unknowns as MILAMIN 2008 did, two per
  node with the bubble node included (`@fem/unknowns`, 2N + 2E ≈ 1.5 × 2N);
  the solver's own `dofs` is 2N after bubble condensation, and the reference
  numbers below are in that solver count.
  Reference run (WSL2, 12 threads, Node 24 ≈ Chrome V8): banded Cholesky
  ~3×10⁵ dofs/min at 5k dofs, falling as n⁻⁰·⁹ (O(n¹·⁹) total); the sparse
  supernodal wasm backend runs at 1.8–3.5×10⁶ dofs/min at every size — above
  the 2008 line throughout: 945k dofs in 26.5 s (38.7 s single-threaded),
  1.87M dofs in 64 s within wasm's 4 GB. See `scripts/bench-results.json`,
  regenerate with `npx tsx scripts/bench.ts` (add `SPCHOL_ST=1` for the
  single-thread build). Thread scaling at these sizes is modest, as the 2011
  isoefficiency study on this site's notes page predicts for 2D problems;
  the big win over the earlier Eigen SimplicialLDLT backend (945k in 121 s)
  is the supernodal algorithm itself. Cross-device measurements (2013
  desktop, 2021 laptop, 2025 phone) and the findings behind them — including
  the big.LITTLE scheduling fix and the phone thermal caveat — are in
  [docs/benchmarks.md](docs/benchmarks.md).
- `playground.html` — make your own model, the browser answer to downloading
  MILAMIN and editing the MATLAB: a JS model definition (`{ mesh, mu, bc }` —
  PSLG geometry with region seeds, viscosity per attribute, Dirichlet/free-slip
  velocities per boundary marker) is evaluated inside the worker, checked for
  crossing/touching boundaries (`findBoundaryCrossing` in fem-core: an
  inclusion through the box or two overlapping grains is a clear error, not
  a sliver mesh), meshed, solved (sparse backend, ~3M-unknown cap in 2008 counting) and rendered
  like the million page. Helpers `rect`/`circle`/`ellipse` are in scope; an
  optional `view: [cx, cy, halfWidth]` sets the initial view (2026-09-21),
  the automatic colour range being the actual extremes of the fields inside
  the view (`fieldRanges` in @viz/render, no percentile clipping any more).
  Presets: benchmark inclusion (box half-width 10, ten radii, `view` ±3: at
  2.5 radii the rigid-shear walls doubled the interface pressure to ±4, at
  10 the FEM gives ±2.2 against the analytical 2.0), ellipse swarm (draws
  until all 16 are placed, bounding-circle separation), multilayer
  (points+segments PSLG). One saved
  slot in localStorage, never overwritten silently: edits of "My model (saved
  locally)" autosave; editing a preset or an opened share link while a custom
  model is saved shows as "Unsaved edits" with a "Save as my model" button.
  "Share link" copies a URL with the model base64url-encoded in `#model=`.
  `?autorun[=preset]` runs on load (demos, headless tests); `npx tsx
  scripts/playtest.ts` solves all presets under Node and exercises the
  crossing check. Solver threads default to 2 (million/bench/convergence: 4;
  `src/threads.ts`) — 2D factorizations gain nothing beyond that and regress
  at full hardware concurrency. Limits stated on the page: linear Stokes, no
  body force, no time stepping.
- `convergence.html` — the convergence lab: the inclusion benchmark solved on
  five uniformly refined meshes against the analytical solution (`@ana/circle`),
  with live table, log-log error-vs-h chart with fitted orders (least squares
  on the finest three levels), and a log-scaled |Δv| error map of the finest
  solution showing the error concentrating at the interface. Supports
  `?autorun`. Errors are relative L2 norms integrated over the mesh with the
  element quadrature rule (`integrateTri` in fem-core; no sampling grid).
  Measured orders (`npx tsx scripts/convergence.ts`, the Node twin): velocity
  ≈2 (1.98 fitted on the finest three levels) — the polygonal (straight-edge)
  approximation of the curved interface is an O(h²) geometric error that caps
  the element's theoretical O(h³) velocity order; on a square domain the same
  element measures O(h^3.0) for velocity and O(h^2.0) for stress, for both a
  potential-flow (p = const) and a rotational (p = −24xy) manufactured
  solution (`scripts/convtest.ts`) — so neither the bubble-enriched velocity
  space nor the discontinuous-P1 pressure caps the order; the geometry does.
  Stress order 1.0: in the sliver between polygon and circle the mesh has
  the wrong material, an O(1) stress error over an O(h²) area, i.e. O(h) in
  the L2 norm, and it is >90% of the squared stress error from level 2 on.
  The sliver is a thousand times thinner than an element, so the element
  quadrature never samples it; `src/convergence-study.ts` (shared by worker
  and script) integrates it explicitly in polar coordinates and adds it. An
  error norm blind to the sliver (a sampling grid, or element quadrature
  alone) reports an apparent stress order near two.
- `citations.html` — all publications citing the MILAMIN paper, grouped by year
  with a per-year chart and filter. Data snapshot in
  `public/data/citations.json`, fetched from OpenAlex and cleaned by
  `scripts/fetch_citations.py` (2026-09: book chapters collapsed into their
  book by DOI prefix with a chapter count, Copernicus review comments and
  paratext dropped, preprint/published pairs within two years merged; 269
  raw records became 208). Author names come as OpenAlex spells them, e.g.
  Dąbrowski with the Polish ogonek on some records.
- `about/licenses.html` — every component with its license, and the GPL
  corresponding source of the solver wasm binaries:
  `public/downloads/milamin-solver-wasm-source.zip`, produced by
  `packages/fem-core/wasm-src/pack-source.sh` (our shim + build script, the
  compiled SuiteSparse 5.13.0 modules, Eigen 3.4.0 headers, license texts).
  Re-run the script whenever the shim or the upstream versions change.
- `original.html`, `applications.html`, `notes.html`, `downloads.html` — the
  original milamin.org pages (see below).

## The original milamin.org pages

`original.html`, `applications.html`, `notes.html` and `downloads.html` carry
the content of the original milamin.org (2008-2017) in one look, distinct
from the modern pages:

- `main.arch-main` caps the content column at the banner's width (882 px +
  padding) so banner, sub, prose, TOCs and cards all align. On the modern
  pages, reading text (`.prose` and `header.site p.sub`) shares a 760 px
  measure; UI panels and canvases go full width.
- Every page carries the `archive/Header.jpg` banner (1e6/1 logo, title
  overlaid as HTML like the original theme) linking back to `original.html`;
  breadcrumbs route MilAMin / The original MILAMIN / page.
- Sections and TOCs are numbered (notes nests 2.1–2.4 under System solution;
  figure numbering runs 1–13 continuously across the merged notes page).
- Figure groups use a small dependency-free slider in `src/landing.ts` (dots,
  arrows, 5 s auto-advance; the homepage slideshow is `arch-slider wide` and
  fills the column, content sliders never upscale). Every figure — slider or
  static `arch-fig` — opens full size in a lightbox; captions are the
  paragraph following the image, styled left-aligned at the 1.5 rem content
  indent shared by tables, lists and code blocks.
- MATLAB code fragments are highlighted via highlight.js (root dependency,
  registered in `src/landing.ts`; MATLAB-editor-inspired token colors in
  `packages/viz/src/styles.css`, light + dark).
- MILAMIN is spelled all-caps throughout the vintage text; the modern brand
  spelling is MilAMin, and written out the name capitalizes accordingly:
  "Million A Minute" (also in the prose question "A Million A Minute, in a
  browser?").

The FEM solver stack lives in `packages/fem-core` and is shared with the
Folder app.

## Sparse solver (wasm)

`src/spchol.ts` + `src/wasm/spchol{,-mt}.{js,wasm}` wrap CHOLMOD's supernodal
Cholesky (SuiteSparse) with AMD ordering behind a tiny C ABI
(`wasm/spchol.cpp`): factor once, solve per Powell–Hestenes iteration.
The supernodal algorithm does its flops in dense BLAS3 kernels, implemented
in `wasm/blas_shim.cpp` on Eigen (wasm SIMD via the SSE2 mapping) and
parallelized with OpenMP in the `-mt` build. `initSpchol()` picks the
threaded build when the page is cross-origin isolated (COOP/COEP headers,
see `public/_headers`; applications.html opts out to keep its Vimeo embeds)
and falls back to the single-thread build otherwise.
`solveStokesTri({..., backend: 'sparse'})` selects it (default remains the
pure-TS banded Cholesky). Verified against the banded backend to 10 digits
(`verify/check_spchol.ts`).

The wasm artifacts are committed, so the site builds without a C++ toolchain.
To rebuild: install emsdk (python >= 3.10 on PATH), drop the Eigen 3.4 source
tree into `wasm/eigen/` and SuiteSparse 5.13's `SuiteSparse_config`, `AMD`,
`COLAMD`, `CHOLMOD` into `wasm/suitesparse/` (both gitignored; see the
comment in `wasm/build.sh` for the fetch command), then `wasm/build.sh`.
Licensing note: CHOLMOD's Supernodal module is GPL-2.0+, so the combined
wasm binaries are GPL; Eigen is MPL2, AMD/COLAMD are BSD.

Triangle is our own build of Shewchuk's C mesher, produced by
`packages/fem-core/wasm-src/build-triangle.sh` with growable memory. Its
bundled sources retain Shewchuk's separate terms. The TypeScript adapter in
`packages/fem-core/src/triangle.ts` owns input/output allocation, copies the
mesh into JavaScript arrays and releases aliased pointers exactly once.
It replaces the previously vendored triangle-wasm JavaScript wrapper; the
Triangle binary itself is unchanged. `check_triangle.ts` checks exact mesh
parity, memory growth, cleanup and initialization failure/retry.

## Develop

```bash
npm install
npm run dev       # dev server (WSL: polling watch is configured)
npm run build     # production build to dist/
npm run verify    # FEM convergence + analytics cross-checks
npm run citations # refresh public/data/citations.json from OpenAlex
```

## History

MilAMin went public in September 2026 after Marcin Dabrowski's review.

milamin.org was the project home from 2008. Key dates: 2008 paper + MILAMIN
1.0; 2012 MUTILS release (Krotkiewski & Dabrowski's high-performance MEX
utilities). MILAMIN was developed at PGP, University of Oslo. The original
site's figures live in `public/archive/` (slideshow under `archive/slides/`).
