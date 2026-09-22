// Unknown counts as MILAMIN 2008 counted them: two velocities at every node
// of the 7-node element, the bubble node included (the pressure is eliminated
// element by element and never enters the global system). The browser solver
// condenses the bubble before assembly, so its global system has 2N unknowns
// for N nodal points; the comparable count adds the 2E bubble unknowns back.
// For quadratic triangles N is about 2E, so the 2008 count is about 1.5 x 2N.
export const unknowns2008 = (nodalDofs: number, elements: number) => nodalDofs + 2 * elements;
/** the nodal-dof target that yields a wanted 2008-style count (N ~ 2E) */
export const nodalTargetFor2008 = (unknowns: number) => unknowns / 1.5;
