#!/bin/sh
# pack.sh — assemble the omp deployment kit for the production team.
#
# Downloads (and checksum-verifies) a pinned omp release binary plus the
# release SHA256SUMS/THIRD-PARTY-NOTICES, then bundles everything the
# deployment team needs into one offline-installable tar.gz:
#
#   deployment/dist/omp-deploy-kit-<version>-linux-<arch>.tar.gz
#   deployment/dist/omp-deploy-kit-<version>-linux-<arch>.tar.gz.sha256
#
# Usage:
#   ./pack.sh [--version v18.1.11|latest] [--arch x64|arm64] [--out DIR]
#
# The produced bundle needs NO network access on the target server.

set -eu

REPO="can1357/oh-my-pi"
VERSION="latest"
ARCH="x64"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"

while [ $# -gt 0 ]; do
	case "$1" in
	--version)
		VERSION="${2:?missing value for --version}"
		shift 2
		;;
	--arch)
		ARCH="${2:?missing value for --arch}"
		shift 2
		;;
	--out)
		OUT_DIR="${2:?missing value for --out}"
		mkdir -p "$OUT_DIR"
		shift 2
		;;
	*)
		echo "unknown option: $1" >&2
		echo "usage: $0 [--version v18.1.11|latest] [--arch x64|arm64] [--out DIR]" >&2
		exit 2
		;;
	esac
done

case "$ARCH" in
x64 | arm64) ;;
*)
	echo "unsupported arch: $ARCH (use x64 or arm64)" >&2
	exit 2
	;;
esac

for tool in curl sha256sum tar; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "missing required tool: $tool" >&2
		exit 1
	}
done

echo "==> resolving release tag ($VERSION)"
if [ "$VERSION" = "latest" ]; then
	TAG="$(curl -fsSL --max-time 60 "https://api.github.com/repos/$REPO/releases/latest" |
		grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
	[ -n "$TAG" ] || {
		echo "failed to resolve latest release tag" >&2
		exit 1
	}
else
	TAG="$VERSION"
fi
echo "    tag: $TAG"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/omp-deploy-kit"
mkdir -p "$BUNDLE/bin"

BASE_URL="https://github.com/$REPO/releases/download/$TAG"
BINARY="omp-linux-$ARCH"

echo "==> downloading $BINARY, SHA256SUMS.txt, THIRD-PARTY-NOTICES.txt"
curl -fsSL --max-time 600 --speed-limit 1024 --speed-time 30 \
	"$BASE_URL/$BINARY" -o "$BUNDLE/bin/omp"
curl -fsSL --max-time 60 "$BASE_URL/SHA256SUMS.txt" -o "$STAGE/SHA256SUMS.txt"
curl -fsSL --max-time 120 "$BASE_URL/THIRD-PARTY-NOTICES.txt" \
	-o "$BUNDLE/THIRD-PARTY-NOTICES.txt" || {
	echo "warning: no THIRD-PARTY-NOTICES.txt in release; continuing without it" >&2
}

echo "==> verifying binary checksum against release SHA256SUMS.txt"
EXPECTED="$(awk -v f="$BINARY" '$2 == f { print $1 }' "$STAGE/SHA256SUMS.txt")"
[ -n "$EXPECTED" ] || {
	echo "SHA256SUMS.txt has no entry for $BINARY — refusing to pack unverified binary" >&2
	exit 1
}
ACTUAL="$(sha256sum "$BUNDLE/bin/omp" | awk '{print $1}')"
[ "$ACTUAL" = "$EXPECTED" ] || {
	echo "CHECKSUM MISMATCH for $BINARY" >&2
	echo "  expected: $EXPECTED" >&2
	echo "  actual:   $ACTUAL" >&2
	exit 1
}
echo "    ok: $ACTUAL"

echo "==> staging kit files"
cp "$STAGE/SHA256SUMS.txt" "$BUNDLE/SHA256SUMS-upstream.txt"
cp -R "$SCRIPT_DIR/kit/." "$BUNDLE/"
cp "$SCRIPT_DIR/README.md" "$BUNDLE/README.md"

cat >"$BUNDLE/MANIFEST.txt" <<EOF
kit: omp deployment kit
kit-format: 1
omp-version: $TAG
arch: linux-$ARCH
binary-sha256: $ACTUAL
binary-upstream-url: $BASE_URL/$BINARY
packed-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
packed-by: "$(id -un)@$(hostname)"
EOF

echo "==> generating bundle-wide SHA256SUMS.txt"
(cd "$BUNDLE" && find . -type f ! -name SHA256SUMS.txt -print0 |
	LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS.txt)

echo "==> packing tarball"
TARBALL="$OUT_DIR/omp-deploy-kit-$TAG-linux-$ARCH.tar.gz"
mkdir -p "$OUT_DIR"
tar -czf "$TARBALL" -C "$STAGE" omp-deploy-kit
sha256sum "$TARBALL" >"$TARBALL.sha256"

echo ""
echo "Bundle ready:"
echo "  $TARBALL"
echo "  $TARBALL.sha256"
echo ""
sed 's/^/  /' "$BUNDLE/MANIFEST.txt"
echo ""
echo "Ship both files to the deployment team; instructions are inside the kit (README.md)."
