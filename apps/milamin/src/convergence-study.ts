// The convergence study, shared by the page's worker and the Node twin
// (scripts/convergence.ts) so both compute the same thing: the inclusion
// benchmark on uniformly refined meshes, and relative L2 errors against the
// analytical solution that are integrated properly, including the sliver
// between the polygonal interface of the mesh and the true circle.
import { buildMesh, type TriMesh } from '@fem/trimesh';
import { solveStokesTri, integrateTri, type StokesTriSolution, type StokesTriCore } from '@fem/stokesfem-tri';
import { solve as solveCircle } from '@ana/circle';

export const R_OUT = 2.5;
export const AREA0 = 0.08; // matrix maxArea at level 0, quartered per level (h halves)
export const VISCOSITY_RATIO = 1000;

export type Exact = ReturnType<typeof solveCircle>;

export function exactSolution(): Exact {
  return solveCircle({ m: VISCOSITY_RATIO, er: 0, gr: 1 });
}

function circlePts(r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

/** number of polygon vertices on the inclusion interface at a level */
export const interfaceVertices = (level: number) => 32 * 2 ** level;

export function meshLevel(level: number): { mesh: TriMesh; area: number } {
  const area = AREA0 / 4 ** level;
  const mesh = buildMesh({
    boundaries: [
      { pts: circlePts(R_OUT, 48 * 2 ** level), marker: 1 },
      { pts: circlePts(1, interfaceVertices(level)), marker: 2 },
    ],
    regions: [
      [0, 0, 2, 2 * area],
      [(1 + R_OUT) / 2, 0, 1, area],
    ],
  });
  return { mesh, area };
}

export function solveLevel(mesh: TriMesh, exact: Exact): StokesTriSolution {
  return solveStokesTri({
    mesh,
    muOfAttr: (a) => (a === 2 ? VISCOSITY_RATIO : 1),
    bc: (marker, x, y) => (marker === 1 ? exact.velAt(x, y) : null),
    backend: 'sparse',
  });
}

export interface LevelErrors {
  /** relative L2 velocity error over the whole domain */
  errV: number;
  /** relative L2 error of the maximum shear stress over the whole domain */
  errTau: number;
  /** the part of the squared stress error that lives in the sliver between
   *  the polygon and the circle, as a fraction of the total squared error */
  sliverShareTau: number;
}

type Field = { u: number; v: number; tau: number };
type Sample = Field & { x: number; y: number };
type Solution = StokesTriCore & { evalAt: StokesTriSolution['evalAt'] };

// Eight-point Gauss-Legendre rule on [-1, 1]. Unlike angular midpoints,
// this resolves the curved sliver area without a persistent relative bias.
const GAUSS = [
  [-0.9602898564975363, 0.1012285362903763],
  [-0.7966664774136267, 0.2223810344533745],
  [-0.5255324099163290, 0.3137066458778873],
  [-0.1834346424956498, 0.3626837833783620],
  [0.1834346424956498, 0.3626837833783620],
  [0.5255324099163290, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745],
  [0.9602898564975363, 0.1012285362903763],
];

/** Integrate a function of the FEM and reference fields. Whole elements use
 * the reference branch of their mesh material, smoothly continued across the
 * circle. In the sliver, subtract that continuation and add the true branch.
 * Thus the signed weights cover the domain once, even if an element-rule
 * point lands in the sliver. `panels` refines the polar rule for verification.
 * The positive `sliver` visits also give its physical error contribution. */
export function integrateCircleReference(
  sol: Solution, level: number, exact: Exact,
  visit: (sample: Sample, reference: Field, weight: number, part: 'element' | 'replacement' | 'sliver') => void,
  panels = 1,
): void {
  if (!Number.isInteger(panels) || panels < 1) throw new Error('panels must be a positive integer');
  const reference = (x: number, y: number, matrix: boolean): Field => {
    const [u, v] = matrix ? exact.velMatrixAt(x, y) : exact.velAt(x, y);
    return { u, v, tau: (matrix ? exact.evalMatrixAt(x, y) : exact.evalAt(x, y)).tau };
  };
  integrateTri(sol, s => visit(s, reference(s.x, s.y, s.mu === 1), s.w, 'element'));
  const n = interfaceVertices(level);
  const cosHalf = Math.cos(Math.PI / n);
  for (let j = 0; j < n; j++) {
    const thMid = (2 * Math.PI * (j + 0.5)) / n;
    for (let a = 0; a < panels; a++) {
      const halfTheta = Math.PI / n / panels;
      const centerTheta = (2 * Math.PI * (j + (a + 0.5) / panels)) / n;
      for (const [gt, wt] of GAUSS) {
        const th = centerTheta + halfTheta * gt;
        const rc = cosHalf / Math.cos(th - thMid);
        for (let b = 0; b < panels; b++) {
          const halfR = (1 - rc) / (2 * panels);
          const centerR = rc + (2 * b + 1) * halfR;
          for (const [gr, wr] of GAUSS) {
            const r = centerR + halfR * gr;
            const x = r * Math.cos(th), y = r * Math.sin(th);
            const field = sol.evalAt(x, y);
            if (!field) throw new Error(`Sliver point outside mesh: ${x}, ${y}`);
            const sample = { ...field, x, y };
            const w = r * halfR * halfTheta * wr * wt;
            visit(sample, reference(x, y, true), -w, 'replacement');
            visit(sample, reference(x, y, false), w, 'sliver');
          }
        }
      }
    }
  }
}

/** Relative L2 errors with a jump correction at the circular interface. */
export function levelErrors(sol: Solution, level: number, exact: Exact, panels = 1): LevelErrors {
  let v2 = 0, dv2 = 0, t2 = 0, dt2 = 0, sliverDt2 = 0;
  integrateCircleReference(sol, level, exact, (s, ref, w, part) => {
    const errorTau = (s.tau - ref.tau) ** 2;
    v2 += w * (ref.u * ref.u + ref.v * ref.v);
    dv2 += w * ((s.u - ref.u) ** 2 + (s.v - ref.v) ** 2);
    t2 += w * ref.tau * ref.tau;
    dt2 += w * errorTau;
    if (part === 'sliver') sliverDt2 += w * errorTau;
  }, panels);
  return {
    errV: Math.sqrt(dv2 / v2),
    errTau: Math.sqrt(dt2 / t2),
    sliverShareTau: sliverDt2 / dt2,
  };
}
