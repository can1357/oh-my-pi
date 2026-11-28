#!/usr/bin/env bash
# Install the same LLVM and target C/C++ sysroot as the pinned Bun release. Use
# only these two recipes, not the rest of its Buildkite machine bootstrap.
set -euo pipefail
case "$(uname -m)" in
  x86_64) host=x64; suffix= ;;
  aarch64) host=aarch64; suffix=-arm64 ;;
  *) exit 1 ;;
esac
case "$1" in
  linux-musl-*) abi=musl; triple="$(uname -m)-alpine-linux-musl" ;;
  linux-*) abi=glibc; triple="$(uname -m)-linux-gnu" ;;
  *) exit 1 ;;
esac
# Upstream's stock build image is arm64. Render its build recipes for this
# host so both LLVM and the apk.static used to install musl are executable.
bun -e '
  import { images, generateImage } from "./ci-bun/scripts/build/ci-images/spec.ts";
  const image = images.find(i => i.os === "linux" && i.distro === "debian" && i.arch === process.argv[1]);
  generateImage({ ...image, role: "build" }, process.argv[2]);
' "$host" "$RUNNER_TEMP"
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}
install_recipe() {
  local bootstrap="$RUNNER_TEMP/build/ci-images/linux-$host-debian/bootstrap.sh" section=$1
  local script="$RUNNER_TEMP/$section.sh"
  awk -v header="# ---- $section" '
    /^# ---- / { selected = ($0 == header); found += selected }
    selected { print }
    END { if (found != 1) exit 1 }
  ' "$bootstrap" > "$script"
  local bake_dir="$RUNNER_TEMP/bun-bake"
  mkdir -p "$bake_dir/observed"
  as_root env DEBIAN_FRONTEND=noninteractive BAKE_DIR="$bake_dir" sh -eu "$script"
}
as_root apt-get update -qq
# libclang for bindgen, CMake/Ninja for bundled libopus, zstd for the kit,
# and native GNU strip for compact final ELF load segments.
as_root apt-get install -y --no-install-recommends binutils libclang-dev cmake ninja-build libssl-dev pkg-config zstd
install_recipe llvm
install_recipe "$abi-sysroot"
echo /opt/llvm/bin >> "$GITHUB_PATH"
echo LLVM_BIN=/opt/llvm/bin >> "$GITHUB_ENV"
root="/opt/linux-sysroot-$abi$suffix"
rust_target="$(uname -m)-unknown-linux-${triple##*-}"
key=${rust_target//-/_}
# Cargo's native dependencies and its standalone helper executables must not
# accidentally link against the runner's glibc or newer libstdc++.
for compiler in clang clang++; do
  wrapper="$RUNNER_TEMP/target-$compiler"
  printf '#!/bin/sh\nexec /opt/llvm/bin/%s --target=%s --sysroot=%s --gcc-toolchain=%s/usr -fuse-ld=lld -Wno-unused-command-line-argument "$@"\n' \
    "$compiler" "$triple" "$root" "$root" > "$wrapper"
  chmod +x "$wrapper"
done
{
  echo "LINUX_${abi^^}_SYSROOT=$root"
  echo "CC_$key=$RUNNER_TEMP/target-clang"
  echo "CXX_$key=$RUNNER_TEMP/target-clang++"
  echo "CARGO_TARGET_${key^^}_LINKER=$RUNNER_TEMP/target-clang"
} >> "$GITHUB_ENV"
