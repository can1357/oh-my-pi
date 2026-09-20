#!/bin/sh
set -eu

# package-macos.sh <path-to-omp-binary>
# Emits dist/omp-<short-sha>-aarch64-apple-darwin.{tar.gz,pkg,sha256}, matching
# the existing artifact layout (payload /usr/local/bin/omp, identifier
# com.oh-my-pi.omp, two-line shasum -a 256 manifest). macOS aarch64 only.

if [ $# -ne 1 ]; then
    echo "usage: $0 <path-to-omp-binary>" >&2
    exit 2
fi

SRC=$1
if [ ! -x "$SRC" ]; then
    echo "error: $SRC is not an executable file" >&2
    exit 1
fi

# Run from the repository root; resolve the caller's directory to be safe.
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

SHA=$(git rev-parse --short HEAD)
TRIPLE=aarch64-apple-darwin
NAME="omp-${SHA}-${TRIPLE}"
DIST=dist
mkdir -p "$DIST"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/omp-pkg.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- tarball
ROOT="$WORK/$NAME"
mkdir -p "$ROOT/bin"
cp "$SRC" "$ROOT/bin/omp"
chmod 755 "$ROOT/bin/omp"
BRANCH=$(git branch --show-current)

cat > "$ROOT/install.sh" <<'INSTALL_SH'
#!/bin/sh
set -eu
PREFIX=${PREFIX:-/usr/local}
mkdir -p "$PREFIX/bin"
cp "$(dirname "$0")/bin/omp" "$PREFIX/bin/omp"
chmod 755 "$PREFIX/bin/omp"
echo "installed $PREFIX/bin/omp"
INSTALL_SH
chmod 755 "$ROOT/install.sh"

cat > "$ROOT/README.txt" <<README
omp macOS binary

Build: ${SHA}
Target: ${TRIPLE}
Branch: ${BRANCH}

Install from tarball:
  sudo cp bin/omp /usr/local/bin/omp

Or install the .pkg artifact, which places the binary at /usr/local/bin/omp.

This build is ad-hoc signed by the linker and is not Apple-notarized.
README

( cd "$ROOT" && chmod -R u+rwX . )
rm -f "$REPO_ROOT/$DIST/${NAME}.tar.gz"
# Absolute path: tar runs inside $WORK but writes into $DIST under the repo root.
TARBALL="$WORK/${NAME}.tar.gz"
( cd "$WORK" && tar -czf "${NAME}.tar.gz" "$NAME" )
cp "$WORK/${NAME}.tar.gz" "$REPO_ROOT/$DIST/${NAME}.tar.gz"

# ---------------------------------------------------------------- pkg
# Root filesystem tree: Payload/usr/local/bin/omp. pkgbuild assembles the
# xar bundle (PackageInfo auto-generated, no install scripts in the
# reference artifact, so none are required here).
PKGROOT="$WORK/pkgroot"
mkdir -p "$PKGROOT/usr/local/bin"
cp "$SRC" "$PKGROOT/usr/local/bin/omp"
chmod 755 "$PKGROOT/usr/local/bin/omp"
PKG="$REPO_ROOT/$DIST/${NAME}.pkg"
rm -f "$PKG"
# version must match CARGO_PKG_VERSION (workspace 0.1.0); keep it in sync.
pkgbuild --root "$PKGROOT" \
    --identifier com.oh-my-pi.omp \
    --version 0.1.0 \
    "$PKG"

# ---------------------------------------------------------------- checksums
# Two lines, shasum -a 256 format: "<hash>  <name>" (two spaces), tarball
# first, then the pkg — identical to the reference manifest.
SHA256="$REPO_ROOT/$DIST/${NAME}.sha256"
( cd "$REPO_ROOT/$DIST" && shasum -a 256 "${NAME}.tar.gz" "${NAME}.pkg" > "${NAME}.sha256" )

echo "wrote: $TARBALL"
echo "wrote: $PKG"
echo "wrote: $SHA256"
