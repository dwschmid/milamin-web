// Unstructured quadratic triangle meshes via Triangle (Shewchuk) compiled to
// WebAssembly (our own build) — the same mesher MILAMIN used. Closed boundary
// polylines carry markers (for boundary conditions), regions carry an
// attribute (material id) and a maximum triangle area. Output elements are
// 6-node (quadratic) triangles, with the midside nodes normalized to the
// convention tri6[3] = mid(1,2), tri6[4] = mid(2,0), tri6[5] = mid(0,1).

import { triangle } from './triangle';

/** Initialize our Triangle wasm build. Browsers supply the bundled asset URL;
 * Node loads the adjacent wasm file through Emscripten's generated loader. */
export const initTriangle = (wasmUrl?: string): Promise<void> => triangle.init(wasmUrl);

export interface TriMesh {
  nNodes: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** per-node boundary marker (0 = interior) */
  marker: Int32Array;
  nTri: number;
  /** 6 nodes per triangle: corners 0,1,2 then mids (1,2), (2,0), (0,1) */
  tri6: Int32Array;
  /** region attribute per triangle */
  triAttr: Float64Array;
}

export interface MeshSpec {
  /** closed polylines; consecutive points are joined, last to first */
  boundaries: Array<{ pts: Array<[number, number]>; marker: number }>;
  /** explicit PSLG points, for geometries that need per-segment markers or
   *  internal interfaces (indices referenced by `segments`) */
  points?: Array<[number, number]>;
  /** explicit segments [i, j, marker] indexing into `points` */
  segments?: Array<[number, number, number]>;
  /** region seed points: [x, y, attribute, maxArea] */
  regions: Array<[number, number, number, number]>;
  /** points inside un-meshed holes */
  holes?: Array<[number, number]>;
  /** minimum angle quality constraint (default 30 degrees) */
  quality?: number;
}

export function buildMesh(spec: MeshSpec): TriMesh {
  const pts: number[] = [];
  const segs: number[] = [];
  const smark: number[] = [];
  for (const b of spec.boundaries) {
    const off = pts.length / 2;
    const nb = b.pts.length;
    for (const [x, y] of b.pts) pts.push(x, y);
    for (let k = 0; k < nb; k++) {
      segs.push(off + k, off + ((k + 1) % nb));
      smark.push(b.marker);
    }
  }
  if (spec.points) {
    const off = pts.length / 2;
    for (const [x, y] of spec.points) pts.push(x, y);
    for (const [a, b, m] of spec.segments ?? []) {
      segs.push(off + a, off + b);
      smark.push(m);
    }
  }
  const regionlist: number[] = [];
  for (const [x, y, attr, area] of spec.regions) regionlist.push(x, y, attr, area);

  const out = triangle.mesh({
    points: pts, segments: segs, markers: smark, regions: regionlist,
    holes: spec.holes?.flat(), quality: spec.quality,
  });
  const nodeXY = out.points, marker = out.markers, tri6 = out.triangles, triAttr = out.attributes;
  const nNodes = nodeXY.length / 2, nTri = tri6.length / 6;

  const nodeX = new Float64Array(nNodes);
  const nodeY = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    nodeX[i] = nodeXY[2 * i];
    nodeY[i] = nodeXY[2 * i + 1];
  }

  // normalize midside ordering: tri6[3 + k] must be the midpoint of the edge
  // opposite corner k, i.e. mid(1,2), mid(2,0), mid(0,1)
  const edges = [
    [1, 2],
    [2, 0],
    [0, 1],
  ];
  for (let e = 0; e < nTri; e++) {
    const c = [tri6[e * 6], tri6[e * 6 + 1], tri6[e * 6 + 2]];
    const mids = [tri6[e * 6 + 3], tri6[e * 6 + 4], tri6[e * 6 + 5]];
    const sorted = new Int32Array(3).fill(-1);
    let scale = 0;
    for (const [a, b] of edges) scale = Math.max(scale, Math.abs(nodeX[c[a]] - nodeX[c[b]]) + Math.abs(nodeY[c[a]] - nodeY[c[b]]));
    for (let k = 0; k < 3; k++) {
      const [a, b] = edges[k];
      const mx = (nodeX[c[a]] + nodeX[c[b]]) / 2;
      const my = (nodeY[c[a]] + nodeY[c[b]]) / 2;
      let best = -1;
      let bestD = Infinity;
      for (const mm of mids) {
        const d = Math.abs(nodeX[mm] - mx) + Math.abs(nodeY[mm] - my);
        if (d < bestD) {
          bestD = d;
          best = mm;
        }
      }
      if (bestD > 1e-9 * scale) throw new Error('trimesh: unexpected midside node convention');
      sorted[k] = best;
    }
    tri6[e * 6 + 3] = sorted[0];
    tri6[e * 6 + 4] = sorted[1];
    tri6[e * 6 + 5] = sorted[2];
  }

  return { nNodes, nodeX, nodeY, marker, nTri, tri6, triAttr };
}

