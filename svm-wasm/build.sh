#!/usr/bin/env bash
# Builds LiteSVM to wasm64 (memory64), optimises it with wasm-opt, and writes the
# artifact the extension bundles: src/sim/svm.wasm (stable path, committed).
#
# Needs: the toolchain pinned in rust-toolchain.toml (rustup installs it on first use,
# with rust-src + llvm-tools), a clang that knows the wasm64 target (Apple clang does)
# for blst's C code, and binaryen's wasm-opt (brew install binaryen).
#   WASM_OPT_LEVEL=-O3 svm-wasm/build.sh   # default -Oz: smallest, same run-time speed as -O3 (docs/wasm-svm.md); -O3 builds faster
set -euo pipefail
cd "$(dirname "$0")"

SYSROOT="$(rustc --print sysroot)"
HOST="$(rustc -vV | sed -n 's/^host: //p')"
# Apple's /usr/bin/ar writes an archive without a wasm symbol index, so blst's
# libblst.a links as empty. llvm-ar from llvm-tools does it right.
export AR_wasm64_unknown_unknown="$SYSROOT/lib/rustlib/$HOST/bin/llvm-ar"
export CC_wasm64_unknown_unknown="${CC_wasm64_unknown_unknown:-clang}"

cargo build --locked --target wasm64-unknown-unknown --release
RAW=target/wasm64-unknown-unknown/release/svm_wasm.wasm
OUT=../src/sim/svm.wasm

command -v wasm-opt >/dev/null || { echo "wasm-opt not found (brew install binaryen)" >&2; exit 1; }
wasm-opt "${WASM_OPT_LEVEL:--Oz}" --strip-debug --strip-producers \
  --enable-memory64 --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
  --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
  "$RAW" -o "$OUT"
echo "raw $(wc -c < "$RAW") bytes -> $OUT $(wc -c < "$OUT") bytes (gzip $(gzip -9 -c "$OUT" | wc -c))"
