#!/usr/bin/env bash
# Pack the GPL corresponding source of the solver wasm binaries
# (src/wasm/spchol*.wasm): our shim and build script, the SuiteSparse 5.13.0
# modules that are compiled in, and the Eigen 3.4.0 headers, with every
# license text. Output: apps/milamin/public/downloads/milamin-solver-wasm-source.zip,
# offered on the site's licenses page. Downloads the upstream tarballs into a
# temp dir (they are not kept in the repo).
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(cd ../../../apps/milamin/public && pwd)/downloads/milamin-solver-wasm-source.zip"
SS_VER=5.13.0
EIGEN_VER=3.4.0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/milamin-solver-wasm-source" "$(dirname "$OUT")"
cd "$TMP"

curl -fSL -o suitesparse.tar.gz "https://github.com/DrTimothyAldenDavis/SuiteSparse/archive/refs/tags/v$SS_VER.tar.gz"
curl -fSL -o eigen.tar.gz "https://gitlab.com/libeigen/eigen/-/archive/$EIGEN_VER/eigen-$EIGEN_VER.tar.gz"
tar -xzf suitesparse.tar.gz
tar -xzf eigen.tar.gz

D=milamin-solver-wasm-source
mkdir -p "$D/wasm-src/compat" "$D/suitesparse-$SS_VER" "$D/eigen-$EIGEN_VER"
cp "$OLDPWD"/spchol.cpp "$OLDPWD"/blas_shim.cpp "$OLDPWD"/build.sh "$D/wasm-src/"
cp "$OLDPWD"/compat/* "$D/wasm-src/compat/"
S="SuiteSparse-$SS_VER"
cp "$S/LICENSE.txt" "$S/README.md" "$D/suitesparse-$SS_VER/"
cp -r "$S/SuiteSparse_config" "$D/suitesparse-$SS_VER/"
for m in AMD COLAMD CHOLMOD; do
  mkdir -p "$D/suitesparse-$SS_VER/$m/Doc"
  cp -r "$S/$m/Include" "$S/$m/Source" "$D/suitesparse-$SS_VER/$m/" 2>/dev/null || true
  for sub in Core Cholesky Supernodal Check; do
    [ -d "$S/$m/$sub" ] && cp -r "$S/$m/$sub" "$D/suitesparse-$SS_VER/$m/"
  done
  cp "$S/$m/Doc/License.txt" "$D/suitesparse-$SS_VER/$m/Doc/" 2>/dev/null || true
  cp "$S/$m/README.txt" "$D/suitesparse-$SS_VER/$m/" 2>/dev/null || true
done
E="eigen-$EIGEN_VER"
cp -r "$E/Eigen" "$D/$E/"
cp "$E"/COPYING.* "$E/README.md" "$D/$E/"

cat > "$D/README.txt" <<TXT
MilAMin browser solver: corresponding source of spchol.wasm / spchol-mt.wasm
(https://milamin.org/about/licenses.html)

wasm-src/           our C interface to CHOLMOD (spchol.cpp), the Eigen-based BLAS layer
                    (blas_shim.cpp), the emscripten build script with the exact
                    flags (build.sh) and the compat header; GPL-2.0-or-later,
                    copyright Dani Schmid 2026
suitesparse-$SS_VER/ the SuiteSparse modules compiled in: SuiteSparse_config,
                    AMD, COLAMD (BSD-3-Clause), CHOLMOD Core/Cholesky/Check
                    (LGPL-2.1-or-later) and Supernodal (GPL-2.0-or-later);
                    copyright Timothy A. Davis et al., see LICENSE.txt and
                    each module's Doc/License.txt
eigen-$EIGEN_VER/       the Eigen headers (MPL-2.0), see COPYING.MPL2

Build: install emsdk (Emscripten 6.0.3 built the shipped binaries; python
>= 3.10 on PATH), place suitesparse-$SS_VER as
wasm-src/suitesparse and eigen-$EIGEN_VER as wasm-src/eigen, then run
wasm-src/build.sh. The Triangle mesher (triangle.out.wasm) is a separate
program built from Jonathan Shewchuk's Triangle 1.6 and is not part of this
bundle.
TXT

rm -f "$OUT"
zip -qr "$OUT" "$D"
ls -la "$OUT"
