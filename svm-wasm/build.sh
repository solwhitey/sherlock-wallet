#!/usr/bin/env bash
# Builds LiteSVM to wasm64 (memory64) and copies the module to src/sim/svm.wasm.
#
# Needs: nightly Rust with rust-src + llvm-tools (wasm64 is tier 3, std is
# rebuilt with -Zbuild-std, see .cargo/config.toml), and a clang that knows the
# wasm64 target (Apple clang does) for blst's C code (BLS12-381 syscalls).
#   rustup toolchain install nightly --component rust-src llvm-tools
set -euo pipefail
cd "$(dirname "$0")"

SYSROOT="$(rustc +nightly --print sysroot)"
HOST="$(rustc +nightly -vV | sed -n 's/^host: //p')"
# Apple's /usr/bin/ar writes an archive without a wasm symbol index, so blst's
# libblst.a links as empty. llvm-ar from llvm-tools does it right.
export AR_wasm64_unknown_unknown="$SYSROOT/lib/rustlib/$HOST/bin/llvm-ar"
export CC_wasm64_unknown_unknown="${CC_wasm64_unknown_unknown:-clang}"

cargo +nightly build --target wasm64-unknown-unknown --release
OUT=target/wasm64-unknown-unknown/release/svm_wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-memory64 --enable-bulk-memory --enable-sign-ext \
    --enable-mutable-globals --enable-nontrapping-float-to-int \
    "$OUT" -o "$OUT.opt" && mv "$OUT.opt" "$OUT"
fi
cp "$OUT" ../src/sim/svm.wasm
ls -la ../src/sim/svm.wasm
