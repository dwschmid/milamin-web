// Run the verification suites: the fem-core solver checks plus each app's
// physics checks. Pass a name (fem-core | folder | folder-accuracy | milamin) to run a
// single suite.
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = {
  'folder-accuracy': ['apps/folder/verify/check_accuracy.ts'],
  milamin: ['apps/milamin/verify/check_convergence.ts'],
  'fem-core': [
    'packages/fem-core/verify/check_triangle.ts',
    'packages/fem-core/verify/check_fem.ts',
    'packages/fem-core/verify/check_femtri.ts',
    'packages/fem-core/verify/check_spchol.ts',
  ],
  folder: ['apps/folder/verify/check_folding.ts'],
};

const picks = process.argv.slice(2);
const names = picks.length ? picks : Object.keys(SUITES);
for (const name of names) {
  const files = SUITES[name];
  if (!files) {
    console.error(`unknown suite '${name}' (have: ${Object.keys(SUITES).join(', ')})`);
    process.exit(2);
  }
  for (const f of files) {
    console.log(`\n=== ${f} ===`);
    execSync(`npx tsx ${f}`, { cwd: root, stdio: 'inherit' });
  }
}
console.log('\nall requested suites passed');
