#!/usr/bin/env bash
# Rebuild Shewchuk's Triangle 1.6 to wasm with GROWABLE memory — the upstream
# triangle-wasm npm build has a fixed 16 MB heap and OOMs near 250k-dof meshes.
# The bundled sources in triangle/ retain Shewchuk's separate terms in its
# README. To refresh the upstream source distribution:
#   curl -sL http://www.netlib.org/voronoi/triangle.zip -o triangle/triangle.zip
#   (cd triangle && unzip triangle.zip)
# Output goes to ../src/vendor/triangle/ and is committed.
# Same flags as upstream (lib/build.sh in brunoimbrizi/triangle-wasm) plus
# MODULARIZE/ES6, memory growth, and exported heap views for the wrapper.
# NOTE: no -ffast-math and no SIMD — Triangle's exact geometric predicates
# depend on strict IEEE double arithmetic.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ../src/vendor/triangle
emcc triangle/triangle.c \
  -I triangle \
  -DTRILIBRARY \
  -O2 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createTriangle \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s EXPORTED_FUNCTIONS='["_triangulate","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["lengthBytesUTF8","stringToUTF8","HEAP32","HEAPF64"]' \
  -o ../src/vendor/triangle/triangle.out.js

ls -la ../src/vendor/triangle/
