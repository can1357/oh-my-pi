#!/usr/bin/env bash
# Fetches the python-build-standalone "full" archive (static libpython +
# stdlib) and generates the build inputs omp-py derives from it:
#   <dest>/python/stdlib.bin       in-memory stdlib blob embedded by omp-py
#   <dest>/python/pyo3-config.txt  static-link config consumed via PYO3_CONFIG_FILE
#   crates/py/THIRD-PARTY-NOTICES.txt (checkout mode) from PYTHON.json,
#                                      its license corpus, and frozen wheels
#
# Usage: fetch-python.sh [dest-dir]
#   dest-dir  directory that receives the `python/` tree; defaults to the
#             repo checkout's `vendor/` when run from a checkout. Consumers
#             building the published crate pass an explicit directory and
#             point PYO3_CONFIG_FILE at <dest>/python/pyo3-config.txt.
#
# Idempotent: re-running regenerates derived artifacts for missing trees only.
#
# Desktop targets:
#   - macOS `python` uses freethreaded+debug (machine-code .a, fast dev
#     linking with default linker, zero LTO overhead)
#   - macOS `python-release` uses freethreaded+pgo+lto (LLVM LTO bitcode,
#     linked with Homebrew LLD via scripts/ld64.lld; marked with `needs-lld`)
#   - Linux `python` uses freethreaded+debug.
# Android aarch64 uses the installed GIL-enabled Termux CPython 3.14 shared
# library and writes `python-android/pyo3-config.txt`.
set -euo pipefail

TAG=20260807
VER=3.14.7

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CRATE_DIR=$(dirname "$SCRIPT_DIR")

