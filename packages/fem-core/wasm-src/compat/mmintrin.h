/* Shim for building Eigen with emscripten SIMD: wasm has no MMX, and
 * emscripten ships no mmintrin.h, so the x86-only header from clang's
 * resource directory would be picked up and fail. Eigen 3.4 includes
 * <mmintrin.h> unconditionally when SSE vectorization is on but only uses
 * SSE1/2 intrinsics, which emscripten's xmmintrin.h/emmintrin.h provide
 * (including the __m64 type for partial loads). An empty header satisfies
 * the include. Keep this directory on the include path before the system
 * headers (emcc -I compat).
 */
#pragma once
