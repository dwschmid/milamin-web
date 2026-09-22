// Regression check: run each playground preset through the same pipeline the
// playground worker uses (mesh -> solve, sparse backend) under Node.
// Run: npx tsx apps/milamin/scripts/playtest.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initTriangle, buildMesh, findBoundaryCrossing, MeshSpec } from '@fem/trimesh';
import { initSpchol } from '@fem/spchol';
import { solveStokesTri, triEvaluator } from '@fem/stokesfem-tri';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, '../src/playground-page.ts'), 'utf8');

// extract the preset code template literals
const presets: Array<{ key: string; code: string }> = [];
const re = /(\w+): \{\n    label: '[^']*',\n    code: `([\s\S]*?)`,\n  \}/g;
let m: RegExpExecArray | null;
while ((m = re.exec(pageSrc))) presets.push({ key: m[1], code: m[2] });
if (presets.length !== 3) throw new Error(`expected 3 presets, extracted ${presets.length}`);

function circle(cx: number, cy: number, r: number, n = 64): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}
function ellipse(cx: number, cy: number, rx: number, ry: number, n = 64, angleDeg = 0) {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca]);
  }
  return pts;
}
function rect(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

await initTriangle();
await initSpchol({ forceSingleThread: true });

for (const { key, code } of presets) {
  const t0 = performance.now();
  const model = new Function('circle', 'ellipse', 'rect', `'use strict';\n${code}`)(
    circle, ellipse, rect,
  ) as { mesh: MeshSpec; mu: (a: number) => number; bc: (m: number, x: number, y: number) => [number, number] | null };
  model.mesh.boundaries ??= [];
  const hit = findBoundaryCrossing(model.mesh);
  if (hit) throw new Error(`${key}: ${hit.a} and ${hit.b} cross near (${hit.x}, ${hit.y})`);
  const mesh = buildMesh(model.mesh);
  const sol = solveStokesTri({ mesh, muOfAttr: model.mu, bc: model.bc, backend: 'sparse' });
  const ev = triEvaluator(sol);
  // sample the field: count valid samples and check finiteness
  let ok = 0, bad = 0;
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() - 0.5) * 4;
    const y = (Math.random() - 0.5) * 2;
    const s = ev(x, y);
    if (!s) continue;
    if (Number.isFinite(s.p) && Number.isFinite(s.tau) && Number.isFinite(s.u)) ok++;
    else bad++;
  }
  console.log(
    `${key.padEnd(11)} dofs=${String(sol.dofs).padStart(7)} elems=${String(sol.elements).padStart(6)}` +
      ` divRes=${sol.divResidual.toExponential(1)} samples ok=${ok} bad=${bad}` +
      ` total=${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (bad > 0 || ok < 50) throw new Error(`${key}: field sampling failed`);
  if (!(sol.divResidual < 1e-6)) throw new Error(`${key}: incompressibility not converged`);
}
console.log('all presets solve');

// the crossing check must catch what the playground worker refuses: an
// inclusion through the box wall, two overlapping grains, and a tangency
const box = rect(-2.5, -2.5, 2.5, 2.5);
const cases: Array<[string, MeshSpec, boolean]> = [
  ['inside', { boundaries: [{ pts: box, marker: 1 }, { pts: circle(0, 0, 1, 32), marker: 2 }], regions: [] }, false],
  ['through wall', { boundaries: [{ pts: box, marker: 1 }, { pts: circle(0, 0, 3, 32), marker: 2 }], regions: [] }, true],
  ['overlap', { boundaries: [{ pts: box, marker: 1 }, { pts: circle(0, 0, 1, 32), marker: 2 }, { pts: circle(1.5, 0, 1, 32), marker: 2 }], regions: [] }, true],
  ['touching', { boundaries: [{ pts: box, marker: 1 }, { pts: [[0, 0], [2.5, 0], [0, 1]], marker: 2 }], regions: [] }, true],
  ['pslg shared endpoints', { boundaries: [], points: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0.5], [1, 0.5]], segments: [[0, 1, 1], [1, 5, 1], [5, 2, 1], [2, 3, 1], [3, 4, 1], [4, 0, 1], [4, 5, 0]], regions: [] }, false],
];
for (const [name, spec, expectHit] of cases) {
  const hit = findBoundaryCrossing(spec);
  if (!!hit !== expectHit) throw new Error(`crossing check '${name}': expected ${expectHit}, got ${JSON.stringify(hit)}`);
  console.log(`crossing check ${name.padEnd(22)} ${hit ? `${hit.a} x ${hit.b} at (${hit.x.toFixed(2)}, ${hit.y.toFixed(2)})` : 'clear'}`);
}
