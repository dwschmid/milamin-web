#!/usr/bin/env bash
# Build the sparse solver wasm: CHOLMOD supernodal Cholesky (SuiteSparse) on
# top of an Eigen-based BLAS shim (blas_shim.cpp), behind the C ABI in
# spchol.cpp. Two artifacts:
#   src/wasm/spchol.js     single-thread, runs everywhere
#   src/wasm/spchol-mt.js  pthreads + OpenMP, needs cross-origin isolation
#                          (COOP/COEP headers) in the browser
# Built with Emscripten 6.0.3 (the shipped binaries; record the version here
# when rebuilding). Requires emsdk (source ~/emsdk/emsdk_env.sh with python
# >= 3.10 on PATH),
# the Eigen headers in ./eigen, and SuiteSparse 5.13 in ./suitesparse
# (SuiteSparse_config, AMD, COLAMD, CHOLMOD), e.g.:
#   curl -sL https://github.com/DrTimothyAldenDavis/SuiteSparse/archive/refs/tags/v5.13.0.tar.gz \
#     | tar -xz --strip-components=1 --one-top-level=suitesparse \
#       SuiteSparse-5.13.0/{SuiteSparse_config,AMD,COLAMD,CHOLMOD}
# Output goes to ../src/wasm/ and is committed, so the site builds without a
# C++ toolchain. Licensing note: CHOLMOD's Supernodal module is GPL-2.0+.
set -euo pipefail
cd "$(dirname "$0")"

# Eigen 3.4 guards a GCC inline-asm workaround with EIGEN_COMP_GNUC, which is
# also true under clang/wasm where the x86 asm cannot compile; restrict it to
# real GCC (idempotent).
sed -i 's/#if EIGEN_COMP_GNUC && EIGEN_COMP_GNUC < 63/#if EIGEN_COMP_GNUC_STRICT \&\& EIGEN_COMP_GNUC < 63/' \
  eigen/Eigen/src/Core/arch/SSE/PacketMath.h

SS=suitesparse
CHOLMOD_DEFS="-DNPARTITION -DNCAMD -DNGPU -DNCHECK"
INCS="-I $SS/CHOLMOD/Include -I $SS/SuiteSparse_config -I $SS/AMD/Include -I $SS/COLAMD/Include"
COPT="-O3 -msimd128"
CXXOPT="$COPT -msse2 -std=c++17 -I compat -I eigen"

C_SRC="$SS/SuiteSparse_config/SuiteSparse_config.c $SS/COLAMD/Source/colamd.c"
for f in 1 2 aat control defaults dump global info order post_tree postorder preprocess valid; do
  C_SRC="$C_SRC $SS/AMD/Source/amd_$f.c"
done
for f in aat add band change_factor common complex copy dense error factor memory sparse transpose triplet version; do
  C_SRC="$C_SRC $SS/CHOLMOD/Core/cholmod_$f.c"
done
for f in amd analyze colamd etree factorize postorder rcond resymbol rowcolcounts rowfac solve spsolve; do
  C_SRC="$C_SRC $SS/CHOLMOD/Cholesky/cholmod_$f.c"
done
for f in super_numeric super_solve super_symbolic; do
  C_SRC="$C_SRC $SS/CHOLMOD/Supernodal/cholmod_$f.c"
done

LINK_COMMON="-s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createSpchol \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=2MB \
  -s EXPORTED_FUNCTIONS=[_spchol_factor,_spchol_solve,_spchol_nnzL,_spchol_free,_spchol_threads,_malloc,_free] \
  -s EXPORTED_RUNTIME_METHODS=[HEAP32,HEAPF64]"

mkdir -p ../src/wasm

# CHOLMOD's own "#pragma omp" loops must stay serial: emscripten's OpenMP
# runtime caps outlined-region args at 16 and CHOLMOD's scatter loops exceed
# that. The flops all live in the BLAS shim, which gets -fopenmp; the C
# sources get only -pthread so the objects share the atomics ABI.
build_variant() {  # $1 = st|mt, $2 = C flags, $3 = C++ flags, $4 = output, $5 = extra link flags
  local variant=$1 cflags=$2 cxxflags=$3 out=$4
  local dir=build-$variant
  mkdir -p $dir
  local objs=""
  for src in $C_SRC; do
    local obj=$dir/$(basename "${src%.c}").o
    [ "$obj" -nt "$src" ] || emcc $COPT $cflags $CHOLMOD_DEFS $INCS -c "$src" -o "$obj"
    objs="$objs $obj"
  done
  emcc $CXXOPT $cxxflags $INCS -c blas_shim.cpp -o $dir/blas_shim.o
  emcc $CXXOPT $cxxflags $INCS -c spchol.cpp -o $dir/spchol.o
  # shellcheck disable=SC2086
  emcc $objs $dir/blas_shim.o $dir/spchol.o $cxxflags $LINK_COMMON \
    ${5:-} -o ../src/wasm/$out.js
}

build_variant st "" "" spchol
build_variant mt "-pthread" "-pthread -fopenmp" spchol-mt \
  "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency||8 -sDEFAULT_PTHREAD_STACK_SIZE=2MB"

ls -la ../src/wasm/
