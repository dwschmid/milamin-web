# Timestep and interface accuracy

Run `npm run verify:folder-accuracy` from the repository root. This complements
`npm run verify:folder`; it does not change the app's Picard tolerance or cap.
The checks use exponents 1, 3 and 5, with the same cross-step warm starts as
the browser. They target ordinary power-law materials, not an exponent-10
approximation to plastic behavior.

## Timestep refinement

A single sinusoidal layer extends by 20%. Parameters: viscosity ratio 100,
matrix exponent 1, initial amplitude 0.01, wavelength 16, box 32 by 16,
193 interface nodes, layer/matrix maximum triangle areas 0.05/0.4, sparse
solver, default relative Picard tolerance 0.01 and cap 20. Triangle remeshes
at both Heun stages. This extension stays below the resampling threshold,
so temporal refinement can be examined separately from interface resampling.

Measured on 2026-09-20:

| Layer exponent | A/A0, 2 steps | A/A0, 4 steps | A/A0, 8 steps | Change, 4 to 8 | Linear solves, 4 / 8 steps |
|---|---:|---:|---:|---:|---:|
| 1 | 0.990359 | 0.990400 | 0.990410 | 0.0010% | 8 / 16 |
| 3 | 1.349915 | 1.352295 | 1.353518 | 0.0903% | 56 / 104 |
| 5 | 1.757705 | 1.771433 | 1.779398 | 0.4476% | 80 / 146 |

No solve reached the iteration cap. At eight steps, layer-area drift was
below 0.0002% for all three exponents. Box-width errors decrease at second
order. Even exact pure-shear velocities do not give exact area conservation
with Heun: the width and height factors are 1 ± dt + dt²/2, whose product
is 1 + dt⁴/4 per step. The nonlinear amplification does not show clean second-order time
convergence at the default Picard tolerance; remeshing and nonlinear-solve
errors also contribute. Differences between successive runs are sensitivity
estimates, not bounds on the error against an exact solution.

For these cases, four to eight steps buys less than 0.5% change in amplitude
for roughly twice the linear solves. That supports retaining the practical
iteration defaults, while checking refinement for a new scientific result.
It does not establish a universal step count for other wavelengths, strains,
amplitudes, contrasts, or matrix exponents.

## Resampling and layer area

A coupled exponent-3 run at 40% extension and eight steps triggers automatic
resampling. Refining initial interface nodes from 97 to 193 changes A/A0
from 1.708547 to 1.712589 (0.236%). The final top interface has 147 and 293
nodes respectively; layer-area drift is 0.00081% and 0.00074%. The triangle
area limits remain fixed. This checks the actual remesh/solve/advect/resample
path, including the browser's warm starts.

An independent geometry test resamples a densely sampled layer with a
quartic thickness perturbation. Its exact area is 32.64. Absolute area
errors for 33, 65 and 129 target nodes are 0.00104162, 0.000260473 and
0.0000651695: approximately second-order reduction. The finest relative
error is about 0.0002%. This test deliberately has nonuniform thickness;
a translated pair of identical periodic interfaces can conceal area errors.

Resampling is interpolation, not an exactly area-preserving operation.
For long runs, monitor cumulative layer area and repeat the calculation
with finer interface spacing as well as smaller timesteps. These checks do
not cover overturning interfaces or the high-strain localization limit.
