#!/usr/bin/env bash
# Builds LibRaw (unpack-only wrapper) to WebAssembly with SIMD.
#   LIBRAW_SRC=/path/to/LibRaw-0.22.2 ./native/libraw/build.sh
# Output: src/decode/wasm/libraw.{js,wasm}
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="${LIBRAW_SRC:?set LIBRAW_SRC to an unpacked LibRaw 0.22.x source tree}"
OUT="${OUT:-$ROOT/src/decode/wasm}"
OBJ="$HERE/obj"
mkdir -p "$OUT" "$OBJ"

# Same object list as LibRaw's Makefile.dist, minus the optional RawSpeed / DNG SDK glue
# (compiled as stubs when their USE_ macros are not defined).
FILES=$(grep -A40 '^LIB_OBJECTS' "$SRC/Makefile.dist" | sed -n '1,/^$/p' | grep -o 'object/[a-z0-9_]*\.o' | sed 's#object/##; s#\.o$##')

CXXFLAGS="-O3 -msimd128 -DLIBRAW_NOTHREADS -DUSE_ZLIB -DUSE_JPEG -DUSE_JPEG8 -sUSE_ZLIB=1 -sUSE_LIBJPEG=1 -I$SRC -w"

pids=()
for f in $FILES; do
  src=$(find "$SRC/src" -name "$f.cpp" | head -1)
  [ -z "$src" ] && { echo "missing $f"; exit 1; }
  if [ ! -f "$OBJ/$f.o" ] || [ "$src" -nt "$OBJ/$f.o" ]; then
    em++ $CXXFLAGS -c "$src" -o "$OBJ/$f.o" &
    pids+=($!)
    if [ ${#pids[@]} -ge 8 ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
  fi
done
wait

em++ $CXXFLAGS "$HERE/wrapper.cpp" "$OBJ"/*.o -o "$OUT/libraw.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibRaw \
  -sENVIRONMENT=${EM_ENV:-web,worker} -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -sINITIAL_MEMORY=64MB -sSTACK_SIZE=2MB -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_lr_open,_lr_unpack,_lr_strerror,_lr_raw_kind,_lr_raw_ptr,_lr_meta_json,_lr_close,_lr_malloc,_lr_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,UTF8ToString \
  -sDISABLE_EXCEPTION_CATCHING=0
ls -la "$OUT"
