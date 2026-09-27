#!/bin/sh
# Builds the Apple Foundation Models bridge static library for pi-natives.
# Shared by build.rs and the Bazel `applefm_bridge` genrule/repository rule.
#
#   build-bridge.sh detect
#       Prints "<swiftc>\t<sdk>\t<fingerprint>" for the first toolchain able to
#       build bridge.swift (Swift 6.4+ with the macOS 27+ SDK), or nothing.
#       Candidates: $OMP_APPLEFM_SWIFTC with $SDKROOT (or the selected SDK), the
#       xcode-select'ed toolchain, then the Command Line Tools. Probes versions
#       only; never compiles.
#
#   build-bridge.sh build <out.a> <arch> [<swiftc> <sdk>]
#       Compiles bridge.swift into <out.a> with the given toolchain. Without a
#       toolchain, or for a non-arm64 <arch> (Foundation Models needs Apple
#       silicon), compiles stub.c instead, which reports the bridge as not built.
#
# Swift module caches live in $OMP_APPLEFM_MODULE_CACHE (default: under
# $TMPDIR) so repeated builds skip re-importing the SDK.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

swift_version() {
	"$1" -version 2>/dev/null | sed -n 's/.*Swift version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' | head -n 1
}

sdk_major() {
	/usr/bin/plutil -extract Version raw "$1/SDKSettings.plist" 2>/dev/null | cut -d. -f1
}

usable() {
	[ -n "$1" ] && [ -x "$1" ] && [ -n "$2" ] && [ -d "$2/System/Library/Frameworks/FoundationModels.framework" ] || return 1
	set -- "$1" "$2" $(swift_version "$1")
	[ $# -eq 4 ] || return 1
	[ "$3" -gt 6 ] || { [ "$3" -eq 6 ] && [ "$4" -ge 4 ]; } || return 1
	major=$(sdk_major "$2")
	[ -n "$major" ] && [ "$major" -ge 27 ]
}

detect() {
	selected_sdk=${SDKROOT:-$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)}
	clt=/Library/Developer/CommandLineTools
	for candidate in \
		"${OMP_APPLEFM_SWIFTC:-}|$selected_sdk" \
		"$(/usr/bin/xcrun --find swiftc 2>/dev/null || true)|$selected_sdk" \
		"$clt/usr/bin/swiftc|$clt/SDKs/MacOSX.sdk"; do
		swiftc=${candidate%%|*}
		sdk=${candidate#*|}
		if usable "$swiftc" "$sdk"; then
			sdk=$(cd "$sdk" && pwd -P)
			fingerprint="$("$swiftc" -version 2>/dev/null | head -n 1) / SDK $(/usr/bin/plutil -extract ProductBuildVersion raw "$sdk/System/Library/CoreServices/SystemVersion.plist" 2>/dev/null || sdk_major "$sdk")"
			printf '%s\t%s\t%s\n' "$swiftc" "$sdk" "$fingerprint"
			return 0
		fi
	done
}

build() {
	out=$1
	arch=$2
	swiftc=${3:-}
	sdk=${4:-}
	rm -f "$out"
	if [ "$arch" = arm64 ] && [ -n "$swiftc" ]; then
		cache=${OMP_APPLEFM_MODULE_CACHE:-${TMPDIR:-/tmp}/omp-applefm-module-cache}
		# FoundationModels is weak-linked by the addon link step instead of
		# autolinked, so the addon still loads on macOS releases without it.
		"$swiftc" -emit-library -static -parse-as-library -module-name OmpAppleFm \
			-sdk "$sdk" -target arm64-apple-macos12.0 -swift-version 6 -O \
			-module-cache-path "$cache" \
			-Xfrontend -disable-autolink-framework -Xfrontend FoundationModels \
			"$here/bridge.swift" -o "$out"
		return
	fi
	objects=$(mktemp -d)
	trap 'rm -rf "$objects"' EXIT
	/usr/bin/xcrun clang -c -O2 -arch "$arch" -mmacosx-version-min=11.0 "$here/stub.c" -o "$objects/stub.o"
	/usr/bin/xcrun libtool -static -o "$out" "$objects/stub.o"
}

case "${1:-}" in
detect) detect ;;
build)
	shift
	build "$@"
	;;
*)
	echo "usage: $0 detect | build <out.a> <arch> [<swiftc> <sdk>]" >&2
	exit 2
	;;
esac
