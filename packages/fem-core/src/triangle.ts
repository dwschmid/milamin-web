// Adapter for our Triangle 1.6 wasm build. The wasm32 struct layout follows
// wasm-src/triangle/triangle.h; this only exposes the PSLG/Q2 path we use.
import createModule from './vendor/triangle/triangle.out.js';

export interface TriangleModule {
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _triangulate(options: number, input: number, output: number, voronoi: number): void;
}
export type TriangleLoader = (options: { locateFile?: (file: string, directory: string) => string }) => Promise<TriangleModule>;
export interface TriangleInput {
  points: ArrayLike<number>;
  segments: ArrayLike<number>;
  markers: ArrayLike<number>;
  regions: ArrayLike<number>;
  holes?: ArrayLike<number>;
  quality?: number;
}
export interface TriangleOutput {
  points: Float64Array;
  markers: Int32Array;
  triangles: Int32Array;
  attributes: Float64Array;
}

// All fields are 32-bit pointers or ints in our wasm32 build; REAL is double.
const IO_WORDS = 23;
const POINTER_FIELDS = [0, 1, 2, 5, 6, 7, 8, 12, 13, 15, 17, 19, 20, 21];

export function createTriangleAdapter(load: TriangleLoader = createModule) {
  let module: TriangleModule | undefined;
  let pending: Promise<void> | undefined;
  return {
    init(wasmUrl?: string): Promise<void> {
      if (!pending) {
        pending = load(wasmUrl ? { locateFile: (file, directory) => file.endsWith('.wasm') ? wasmUrl : directory + file } : {})
          .then(value => { module = value; })
          .catch(error => { pending = undefined; throw error; });
      }
      return pending;
    },
    mesh(input: TriangleInput): TriangleOutput {
      if (!module) throw new Error('Triangle: initialize before meshing');
      if (input.points.length % 2 || input.segments.length % 2 || input.regions.length % 4 ||
          (input.holes?.length ?? 0) % 2 || input.markers.length !== input.segments.length / 2) {
        throw new Error('Triangle: invalid input array lengths');
      }
      const quality = input.quality ?? 30;
      if (!Number.isFinite(quality) || quality < 0) throw new Error('Triangle: invalid quality angle');
      const m = module;
      const owned = new Set<number>();
      let output = 0;
      const allocate = (bytes: number) => {
        const p = m._malloc(bytes) >>> 0;
        if (!p) throw new Error(`Triangle: failed to allocate ${bytes} bytes`);
        owned.add(p);
        return p;
      };
      // Never retain wasm views across allocation or triangulation: both grow memory.
      const write = (p: number, field: number, value: number) => { m.HEAP32[(p >>> 2) + field] = value; };
      const read = (p: number, field: number) => m.HEAP32[(p >>> 2) + field] >>> 0;
      const put = (io: number, field: number, values: ArrayLike<number>, real: boolean) => {
        if (!values.length) return;
        const array = real ? Float64Array.from(values) : Int32Array.from(values);
        const p = allocate(array.byteLength);
        if (real) m.HEAPF64.set(array, p >>> 3);
        else m.HEAP32.set(array, p >>> 2);
        write(io, field, p);
      };
      const io = () => {
        const p = allocate(IO_WORDS * 4);
        m.HEAP32.fill(0, p >>> 2, (p >>> 2) + IO_WORDS);
        return p;
      };
      try {
        const source = io();
        output = io();
        put(source, 0, input.points, true);
        write(source, 3, input.points.length / 2);
        put(source, 12, input.segments, false);
        put(source, 13, input.markers, false);
        write(source, 14, input.segments.length / 2);
        put(source, 17, input.regions, true);
        write(source, 18, input.regions.length / 4);
        if (input.holes) {
          put(source, 15, input.holes, true);
          write(source, 16, input.holes.length / 2);
        }
        // PSLG, zero-based, quiet, region attributes, quadratic, quality, region areas.
        const options = new TextEncoder().encode(`pzQAo2q${quality}a\0`);
        const switches = allocate(options.length);
        new Uint8Array(m.HEAP32.buffer, switches, options.length).set(options);
        m._triangulate(switches, source, output, 0);
        const nodes = read(output, 3), elements = read(output, 9);
        if (read(output, 10) !== 6 || read(output, 11) !== 1) {
          throw new Error('Triangle: expected quadratic triangles with one material attribute');
        }
        // Copy before releasing any wasm allocations. Returned arrays own their memory.
        return {
          points: new Float64Array(m.HEAPF64.buffer, read(output, 0), 2 * nodes).slice(),
          markers: new Int32Array(m.HEAP32.buffer, read(output, 2), nodes).slice(),
          triangles: new Int32Array(m.HEAP32.buffer, read(output, 5), 6 * elements).slice(),
          attributes: new Float64Array(m.HEAPF64.buffer, read(output, 6), elements).slice(),
        };
      } finally {
        // Triangle aliases the input hole/region pointers in its output. Deduplicate
        // all pointers before freeing anything, including partially written outputs.
        if (output) for (const field of POINTER_FIELDS) {
          const p = read(output, field);
          if (p) owned.add(p);
        }
        for (const p of owned) m._free(p);
      }
    },
  };
}

export const triangle = createTriangleAdapter();
