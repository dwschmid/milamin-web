import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildMesh, initTriangle, type MeshSpec } from '../src/trimesh';
import { createTriangleAdapter, type TriangleModule, type TriangleInput } from '../src/triangle';
import createModule from '../src/vendor/triangle/triangle.out.js';

// Recorded before replacing the wrapper, using the unchanged Triangle wasm.
const fixtures = JSON.parse(readFileSync(new URL('./triangle-fixtures.json', import.meta.url), 'utf8')) as
  Array<{ name: string; spec: MeshSpec; nodes: number; elements: number; sha256: string }>;
await Promise.all([initTriangle(), initTriangle()]);
for (const f of fixtures) {
  const mesh = buildMesh(f.spec);
  const hash = createHash('sha256');
  for (const a of [mesh.nodeX, mesh.nodeY, mesh.marker, mesh.tri6, mesh.triAttr]) {
    hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  assert.equal(mesh.nNodes, f.nodes);
  assert.equal(mesh.nTri, f.elements);
  assert.equal(hash.digest('hex'), f.sha256, f.name);
  console.log(`ok unchanged mesh: ${f.name} (${mesh.nTri} elements)`);
}

let realModule: TriangleModule | undefined;
const real = createTriangleAdapter(async options => (realModule = await createModule(options)));
await real.init();
const initialBytes = realModule!.HEAP32.buffer.byteLength;
const grownMesh = real.mesh({ points: [0, 0, 1, 0, 1, 1, 0, 1],
  segments: [0, 1, 1, 2, 2, 3, 3, 0], markers: [1, 1, 1, 1], regions: [.5, .5, 1, 1e-5] });
assert.ok(realModule!.HEAP32.buffer.byteLength > initialBytes, 'real Triangle heap grew');
let area = 0;
for (let i = 0; i < grownMesh.triangles.length; i += 6) {
  const [a, b, c] = grownMesh.triangles.subarray(i, i + 3);
  const p = grownMesh.points;
  area += Math.abs((p[2*b] - p[2*a]) * (p[2*c+1] - p[2*a+1]) -
    (p[2*c] - p[2*a]) * (p[2*b+1] - p[2*a+1])) / 2;
}
assert.ok(Math.abs(area - 1) < 1e-10, 'grown mesh still covers the unit square');
assert.ok(grownMesh.attributes.every(a => a === 1));
console.log(`ok real Triangle memory growth: ${initialBytes} -> ${realModule!.HEAP32.buffer.byteLength} bytes`);

// A controllable wasm allocator lets us force input and output growth, failure
// paths, pointer aliasing and writes into freed storage without risking a real
// Triangle abort. Every allocated block must be released exactly once.
class FakeTriangle implements TriangleModule {
  memory = new WebAssembly.Memory({ initial: 1 });
  next = 16;
  blocks = new Map<number, number>();
  failAllocation = Infinity;
  allocations = 0;
  failTriangulate = false;
  get HEAP32() { return new Int32Array(this.memory.buffer); }
  get HEAPF64() { return new Float64Array(this.memory.buffer); }
  _malloc(bytes: number) {
    if (++this.allocations === this.failAllocation) return 0;
    const p = this.next;
    this.next += Math.ceil(bytes / 8) * 8;
    if (this.next > this.memory.buffer.byteLength) this.memory.grow(Math.ceil((this.next - this.memory.buffer.byteLength) / 65536));
    this.blocks.set(p, bytes);
    return p;
  }
  _free(p: number) {
    const bytes = this.blocks.get(p);
    assert.notEqual(bytes, undefined, `double free or unowned pointer ${p}`);
    new Uint8Array(this.memory.buffer, p, bytes).fill(0xdd);
    this.blocks.delete(p);
  }
  _triangulate(switches: number, input: number, output: number) {
    const bytes = new Uint8Array(this.memory.buffer);
    const end = bytes.indexOf(0, switches);
    assert.equal(new TextDecoder().decode(bytes.subarray(switches, end)), 'pzQAo2q30a');
    const p = this.HEAP32[input / 4];
    assert.ok(p > 0, 'point pointer survived input memory growth');
    assert.equal(this.HEAPF64[p / 8], 7);
    this.memory.grow(1); // detached views during the native call
    const write = (field: number, value: number) => { this.HEAP32[output / 4 + field] = value; };
    for (const field of [15, 17]) write(field, this.HEAP32[input / 4 + field]);
    for (const [field, values, real] of [
      [0, [0, 0, 1, 0, 0, 1], true], [2, [1, 1, 1], false],
      [5, [0, 1, 2, 0, 1, 2], false], [6, [2], true],
    ] as const) {
      const ptr = this._malloc(values.length * (real ? 8 : 4));
      if (real) this.HEAPF64.set(values, ptr / 8);
      else this.HEAP32.set(values, ptr / 4);
      write(field, ptr);
    }
    write(3, 3); write(9, 1); write(10, 6); write(11, 1);
    if (this.failTriangulate) throw new Error('native failure');
  }
}
const input: TriangleInput = { points: [7, 0, 1, 0, 0, 1], segments: [0, 1, 1, 2, 2, 0], markers: [1, 1, 1], regions: [.1, .1, 2, .01], holes: [.2, .2] };
const fake = new FakeTriangle();
let loads = 0;
const adapter = createTriangleAdapter(async () => { loads++; return fake; });
assert.throws(() => adapter.mesh(input), /initialize/);
await Promise.all([adapter.init(), adapter.init()]);
assert.equal(loads, 1);
const large = new Float64Array(4_000_000); large[0] = 7;
const result = adapter.mesh({ ...input, points: large });
assert.deepEqual([...result.points], [0, 0, 1, 0, 0, 1]);
assert.deepEqual([...result.attributes], [2]);
assert.equal(fake.blocks.size, 0);
fake.failTriangulate = true;
assert.throws(() => adapter.mesh(input), /native failure/);
assert.equal(fake.blocks.size, 0);
fake.failTriangulate = false;
fake.failAllocation = fake.allocations + 3;
assert.throws(() => adapter.mesh(input), /failed to allocate/);
assert.equal(fake.blocks.size, 0);
let attempts = 0;
const retry = createTriangleAdapter(async () => {
  if (++attempts === 1) throw new Error('load failed');
  return fake;
});
const fetchBefore = globalThis.fetch;
await assert.rejects(retry.init(), /load failed/);
await retry.init();
assert.equal(attempts, 2);
assert.equal(globalThis.fetch, fetchBefore);
console.log('ok growth, copied results, alias-safe cleanup, allocation/native failures, concurrent initialization and retry');
