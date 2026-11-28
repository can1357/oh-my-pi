#!/bin/sh
set -e

cd "$(dirname "$0")/../.."

echo "=== Testing binary build ==="
# Only compressed, checksum-pinned kits belong in the build context; the cache
# may also hold unpacked objects. A cold cache uses the configured HTTPS origin.
kit_context=$(mktemp -d)
trap 'rm -rf "$kit_context"' EXIT
case "$(podman info --format '{{.Host.Arch}}')" in
    amd64|x86_64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "The binary install test requires a Linux x64 or arm64 Podman host." >&2; exit 1 ;;
esac
for archive in target/linked-natives/kits/omp-bun-*-linux-"$arch".tar.zst; do
    [ -f "$archive" ] || continue
    ln "$archive" "$kit_context/" 2>/dev/null || cp "$archive" "$kit_context/"
done
podman build --build-context "bun-kits=$kit_context" \
    --build-arg "OMP_BUN_KIT_BASE_URL=${OMP_BUN_KIT_BASE_URL:-}" \
    -f scripts/install-tests/binary.dockerfile -t omp-test-binary .

echo ""
echo "=== Testing source install ==="
podman build -f scripts/install-tests/source.dockerfile -t omp-test-source .

echo ""
echo "=== Testing tarball install (publish simulation) ==="
podman build -f scripts/install-tests/tarball.dockerfile -t omp-test-tarball .

echo ""
echo "=== All tests passed ==="
