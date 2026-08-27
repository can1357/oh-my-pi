#!/bin/sh
# cc shim for sha2-asm's build script under the hermetic zig cross toolchains.
#
# Two flags cc-rs emits are fatal to zig cc:
#   * `--target=aarch64-unknown-linux-gnu`: the zig launcher appends its glibc
#     suffix to a caller-supplied --target, producing the invalid 4-component
#     triple `aarch64-unknown-linux-gnu.2.17`. Dropped — the launcher already
#     injects the correct `-target aarch64-linux-gnu.2.17`.
#   * `-march=armv8-a+crypto` (hardcoded in sha2-asm's build.rs): zig parses
#     -march values with its own <cpu>+<feature> syntax and rejects `armv8-a`.
#     Rewritten to the assembler-scoped `-Wa,-march=…`, which zig forwards
#     untouched (zig -mcpu features never reach .S assembly jobs).
#
# `CC` still points at the real zig wrapper: cc-rs selects this shim through
# the target-scoped CC_<triple> override, which has higher precedence.
set -eu
n=$#
while [ "$n" -gt 0 ]; do
	arg=$1
	shift
	n=$((n - 1))
	case $arg in
		--target=*) ;;
		-march=armv8-a+crypto) set -- "$@" "-Wa,$arg" ;;
		*) set -- "$@" "$arg" ;;
	esac
done
exec "$CC" "$@"
