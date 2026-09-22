// Minimal double-precision BLAS + dpotrf for CHOLMOD's supernodal path,
// built on Eigen's serial kernels and parallelized here with OpenMP by
// splitting the output into independent blocks. Compiled without -fopenmp
// the pragmas vanish and everything runs serially, so the single-thread and
// multi-thread wasm builds share this source.
//
// Only the call shapes CHOLMOD emits are exercised (see cholmod_blas.h);
// the complex (z*) routines are referenced by CHOLMOD's complex template
// instantiations but never called for real matrices, so they abort.
//
// Emscripten's OpenMP runtime caps outlined-region arguments at 16
// (kmp_invoke_microtask.cpp), so each parallel region captures a single
// context struct instead of loose locals.
#define EIGEN_DONT_PARALLELIZE  // threading happens here, not inside Eigen
#include <Eigen/Dense>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

using Eigen::OuterStride;
using Mat = Eigen::Map<Eigen::MatrixXd, 0, OuterStride<>>;
using CMat = Eigen::Map<const Eigen::MatrixXd, 0, OuterStride<>>;

namespace {

int g_threads = 1;

#ifdef BLAS_SHIM_STATS
// per-decade flop histogram of dgemm/dsyrk/dtrsm calls, dumped by
// blas_stats_dump(): buckets 10^3..10^10
double stat_flops[11] = {0};
long stat_calls[11] = {0};
inline void stat_add(double flops) {
  int b = flops < 1 ? 0 : static_cast<int>(std::log10(flops));
  b = std::min(10, std::max(0, b));
  stat_flops[b] += flops;
  stat_calls[b]++;
}
#define STAT_ADD(f) stat_add(f)
#else
#define STAT_ADD(f)
#endif

inline bool is_trans(char c) { return c != 'N' && c != 'n'; }
inline bool is_lower(char c) { return c == 'L' || c == 'l'; }
inline bool is_unit(char c) { return c == 'U' || c == 'u'; }

// How many threads to use for a kernel of the given flop count: parallel
// overhead swamps the gain on small blocks.
inline int threads_for(double flops) {
  if (g_threads <= 1 || flops < 8e6) return 1;
  const int t = static_cast<int>(flops / 4e6);
  return std::min(g_threads, std::max(1, t));
}

// Dispatch to a callback with the triangular view selected by uplo/trans/diag
// flags (transposing flips lower <-> upper).
template <typename F>
void with_tri(const CMat& A, bool lower, bool trans, bool unit, F&& f) {
  if (!trans) {
    if (lower) {
      if (unit) f(A.triangularView<Eigen::UnitLower>());
      else f(A.triangularView<Eigen::Lower>());
    } else {
      if (unit) f(A.triangularView<Eigen::UnitUpper>());
      else f(A.triangularView<Eigen::Upper>());
    }
  } else {
    auto At = A.transpose();
    if (lower) {
      if (unit) f(At.triangularView<Eigen::UnitUpper>());
      else f(At.triangularView<Eigen::Upper>());
    } else {
      if (unit) f(At.triangularView<Eigen::UnitLower>());
      else f(At.triangularView<Eigen::Lower>());
    }
  }
}

[[noreturn]] void unsupported(const char* what) {
  std::fprintf(stderr, "blas_shim: %s not supported\n", what);
  std::abort();
}

struct GemmCtx {
  int m, n, k, lda, ldb, ldc, nt;
  bool ta, tb;
  double alpha, beta;
  const double* A;
  const double* B;
  double* C;
};

void gemm_block(const GemmCtx& c, int t) {
  const int c0 = static_cast<int>(static_cast<long long>(c.n) * t / c.nt);
  const int c1 = static_cast<int>(static_cast<long long>(c.n) * (t + 1) / c.nt);
  if (c1 <= c0) return;
  Mat Cm(c.C, c.m, c.n, OuterStride<>(c.ldc));
  CMat Am(c.A, c.ta ? c.k : c.m, c.ta ? c.m : c.k, OuterStride<>(c.lda));
  CMat Bm(c.B, c.tb ? c.n : c.k, c.tb ? c.k : c.n, OuterStride<>(c.ldb));
  auto Cb = Cm.middleCols(c0, c1 - c0);
  if (c.beta == 0.0) Cb.setZero();
  else if (c.beta != 1.0) Cb *= c.beta;
  if (c.k == 0) return;
  if (!c.ta && !c.tb) Cb.noalias() += c.alpha * (Am * Bm.middleCols(c0, c1 - c0));
  else if (!c.ta && c.tb) Cb.noalias() += c.alpha * (Am * Bm.middleRows(c0, c1 - c0).transpose());
  else if (c.ta && !c.tb) Cb.noalias() += c.alpha * (Am.transpose() * Bm.middleCols(c0, c1 - c0));
  else Cb.noalias() += c.alpha * (Am.transpose() * Bm.middleRows(c0, c1 - c0).transpose());
}

struct SyrkCtx {
  int n, k, lda, ldc, nt;
  bool tr;
  double alpha, beta;
  const double* A;
  double* C;
};

void syrk_block(const SyrkCtx& c, int t) {
  // equal-area split of the lower triangle: area below column j ~ (n-j)^2
  const auto edge = [&](int i) {
    return std::min(c.n, static_cast<int>(std::lround(
                             c.n * (1.0 - std::sqrt(1.0 - static_cast<double>(i) / c.nt)))));
  };
  const int c0 = edge(t), c1 = std::max(edge(t + 1), c0);
  const int len = c1 - c0;
  if (len == 0) return;
  Mat Cm(c.C, c.n, c.n, OuterStride<>(c.ldc));
  CMat Am(c.A, c.tr ? c.k : c.n, c.tr ? c.n : c.k, OuterStride<>(c.lda));
  auto Cd = Cm.block(c0, c0, len, len);
  if (c.beta == 0.0) Cd.triangularView<Eigen::Lower>().setZero();
  else if (c.beta != 1.0) Cd.triangularView<Eigen::Lower>() *= c.beta;
  Eigen::MatrixXd Ab;  // rows [c0, c1) of op(A), materialized once per block
  if (c.k > 0) {
    Ab = c.tr ? Eigen::MatrixXd(Am.middleCols(c0, len).transpose())
              : Eigen::MatrixXd(Am.middleRows(c0, len));
    Cd.selfadjointView<Eigen::Lower>().rankUpdate(Ab, c.alpha);
  }
  const int rem = c.n - c1;
  if (rem > 0) {
    auto Cr = Cm.block(c1, c0, rem, len);
    if (c.beta == 0.0) Cr.setZero();
    else if (c.beta != 1.0) Cr *= c.beta;
    if (c.k > 0) {
      if (c.tr) Cr.noalias() += c.alpha * (Am.middleCols(c1, rem).transpose() * Ab.transpose());
      else Cr.noalias() += c.alpha * (Am.middleRows(c1, rem) * Ab.transpose());
    }
  }
}

struct TrsmCtx {
  int m, n, asize, lda, ldb, nt;
  bool onleft, lower, trans, unit;
  double alpha;
  const double* A;
  double* B;
};

void trsm_block(const TrsmCtx& c, int t) {
  const int split = c.onleft ? c.n : c.m;
  const int b0 = static_cast<int>(static_cast<long long>(split) * t / c.nt);
  const int b1 = static_cast<int>(static_cast<long long>(split) * (t + 1) / c.nt);
  if (b1 <= b0) return;
  Mat Bm(c.B, c.m, c.n, OuterStride<>(c.ldb));
  CMat Am(c.A, c.asize, c.asize, OuterStride<>(c.lda));
  with_tri(Am, c.lower, c.trans, c.unit, [&](const auto& T) {
    if (c.onleft) {
      auto Bb = Bm.middleCols(b0, b1 - b0);
      if (c.alpha != 1.0) Bb *= c.alpha;
      T.solveInPlace(Bb);
    } else {
      auto Bb = Bm.middleRows(b0, b1 - b0);
      if (c.alpha != 1.0) Bb *= c.alpha;
      T.template solveInPlace<Eigen::OnTheRight>(Bb);
    }
  });
}

}  // namespace

