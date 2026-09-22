// Banded symmetric-positive-definite Cholesky (LL^T) on typed arrays, plus a
// reverse Cuthill-McKee ordering — shared by the structured (stokesfem.ts)
// and unstructured (stokesfem-tri.ts) Stokes solvers.
//
// Storage: lower band, A[i, j] at band[i * (hbw + 1) + (i - j)] for
// 0 <= i - j <= hbw.

export function bandFactor(band: Float64Array, n: number, hbw: number): void {
  const hb1 = hbw + 1;
  for (let j = 0; j < n; j++) {
    const bj = j * hb1;
    let s = band[bj];
    const oMaxJ = Math.min(j, hbw);
    for (let o = 1; o <= oMaxJ; o++) {
      const L = band[bj + o];
      s -= L * L;
    }
    if (s <= 0) throw new Error(`bandFactor: matrix not SPD at dof ${j}`);
    const Ljj = Math.sqrt(s);
    band[bj] = Ljj;
    const iMax = Math.min(j + hbw, n - 1);
    for (let i = j + 1; i <= iMax; i++) {
      const bi = i * hb1 + (i - j); // band[bi + o] = A[i, j - o]
      let t = band[bi];
      const oMax = Math.min(j, hbw - (i - j));
      for (let o = 1; o <= oMax; o++) {
        t -= band[bi + o] * band[bj + o];
      }
      band[bi] = t / Ljj;
    }
  }
}

export function bandSolve(band: Float64Array, n: number, hbw: number, b: Float64Array): Float64Array {
  const hb1 = hbw + 1;
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let s = x[i];
    const k0 = Math.max(0, i - hbw);
    for (let k = k0; k < i; k++) s -= band[i * hb1 + (i - k)] * x[k];
    x[i] = s / band[i * hb1];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    const kMax = Math.min(i + hbw, n - 1);
    for (let k = i + 1; k <= kMax; k++) s -= band[k * hb1 + (k - i)] * x[k];
    x[i] = s / band[i * hb1];
  }
  return x;
}

/**
 * Reverse Cuthill-McKee ordering of the node graph defined by element
 * connectivity (nPer nodes per element). Returns perm with perm[old] = new,
 * chosen to keep the matrix bandwidth small on unstructured meshes.
 */
export function rcmOrder(nNodes: number, elems: Int32Array, nPer: number): Int32Array {
  // adjacency (deduplicated)
  const adj: number[][] = Array.from({ length: nNodes }, () => []);
  const seen = new Set<number>();
  const nEl = elems.length / nPer;
  for (let e = 0; e < nEl; e++) {
    for (let a = 0; a < nPer; a++) {
      const na = elems[e * nPer + a];
      for (let b = 0; b < nPer; b++) {
        if (a === b) continue;
        const nb = elems[e * nPer + b];
        const key = na * nNodes + nb;
        if (!seen.has(key)) {
          seen.add(key);
          adj[na].push(nb);
        }
      }
    }
  }
  const degree = adj.map((l) => l.length);

  const perm = new Int32Array(nNodes).fill(-1);
  const order: number[] = [];
  const visited = new Uint8Array(nNodes);

  while (order.length < nNodes) {
    // start from an unvisited node of minimal degree (pseudo-peripheral enough)
    let start = -1;
    for (let i = 0; i < nNodes; i++) {
      if (!visited[i] && (start === -1 || degree[i] < degree[start])) start = i;
    }
    visited[start] = 1;
    const queue = [start];
    let qi = 0;
    while (qi < queue.length) {
      const nd = queue[qi++];
      order.push(nd);
      const nb = adj[nd].filter((k) => !visited[k]).sort((p, q) => degree[p] - degree[q]);
      for (const k of nb) {
        visited[k] = 1;
        queue.push(k);
      }
    }
  }
  // reverse
  for (let i = 0; i < nNodes; i++) perm[order[nNodes - 1 - i]] = i;
  return perm;
}
