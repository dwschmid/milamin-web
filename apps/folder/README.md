# FOLDER in the browser

Folding and boudinage of viscous layers, simulated live in the browser. One
or more stiff layers in a weaker matrix are shortened or extended under
free-slip pure shear; the domain is remeshed with Triangle at every step, the
Stokes equations are solved with 7-node Crouzeix-Raviart elements (MILAMIN),
and the interfaces are advected with the computed velocities (Heun / RK2),
then redistributed along their arc length when advection stretches them.
Layer and matrix can be linear viscous or power-law; power-law effective
viscosities are handled by Picard (secant) iterations. Displayed fields:
viscosity, pressure, maximum shear stress, strain rate, speed, perturbing
speed and vorticity. For single-layer sine runs the measured amplification is
compared against the analytical linear growth rates: Fletcher (1977) for
folding, Johnson & Fletcher (1994) for thinning under extension.

Convergence note: Picard stops when the maximum log-viscosity change divided
by the maximum log-viscosity deviation from the background falls below 1e-2,
with a cap of 20 solves. Both are settable through `SimParams`. Every step
warm-starts from the previous corrector's strain rates. A Carreau-style
strain-rate floor of 1e-2 and viscosity bounds of 1e±3 relative to each
material's background viscosity regularize the power law. The frame exposes
the last residual and warns if it remains above tolerance; the cap is not a
guarantee of convergence or of a particular error in growth rate.

The default policy is unchanged. The accuracy study in
[docs/accuracy.md](docs/accuracy.md) checks timestep and interface refinement
for representative exponents 1, 3 and 5, including cross-step warm starts,
resampling and layer-area conservation. It is a guide to accuracy/cost in
those cases, not validation of every geometry or of pseudoplastic limits.

Browser version of FOLDER: Adamuszek, Dabrowski & Schmid (2016),
[FOLDER: A numerical tool to simulate the development of structures in
layered media](https://doi.org/10.1016/j.jsg.2016.01.001), *Journal of
Structural Geology* 84, 85-101. Original MATLAB tool:
[github.com/dwschmid/folder](https://github.com/dwschmid/folder)
(BSD 3-Clause; the analytical growth-rate formulas in `src/growth.ts` are
ported from its `growth_rate.m`).

## Development

```
npm install
npm run dev:folder # dev server (COOP/COEP headers for the threaded solver)
npm run build     # production build to dist/
npm run preview   # serve dist/
npm run verify:folder           # FEM growth rates and finite-amplitude checks
npm run verify:folder-accuracy  # timestep, interface and area-conservation checks
```

## Hosting

Since September 2026 FOLDER is an app of the MilAMin site: it is built with
the MilAMin header, menu and footer (`siteChrome({ root: '../', page:
'folder/' })` in `vite.config.ts`, styles from `../milamin/src/site`) and
served at `milamin/folder/` from `apps/folder` of the milamin-web
repository.

## Structure

New code:

- `src/geometry.ts` - box + N-layer interfaces, perturbations (fold/necking
  symmetry), arc-length resampling, PSLG generation
- `src/sim.ts` - Heun time stepper (remesh + solve per stage), pure-shear
  BCs for shortening and extension, Picard power-law iterations
- `src/growth.ts` - growth rates: Biot 1961, Fletcher 1977 (+bounded),
  Johnson & Fletcher 1994 necking (+bounded), Fletcher 1974 / Pollard &
  Fletcher 1994 power law, predicted amplitude history. Amplification
  conventions, verified against the FEM: dlnA/dt = +(1+q) under shortening,
  -(1+q) under extension.
- `src/folding-worker.ts` - runs the time loop, streams one frame per step
- `src/folding-page.ts` + `index.html` - controls, field panel, scrubber,
  amplification chart with the applicable linear-theory overlay
- `verify/check_folding.ts` - checks: formula cross-limits, FEM growth
  rates vs analytical for linear and power-law folding and necking,
  finite-amplitude necking vs passive linear thinning, multilayer and noise
  runs

The FEM and visualization stack is shared through `packages/fem-core` and
`packages/viz`. Folder uses the following capabilities: `trimesh.ts` accepts explicit PSLG points/segments (per-wall
markers, internal interfaces); `stokesfem-tri.ts` treats a NaN velocity
component as unconstrained (free slip), accepts a per-element viscosity
array (Picard), and its evaluator also returns the strain-rate invariant and
vorticity.