extern "C" {

void blas_set_threads(int n) { g_threads = n < 1 ? 1 : n; }

void blas_stats_dump(void) {
#ifdef BLAS_SHIM_STATS
  for (int b = 0; b <= 10; b++)
    if (stat_calls[b])
      std::fprintf(stderr, "blas 1e%-2d: %8ld calls  %10.3g flops\n", b,
                   stat_calls[b], stat_flops[b]);
#endif
}

// C(m,n) := alpha*op(A)*op(B) + beta*C — parallel over column blocks of C.
void dgemm_(const char* transa, const char* transb, const int* pm,
            const int* pn, const int* pk, const double* palpha,
            const double* A, const int* plda, const double* B, const int* pldb,
            const double* pbeta, double* C, const int* pldc) {
  const int m = *pm, n = *pn, k = *pk;
  if (m == 0 || n == 0) return;
  STAT_ADD(2.0 * m * n * k);
  GemmCtx ctx{m,    n,    k,           *plda,       *pldb, *pldc, 1,
              is_trans(*transa), is_trans(*transb), *palpha, *pbeta, A, B, C};
  // more blocks than threads + dynamic scheduling: on heterogeneous CPUs
  // (phone big.LITTLE) fast cores grab more blocks instead of idling while a
  // slow core finishes its equal share
  const int nt = std::min(threads_for(2.0 * m * n * k), n);
  ctx.nt = nt > 1 ? std::min(n, nt * 4) : 1;
  const GemmCtx* pc = &ctx;
  const int nb = ctx.nt;
#pragma omp parallel for schedule(dynamic) num_threads(nt) if (nt > 1)
  for (int t = 0; t < nb; t++) gemm_block(*pc, t);
}

// C(n,n) lower/upper triangle := alpha*op(A)*op(A)' + beta*C. The lower case
// (the one CHOLMOD uses) is parallelized over equal-area column blocks: each
// block owns a diagonal triangle (rank update) and the rectangle below it
// (gemm), both independent of the other blocks.
void dsyrk_(const char* uplo, const char* trans, const int* pn, const int* pk,
            const double* palpha, const double* A, const int* plda,
            const double* pbeta, double* C, const int* pldc) {
  const int n = *pn, k = *pk;
  if (n == 0) return;
  const bool tr = is_trans(*trans);
  const double alpha = *palpha, beta = *pbeta;
  if (!is_lower(*uplo)) {  // not used by CHOLMOD; serial fallback
    Mat Cm(C, n, n, OuterStride<>(*pldc));
    CMat Am(A, tr ? k : n, tr ? n : k, OuterStride<>(*plda));
    if (beta == 0.0) Cm.triangularView<Eigen::Upper>().setZero();
    else if (beta != 1.0) Cm.triangularView<Eigen::Upper>() *= beta;
    if (k > 0) {
      if (tr) Cm.selfadjointView<Eigen::Upper>().rankUpdate(Am.transpose(), alpha);
      else Cm.selfadjointView<Eigen::Upper>().rankUpdate(Am, alpha);
    }
    return;
  }
  STAT_ADD(1.0 * n * n * k);
  SyrkCtx ctx{n, k, *plda, *pldc, 1, tr, alpha, beta, A, C};
  const int nt = std::min(threads_for(1.0 * n * n * k), n);
  ctx.nt = nt > 1 ? std::min(n, nt * 4) : 1;
  const SyrkCtx* pc = &ctx;
  const int nb = ctx.nt;
#pragma omp parallel for schedule(dynamic) num_threads(nt) if (nt > 1)
  for (int t = 0; t < nb; t++) syrk_block(*pc, t);
}

// B := alpha*inv(op(A))*B (side L) or alpha*B*inv(op(A)) (side R) —
// parallel over the dimension of B the triangular solve does not couple.
void dtrsm_(const char* side, const char* uplo, const char* transa,
            const char* diag, const int* pm, const int* pn,
            const double* palpha, const double* A, const int* plda, double* B,
            const int* pldb) {
  const int m = *pm, n = *pn;
  if (m == 0 || n == 0) return;
  const bool onleft = (*side == 'L' || *side == 'l');
  TrsmCtx ctx{m,
              n,
              onleft ? m : n,
              *plda,
              *pldb,
              1,
              onleft,
              is_lower(*uplo),
              is_trans(*transa),
              is_unit(*diag),
              *palpha,
              A,
              B};
  const int split = onleft ? n : m;
  const int nt = std::min(threads_for(1.0 * ctx.asize * ctx.asize * split), split);
  ctx.nt = nt > 1 ? std::min(split, nt * 4) : 1;
  const TrsmCtx* pc = &ctx;
  const int nb = ctx.nt;
#pragma omp parallel for schedule(dynamic) num_threads(nt) if (nt > 1)
  for (int t = 0; t < nb; t++) trsm_block(*pc, t);
}

// x := inv(op(A))*x, single vector, serial.
void dtrsv_(const char* uplo, const char* trans, const char* diag,
            const int* pn, const double* A, const int* plda, double* X,
            const int* pincx) {
  const int n = *pn, incx = *pincx;
  if (n == 0) return;
  CMat Am(A, n, n, OuterStride<>(*plda));
  Eigen::Map<Eigen::VectorXd, 0, Eigen::InnerStride<>> x(X, n, Eigen::InnerStride<>(incx));
  Eigen::VectorXd tmp = x;  // triangular solve needs unit-stride storage
  with_tri(Am, is_lower(*uplo), is_trans(*trans), is_unit(*diag),
           [&](const auto& T) { T.solveInPlace(tmp); });
  x = tmp;
}

// y := alpha*op(A)*x + beta*y, serial.
void dgemv_(const char* trans, const int* pm, const int* pn,
            const double* palpha, const double* A, const int* plda,
            const double* X, const int* pincx, const double* pbeta, double* Y,
            const int* pincy) {
  const int m = *pm, n = *pn;
  if (m == 0 && n == 0) return;
  const bool tr = is_trans(*trans);
  const int xlen = tr ? m : n, ylen = tr ? n : m;
  CMat Am(A, m, n, OuterStride<>(*plda));
  Eigen::Map<const Eigen::VectorXd, 0, Eigen::InnerStride<>> x(X, xlen, Eigen::InnerStride<>(*pincx));
  Eigen::Map<Eigen::VectorXd, 0, Eigen::InnerStride<>> y(Y, ylen, Eigen::InnerStride<>(*pincy));
  const double alpha = *palpha, beta = *pbeta;
  if (beta == 0.0) y.setZero();
  else if (beta != 1.0) y *= beta;
  if (ylen == 0 || xlen == 0) return;
  if (tr) y.noalias() += alpha * (Am.transpose() * x);
  else y.noalias() += alpha * (Am * x);
}

// In-place lower Cholesky A = L*L' (LAPACK dpotrf, uplo='L'). Blocked
// right-looking; the trailing updates go through the parallel kernels above.
// On breakdown *info is the 1-based column, matching LAPACK.
void dpotrf_(const char* uplo, const int* pn, double* A, const int* plda,
             int* info) {
  const int n = *pn, lda = *plda;
  *info = 0;
  if (n == 0) return;
  if (!is_lower(*uplo)) unsupported("dpotrf(uplo='U')");
  Mat M(A, n, n, OuterStride<>(lda));
  const int nb = 96;
  const double one = 1.0, mone = -1.0;
  for (int kk = 0; kk < n; kk += nb) {
    const int b = std::min(nb, n - kk);
    auto Akk = M.block(kk, kk, b, b);
    // unblocked left-looking factor of the diagonal block
    for (int j = 0; j < b; j++) {
      double d = Akk(j, j) - Akk.row(j).head(j).squaredNorm();
      if (!(d > 0.0)) {
        *info = kk + j + 1;
        return;
      }
      d = std::sqrt(d);
      Akk(j, j) = d;
      const int rem = b - j - 1;
      if (rem > 0) {
        auto col = Akk.col(j).tail(rem);
        if (j > 0)
          col.noalias() -= Akk.bottomLeftCorner(rem, j) * Akk.row(j).head(j).transpose();
        col /= d;
      }
    }
    const int rem = n - kk - b;
    if (rem > 0) {
      // panel below the diagonal block: solve against L(kk)^T
      double* Apanel = A + (kk + b) + static_cast<size_t>(kk) * lda;
      dtrsm_("R", "L", "T", "N", &rem, &b, &one, A + kk + static_cast<size_t>(kk) * lda,
             plda, Apanel, plda);
      // trailing update of the remaining lower triangle
      const int ntrail = rem;
      dsyrk_("L", "N", &ntrail, &b, &mone, Apanel, plda, &one,
             A + (kk + b) + static_cast<size_t>(kk + b) * lda, plda);
    }
  }
}

// Complex routines: referenced by CHOLMOD's complex template instantiations,
// never called for real matrices. Signatures must match cholmod_blas.h so
// the wasm linker accepts them.
void zgemm_(char*, char*, int*, int*, int*, double*, double*, int*, double*,
            int*, double*, double*, int*) {
  unsupported("zgemm");
}
void zgemv_(char*, int*, int*, double*, double*, int*, double*, int*, double*,
            double*, int*) {
  unsupported("zgemv");
}
void zherk_(char*, char*, int*, int*, double*, double*, int*, double*,
            double*, int*) {
  unsupported("zherk");
}
void ztrsm_(char*, char*, char*, char*, int*, int*, double*, double*, int*,
            double*, int*) {
  unsupported("ztrsm");
}
void ztrsv_(char*, char*, char*, int*, double*, int*, double*, int*) {
  unsupported("ztrsv");
}
void zpotrf_(char*, int*, double*, int*, int*) { unsupported("zpotrf"); }

}  // extern "C"
