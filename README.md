# MilAMin Web

MILAMIN, the MATLAB finite element solver that set up, solved and
post-processed a million unknowns a minute (Dabrowski, Krotkiewski & Schmid,
G3 2008, [doi:10.1029/2007GC001719](https://doi.org/10.1029/2007GC001719)),
brought to the browser. The site at [milamin.org](https://milamin.org)
runs the same solver strategy live in TypeScript and WebAssembly, on whatever
device opens the page, and keeps the original package and its record.

What is on the site:

- Million A Minute: the 2008 claim as one click, a million-unknown inclusion
  problem meshed, assembled, factorized and rendered, every stage on the clock
- Benchmark: the solver at increasing size on your machine against MILAMIN
  2008's own curve
- Playground: your own two-dimensional Stokes models from a few lines of
  JavaScript, up to two million unknowns
- Convergence lab: the inclusion benchmark on five refined meshes against the
  analytical solution
- Folder: folding and boudinage of viscous layers, the browser version of the
  2016 FOLDER tool, built on the same stack
- The original MILAMIN: the recovered milamin.org with its technical notes,
  application gallery, downloads and the citing literature

## Layout

- `apps/milamin/` - the site: pages, styles, page-level code, and
  [its README](apps/milamin/README.md) with the details of every page and the
  measurements behind them
- `apps/folder/` - Folder, served under `folder/` of the site
  ([README](apps/folder/README.md))
- `packages/fem-core/` - meshing (own Triangle wasm build), 7-node
  Crouzeix-Raviart assembly, the sparse supernodal Cholesky solver (CHOLMOD in
  wasm, single- and multi-threaded builds) and its verification suite
- `packages/viz/` - colormaps, pan/zoom, rendering
- `packages/analytic/` - analytical reference solutions

The apps import the packages as TypeScript source through the `@fem/*`,
`@viz/*` and `@ana/*` aliases (`tsconfig.json`, `vite.shared.ts`); nothing is
published to npm. The wasm artifacts are committed, so the site builds without
a C++ toolchain; the sources and build scripts are in
`packages/fem-core/wasm-src/`.

## Getting started

Requires Node 22 (see `.node-version`).

```
npm ci
npm run dev            # dev server for the MilAMin site (http://localhost:5173)
npm run dev:folder     # dev server for Folder alone
npm run build          # production build into dist/ (Folder under dist/folder/)
npm run preview        # serve the production build
npm run verify         # fem-core solver checks against reference solutions
npm run verify:folder  # Folder growth rates against the analytical ones (~10 min)
```

The threaded solver needs cross-origin isolation (SharedArrayBuffer); the dev
and preview servers set the COOP/COEP headers automatically (`vite.shared.ts`),
and `apps/milamin/public/_headers` carries the same headers for the
production server.

## Contributing

Open issues and pull requests here. If you build something on the stack, say
so: apps worth sharing get a place on the site.

## Citing

The note on the browser version: Schmid, D. W. (2026). MilAMin in the
browser: a million unknowns a minute in TypeScript and WebAssembly.
EarthArXiv, [doi:10.31223/X5NF8T](https://doi.org/10.31223/X5NF8T).

The software: Schmid, D. W. (2026). MilAMin: MILAMIN in the browser. Zenodo,
[doi:10.5281/zenodo.22895505](https://doi.org/10.5281/zenodo.22895505)
(all versions; each release has its own DOI). Please cite the note and the
2008 paper alongside it. `CITATION.cff` carries the software citation in
machine-readable form.

## License

GPL-2.0-or-later (see `LICENSE`), which the CHOLMOD supernodal solver in the
wasm binaries requires. The components and their individual licenses are
listed on the site's licenses page, and the corresponding source of the wasm
binaries ships with the site.
