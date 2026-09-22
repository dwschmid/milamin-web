// Sparse symmetric-positive-definite solver for MILAMIN web: CHOLMOD's
// supernodal Cholesky (AMD ordering) behind a tiny C ABI so the TypeScript
// side can factor once and back-substitute many times (Powell-Hestenes
// iterations). The supernodal algorithm spends its flops in dense BLAS3
// kernels — see blas_shim.cpp, which implements them with Eigen and, in the
// -pthread/-fopenmp build, splits them across threads.
//
// The matrix comes in as compressed sparse column (CSC), LOWER triangle only
// (column pointers Ap[0..n], row indices Ai, values Ax, sorted), matching how
// the assembly loop naturally produces a symmetric matrix.
//
// Build: see build.sh (spchol.js single-thread, spchol-mt.js threaded).
#include <cholmod.h>

#include <cstring>
#include <vector>

extern "C" void blas_set_threads(int);
extern "C" void blas_stats_dump(void);

namespace {
struct Handle {
  cholmod_common c;
  cholmod_factor* L = nullptr;
  // cholmod_solve2 workspaces, reused across the repeated solves
  cholmod_dense* X = nullptr;
  cholmod_dense* Y = nullptr;
  cholmod_dense* E = nullptr;
  int n = 0;
};
std::vector<Handle*> handles;

cholmod_sparse lowerCscView(int n, const int* Ap, const int* Ai,
                            const double* Ax) {
  cholmod_sparse A;
  std::memset(&A, 0, sizeof(A));
  A.nrow = n;
  A.ncol = n;
  A.nzmax = Ap[n];
  A.p = const_cast<int*>(Ap);
  A.i = const_cast<int*>(Ai);
  A.x = const_cast<double*>(Ax);
  A.stype = -1;  // symmetric, lower triangle stored
  A.itype = CHOLMOD_INT;
  A.xtype = CHOLMOD_REAL;
  A.dtype = CHOLMOD_DOUBLE;
  A.sorted = 1;
  A.packed = 1;
  return A;
}
}  // namespace

extern "C" {

// Number of threads the BLAS kernels may use (no-op in the single-thread
// build). Call before spchol_factor.
void spchol_threads(int t) { blas_set_threads(t); }

// Factor the lower-triangular CSC matrix. Returns a handle >= 1, or 0 on
// failure (structurally singular / not positive definite).
int spchol_factor(int n, const int* Ap, const int* Ai, const double* Ax) {
  auto* h = new Handle();
  h->n = n;
  cholmod_start(&h->c);
  h->c.supernodal = CHOLMOD_SUPERNODAL;
  h->c.nmethods = 1;
  h->c.method[0].ordering = CHOLMOD_AMD;
  h->c.postorder = 1;
  cholmod_sparse A = lowerCscView(n, Ap, Ai, Ax);
  h->L = cholmod_analyze(&A, &h->c);
  const bool ok = h->L && cholmod_factorize(&A, h->L, &h->c) &&
                  h->c.status == CHOLMOD_OK;
  if (!ok) {
    if (h->L) cholmod_free_factor(&h->L, &h->c);
    cholmod_finish(&h->c);
    delete h;
    return 0;
  }
  handles.push_back(h);
  return static_cast<int>(handles.size());  // 1-based
}

// Solve A x = b in place (b is overwritten with x).
void spchol_solve(int handle, double* b) {
  Handle* h = handles[handle - 1];
  cholmod_dense B;
  std::memset(&B, 0, sizeof(B));
  B.nrow = h->n;
  B.ncol = 1;
  B.d = h->n;
  B.nzmax = h->n;
  B.x = b;
  B.xtype = CHOLMOD_REAL;
  B.dtype = CHOLMOD_DOUBLE;
  cholmod_solve2(CHOLMOD_A, h->L, &B, nullptr, &h->X, nullptr, &h->Y, &h->E,
                 &h->c);
  std::memcpy(b, h->X->x, sizeof(double) * h->n);
}

// Number of non-zeros stored in the factor (diagnostics for the benchmark).
double spchol_nnzL(int handle) {
  Handle* h = handles[handle - 1];
#ifdef BLAS_SHIM_STATS
  blas_stats_dump();
#endif
  return static_cast<double>(h->L->xsize);
}

void spchol_free(int handle) {
  Handle* h = handles[handle - 1];
  if (h->X) cholmod_free_dense(&h->X, &h->c);
  if (h->Y) cholmod_free_dense(&h->Y, &h->c);
  if (h->E) cholmod_free_dense(&h->E, &h->c);
  cholmod_free_factor(&h->L, &h->c);
  cholmod_finish(&h->c);
  delete h;
  handles[handle - 1] = nullptr;
}

}  // extern "C"