if [ $# -ge 1 ]; then
	DEST=$(mkdir -p "$1" && cd "$1" && pwd)
	REPO_MODE=
else
	DEST="$CRATE_DIR/../../vendor"
	mkdir -p "$DEST"
	DEST=$(cd "$DEST" && pwd)
	REPO_MODE=1
fi

REQ="$CRATE_DIR/requirements.txt"
# Resolve the requested Cargo target through rustc's target cfg. Host-platform
# queries only describe the machine running setup-python and are wrong when
# Cargo builds a different target (and do not identify Android reliably).
TARGET="${OMP_PY_TARGET:-${CARGO_BUILD_TARGET:-${TARGET:-}}}"
if [ -z "$TARGET" ]; then
	TARGET=$(rustc -vV | sed -n 's/^host: //p')
fi
[ -n "$TARGET" ] || {
	echo "error: cannot determine the Cargo target; set OMP_PY_TARGET" >&2
	exit 1
}
TARGET_CFG=$(rustc --print cfg --target "$TARGET")
cfg_value() {
	printf '%s\n' "$TARGET_CFG" | sed -n "s/^$1=\"\\([^\"]*\\)\"$/\\1/p"
}
TARGET_OS=$(cfg_value target_os)
TARGET_ARCH=$(cfg_value target_arch)
[ -n "$TARGET_OS" ] || {
	echo "error: rustc emitted no target_os cfg for $TARGET" >&2
	exit 1
}

prepare_android_tree() {
	local VENDOR_NAME="${OMP_PY_VENDOR_NAME:-python-android}"
	local VENDOR="$DEST/$VENDOR_NAME"
	local PYTHON="${OMP_PYTHON:-python3.14}"
	if [[ "$PYTHON" != */* ]]; then
		PYTHON=$(command -v "$PYTHON" || true)
	fi
	if [ ! -x "$PYTHON" ]; then
		echo "error: Android setup needs an executable CPython 3.14; set OMP_PYTHON" >&2
		exit 1
	fi

	local INFO
	if ! INFO=$("$PYTHON" -c '
import struct
import sys
import sysconfig

if platform := getattr(sys, "implementation", None):
    name = platform.name
else:
    name = ""
if name != "cpython":
    raise SystemExit("expected CPython, got " + (name or "unknown"))
if tuple(sys.version_info[:2]) != (3, 14):
    raise SystemExit(f"expected CPython 3.14, got {sys.version.split()[0]}")
gil_check = getattr(sys, "_is_gil_enabled", None)
if gil_check is None or not gil_check():
    raise SystemExit("free-threaded CPython is not supported on Android")
if str(sysconfig.get_config_var("Py_GIL_DISABLED") or "").lower() in {"1", "true", "yes"}:
    raise SystemExit("free-threaded CPython is not supported on Android")
library = str(sysconfig.get_config_var("LDLIBRARY") or "")
if not library.startswith("libpython3.14") or ".so" not in library:
    raise SystemExit("expected shared libpython3.14.so, got " + (library or "none"))
values = (
    sys.executable,
    library,
    str(sysconfig.get_config_var("LIBDIR") or ""),
    str(sysconfig.get_path("stdlib") or ""),
    str(sysconfig.get_config_var("DESTSHARED") or ""),
    str(sysconfig.get_path("purelib") or ""),
    str(struct.calcsize("P") * 8),
)
if any(not value for value in values):
    raise SystemExit("CPython sysconfig did not provide the Android runtime paths")
print("\n".join(values))
'); then
		echo "error: OMP_PYTHON must be a GIL-enabled system CPython 3.14" >&2
		exit 1
	fi
	local -a INFO_ROWS
	mapfile -t INFO_ROWS <<< "$INFO"
	if [ "${#INFO_ROWS[@]}" -ne 7 ]; then
		echo "error: CPython sysconfig returned incomplete Android runtime metadata" >&2
		exit 1
	fi
	local PYTHON_EXE="${INFO_ROWS[0]}"
	local LIBRARY="${INFO_ROWS[1]}"
	local LIB_DIR="${INFO_ROWS[2]}"
	local STDLIB_DIR="${INFO_ROWS[3]}"
	local DYNLOAD_DIR="${INFO_ROWS[4]}"
	local PURELIB_DIR="${INFO_ROWS[5]}"
	local POINTER_WIDTH="${INFO_ROWS[6]}"
	if [ "$POINTER_WIDTH" != "64" ]; then
		echo "error: Android omp-py requires a 64-bit CPython, got ${POINTER_WIDTH}-bit" >&2
		exit 1
	fi
	for path in "$LIB_DIR" "$STDLIB_DIR" "$DYNLOAD_DIR" "$PURELIB_DIR"; do
		if [ ! -d "$path" ]; then
			echo "error: CPython sysconfig path is missing: $path" >&2
			exit 1
		fi
	done

	mkdir -p "$VENDOR"
	local BUNDLED="$VENDOR/bundled"
	if grep -qvE '^[[:space:]]*(#|$)' "$REQ"; then
		if ! cmp -s "$REQ" "$BUNDLED/.requirements.stamp" 2>/dev/null; then
			echo "fetching bundled pure-Python packages for ${VENDOR_NAME}..." >&2
			local TMP
			TMP=$(mktemp -d "$DEST/bundled-py.XXXXXX")
			trap 'rm -rf "$TMP"' EXIT
			uv pip install --link-mode=copy --python "$PYTHON_EXE" --target "$TMP" \
				--only-binary :all: --require-hashes -r "$REQ"
			local NATIVE
			NATIVE=$(find "$TMP" \( -name '*.so' -o -name '*.dylib' -o -name '*.pyd' \))
			if [ -n "$NATIVE" ]; then
				echo "error: $REQ pulled native extensions; only pure-Python packages can be" >&2
				echo "frozen — install native wheels into site-packages instead:" >&2
				echo "$NATIVE" >&2
				exit 1
			fi
			cp "$REQ" "$TMP/.requirements.stamp"
			rm -rf "$BUNDLED"
			mv "$TMP" "$BUNDLED"
			trap - EXIT
		fi
	else
		rm -rf "$BUNDLED"
		mkdir -p "$BUNDLED"
	fi

	# Build.rs reads this explicit output instead of guessing Termux's prefix.
	cat > "$VENDOR/python-paths.env" <<EOF
OMP_PY_STDLIB_PATH=$STDLIB_DIR
OMP_PY_DYNLOAD_PATH=$DYNLOAD_DIR
OMP_PY_SYSTEM_SITE=$PURELIB_DIR
OMP_PY_BUNDLED_SITE=$BUNDLED
EOF

	local LIB_NAME="${LIBRARY#lib}"
	LIB_NAME="${LIB_NAME%%.so*}"
	echo "generating ${VENDOR_NAME}/pyo3-config.txt..." >&2
	cat > "$VENDOR/pyo3-config.txt" <<EOF
implementation=CPython
version=3.14
shared=true
abi3=false
lib_name=${LIB_NAME}
lib_dir=${LIB_DIR}
executable=${PYTHON_EXE}
pointer_width=${POINTER_WIDTH}
build_flags=
suppress_build_script_link_lines=false
EOF

	echo "done: ${VENDOR} (${LIB_NAME}, GIL-enabled system CPython)" >&2
}

prepare_tree() {
	local TRIPLE="$1"
	local BUILD="$2"
	local VENDOR_NAME="$3"
	local NEEDS_LLD="$4"

	local VENDOR="$DEST/$VENDOR_NAME"
	local NAME="cpython-${VER}+${TAG}-${TRIPLE}-${BUILD}-full"
	local URL="https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/${NAME}.tar.zst"

	local NEEDS_FETCH=1
	if [ -f "$VENDOR/.archive.stamp" ]; then
		local CURRENT_ARCHIVE
		CURRENT_ARCHIVE=$(cat "$VENDOR/.archive.stamp" 2>/dev/null || true)
		if [ "$CURRENT_ARCHIVE" = "$NAME" ]; then
			NEEDS_FETCH=0
		else
			echo "archive mismatch in ${VENDOR_NAME}: expected ${NAME}, found ${CURRENT_ARCHIVE}; refetching..." >&2
		fi
	fi

	if [ "$NEEDS_FETCH" = "1" ]; then
		echo "fetching ${NAME} into ${VENDOR_NAME}..." >&2
		local TMP_EXTRACT
		TMP_EXTRACT=$(mktemp -d "$DEST/.fetch-py.XXXXXX")
		curl -fsSL "$URL" | zstd -d | tar -x -C "$TMP_EXTRACT"
		rm -rf "$VENDOR"
		mv "$TMP_EXTRACT/python" "$VENDOR"
		echo "$NAME" > "$VENDOR/.archive.stamp"
		rm -rf "$TMP_EXTRACT"
	fi
	if [ "$NEEDS_LLD" = "1" ]; then
		touch "$VENDOR/needs-lld"
	else
		rm -f "$VENDOR/needs-lld"
	fi

	local STDLIB_DIR
	STDLIB_DIR=$(dirname "$(echo "$VENDOR"/install/lib/python3.14*/os.py)")
	local CONFIG_LIBS=("$STDLIB_DIR"/config-3.14*/libpython3.14*.a)
	if [ "${#CONFIG_LIBS[@]}" -ne 1 ] || [ ! -f "${CONFIG_LIBS[0]}" ]; then
		echo "error: expected exactly one static libpython under $STDLIB_DIR/config-3.14*" >&2
		exit 1
	fi
	local CONFIG_DIR
	CONFIG_DIR=$(dirname "${CONFIG_LIBS[0]}")
	local LIB_NAME
	LIB_NAME=$(basename "${CONFIG_LIBS[0]}" .a | sed 's/^lib//')
	local EXECUTABLE="$VENDOR/install/bin/python3.14td"
	[ -x "$EXECUTABLE" ] || EXECUTABLE="$VENDOR/install/bin/python3.14t"

	echo "generating ${VENDOR_NAME}/stdlib.bin..." >&2
	"$EXECUTABLE" "$SCRIPT_DIR/pack-pymodules.py" "$STDLIB_DIR" "$VENDOR/stdlib.bin" \
		--prefix '<omp-stdlib>' \
		--exclude lib-dynload test idlelib tkinter turtledemo ensurepip \
		          site-packages __pycache__ 'config-*'

	local BUNDLED="$VENDOR/bundled"
	if grep -qvE '^[[:space:]]*(#|$)' "$REQ"; then
		if ! cmp -s "$REQ" "$BUNDLED/.requirements.stamp" 2>/dev/null; then
			echo "fetching bundled python packages for ${VENDOR_NAME}..." >&2
			local TMP
			TMP=$(mktemp -d "$VENDOR/bundled.XXXXXX")
			trap 'rm -rf "$TMP"' EXIT
			uv pip install --link-mode=copy --python "$EXECUTABLE" --target "$TMP" \
				--only-binary :all: --require-hashes -r "$REQ"
			local NATIVE
			NATIVE=$(find "$TMP" -name '*.so' -o -name '*.dylib' -o -name '*.pyd')
			if [ -n "$NATIVE" ]; then
				echo "error: $REQ pulled native extensions; only pure-Python packages can be" >&2
				echo "frozen — install native wheels into site-packages instead:" >&2
				echo "$NATIVE" >&2
				exit 1
			fi
			cp "$REQ" "$TMP/.requirements.stamp"
			rm -rf "$BUNDLED"
			mv "$TMP" "$BUNDLED"
			trap - EXIT
		fi
	else
		rm -rf "$BUNDLED"
	fi

	echo "generating ${VENDOR_NAME}/pyo3-config.txt..." >&2
	cat > "$VENDOR/pyo3-config.txt" <<EOF
implementation=CPython
version=3.14
shared=false
abi3=false
lib_name=${LIB_NAME}
lib_dir=${CONFIG_DIR}
executable=${EXECUTABLE}
pointer_width=64
build_flags=$(case "$LIB_NAME" in *td) echo "Py_DEBUG,Py_GIL_DISABLED";; *) echo "Py_GIL_DISABLED";; esac)
suppress_build_script_link_lines=false
EOF

	echo "done: ${VENDOR} (${LIB_NAME})" >&2
}

case "$TARGET_OS:$TARGET_ARCH" in
	android:aarch64)
		prepare_android_tree
		;;
	macos:aarch64)
		prepare_tree "aarch64-apple-darwin" "freethreaded+debug" "python" "0"
		prepare_tree "aarch64-apple-darwin" "freethreaded+pgo+lto" "python-release" "1"
		;;
	linux:x86_64)
		prepare_tree "x86_64-unknown-linux-gnu" "freethreaded+debug" "python" "0"
		;;
	*)
		echo "error: no embedded Python archive configured for Cargo target $TARGET" >&2
		exit 1
		;;
esac

if [ -n "$REPO_MODE" ] && [ "$TARGET_OS" != "android" ]; then
	DEV_EXE="$DEST/python/install/bin/python3.14td"
	[ -x "$DEV_EXE" ] || DEV_EXE="$DEST/python/install/bin/python3.14t"
	"$DEV_EXE" "$SCRIPT_DIR/gen-py-notices.py" "$DEST/python" "$CRATE_DIR/THIRD-PARTY-NOTICES.txt"
fi