/** Where two boundary segments of a mesh spec meet when they should not. */
export interface BoundaryCrossing {
  /** human-readable names of the two offenders, e.g. "boundary 2" */
  a: string;
  b: string;
  x: number;
  y: number;
}

/**
 * Find the first pair of boundary segments that cross or touch without
 * sharing an endpoint. Triangle would split them and mesh the slivers in
 * between (an inclusion poking through the box, two overlapping grains), so
 * catching it beforehand turns a mystery mesh into a clear error. O(S²) over
 * the segments with a bounding-box pre-check; fine for playground-sized specs.
 */
export function findBoundaryCrossing(spec: MeshSpec): BoundaryCrossing | null {
  interface Seg { x0: number; y0: number; x1: number; y1: number; a: number; b: number; name: string }
  const segs: Seg[] = [];
  let np = 0;
  spec.boundaries.forEach((bd, bi) => {
    const n = bd.pts.length;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = bd.pts[k];
      const [x1, y1] = bd.pts[(k + 1) % n];
      segs.push({ x0, y0, x1, y1, a: np + k, b: np + ((k + 1) % n), name: `boundary ${bi + 1}` });
    }
    np += n;
  });
  if (spec.points && spec.segments) {
    spec.segments.forEach(([a, b], si) => {
      const [x0, y0] = spec.points![a];
      const [x1, y1] = spec.points![b];
      segs.push({ x0, y0, x1, y1, a: np + a, b: np + b, name: `segment ${si}` });
    });
  }
  let span = 0;
  for (const s of segs) span = Math.max(span, Math.abs(s.x0), Math.abs(s.y0), Math.abs(s.x1), Math.abs(s.y1));
  const eps = 1e-12 * span * span;
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const onSeg = (s: Seg, x: number, y: number) =>
    x >= Math.min(s.x0, s.x1) - eps && x <= Math.max(s.x0, s.x1) + eps &&
    y >= Math.min(s.y0, s.y1) - eps && y <= Math.max(s.y0, s.y1) + eps;
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i];
    const pxMin = Math.min(p.x0, p.x1), pxMax = Math.max(p.x0, p.x1);
    const pyMin = Math.min(p.y0, p.y1), pyMax = Math.max(p.y0, p.y1);
    for (let j = i + 1; j < segs.length; j++) {
      const q = segs[j];
      if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue; // share a vertex
      if (Math.max(q.x0, q.x1) < pxMin - eps || Math.min(q.x0, q.x1) > pxMax + eps) continue;
      if (Math.max(q.y0, q.y1) < pyMin - eps || Math.min(q.y0, q.y1) > pyMax + eps) continue;
      const d1 = orient(q.x0, q.y0, q.x1, q.y1, p.x0, p.y0);
      const d2 = orient(q.x0, q.y0, q.x1, q.y1, p.x1, p.y1);
      const d3 = orient(p.x0, p.y0, p.x1, p.y1, q.x0, q.y0);
      const d4 = orient(p.x0, p.y0, p.x1, p.y1, q.x1, q.y1);
      let hit: [number, number] | null = null;
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
          ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
        const t = d1 / (d1 - d2); // proper crossing: interpolate along p
        hit = [p.x0 + t * (p.x1 - p.x0), p.y0 + t * (p.y1 - p.y0)];
      } else if (Math.abs(d1) <= eps && onSeg(q, p.x0, p.y0)) hit = [p.x0, p.y0];
      else if (Math.abs(d2) <= eps && onSeg(q, p.x1, p.y1)) hit = [p.x1, p.y1];
      else if (Math.abs(d3) <= eps && onSeg(p, q.x0, q.y0)) hit = [q.x0, q.y0];
      else if (Math.abs(d4) <= eps && onSeg(p, q.x1, q.y1)) hit = [q.x1, q.y1];
      if (hit) return { a: p.name, b: q.name, x: hit[0], y: hit[1] };
    }
  }
  return null;
}
