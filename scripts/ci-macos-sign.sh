#!/usr/bin/env bash
#
# Sign and notarize a compiled macOS `omp` binary with a Developer ID identity.
#
# The release build (`ci:release:build-binaries`) ad-hoc signs the binary so it
# runs locally. This script *replaces* that signature with a real Developer ID
# Application signature plus the hardened runtime, a secure timestamp, and the
# JIT / library-validation entitlements the Bun + JavaScriptCore runtime and the
# runtime-extracted native addon require (see scripts/macos-entitlements.plist),
# then notarizes the result with App Store Connect API credentials.
#
# A bare Mach-O executable cannot be stapled (stapler only supports .app/.pkg/
# .dmg), so the notarization ticket is served online: Gatekeeper fetches it by
# cdhash on first assessment. `curl` downloads and Homebrew *formula* installs do
# not set the quarantine bit, so they never invoke Gatekeeper; for an offline,
# quarantined cask we would need a stapleable .pkg/.dmg wrapper (follow-up).
#
# Required environment (wired from GitHub Actions secrets):
#   APPLE_CERTIFICATE_P12        base64 of the Developer ID Application .p12 bundle
#   APPLE_CERTIFICATE_PASSWORD   password protecting that .p12
#   APPLE_API_KEY_ID             App Store Connect API key id (the "Key ID")
#   APPLE_API_ISSUER_ID          App Store Connect API issuer id (UUID)
#   APPLE_API_KEY                base64 of the App Store Connect .p8 private key
#
# Usage: scripts/ci-macos-sign.sh <path-to-binary>

set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
	echo "ci-macos-sign: must run on macOS" >&2
	exit 1
fi

BINARY="${1:-}"
if [[ -z "$BINARY" ]]; then
	echo "usage: ci-macos-sign.sh <path-to-binary>" >&2
	exit 1
fi
if [[ ! -f "$BINARY" ]]; then
	echo "ci-macos-sign: binary not found: $BINARY" >&2
	exit 1
fi

missing=()
for var in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY; do
	[[ -n "${!var:-}" ]] || missing+=("$var")
done
if ((${#missing[@]})); then
	echo "ci-macos-sign: missing required env: ${missing[*]}" >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/macos-entitlements.plist"
if [[ ! -f "$ENTITLEMENTS" ]]; then
	echo "ci-macos-sign: entitlements not found: $ENTITLEMENTS" >&2
	exit 1
fi

WORKDIR="$(mktemp -d)"
KEYCHAIN="$WORKDIR/omp-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
CERT_PATH="$WORKDIR/cert.p12"
API_KEY_PATH="$WORKDIR/api-key.p8"
ZIP_PATH="$WORKDIR/$(basename "$BINARY").zip"

cleanup() {
	security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "ci-macos-sign: decoding credentials"
printf '%s' "$APPLE_CERTIFICATE_P12" | base64 --decode >"$CERT_PATH"
printf '%s' "$APPLE_API_KEY" | base64 --decode >"$API_KEY_PATH"

echo "ci-macos-sign: provisioning a temporary signing keychain"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# Auto-relock after 6h as a safety net; the EXIT trap deletes it well before.
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# Prepend our keychain to the user search list so codesign can resolve the
# identity, keeping the runner's existing keychains intact.
existing_keychains="$(security list-keychains -d user | sed -e 's/"//g' -e 's/^[[:space:]]*//')"
# shellcheck disable=SC2086 # intentional word-splitting of the keychain list
security list-keychains -d user -s "$KEYCHAIN" $existing_keychains

security import "$CERT_PATH" -P "$APPLE_CERTIFICATE_PASSWORD" -k "$KEYCHAIN" \
	-T /usr/bin/codesign -T /usr/bin/security
# Grant codesign non-interactive access to the imported private key.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" \
	| awk -F'"' '/Developer ID Application/ {print $2; exit}')"
if [[ -z "$IDENTITY" ]]; then
	echo "ci-macos-sign: no 'Developer ID Application' identity in the imported keychain" >&2
	security find-identity -v -p codesigning "$KEYCHAIN" >&2 || true
	exit 1
fi
echo "ci-macos-sign: signing as: $IDENTITY"

codesign --force --timestamp --options runtime \
	--entitlements "$ENTITLEMENTS" \
	--sign "$IDENTITY" \
	"$BINARY"

echo "ci-macos-sign: verifying signature"
codesign --verify --strict --verbose=4 "$BINARY"
codesign -dvvv "$BINARY" 2>&1 | grep -E "Authority|TeamIdentifier|flags=|Timestamp" || true

# Fail fast before the slower notarization round-trip: a hardened-runtime binary
# missing an entitlement still signs cleanly but aborts at launch (e.g. the
# native-addon Team ID check). Exercise the runtime in an isolated HOME.
echo "ci-macos-sign: launch check under the hardened-runtime signature"
run_home="$WORKDIR/home"
HOME="$run_home" XDG_DATA_HOME="$run_home/xdg" "$BINARY" --version
HOME="$run_home" XDG_DATA_HOME="$run_home/xdg" "$BINARY" --smoke-test

echo "ci-macos-sign: submitting for notarization"
/usr/bin/ditto -c -k --keepParent "$BINARY" "$ZIP_PATH"
submit_json="$(xcrun notarytool submit "$ZIP_PATH" \
	--key "$API_KEY_PATH" \
	--key-id "$APPLE_API_KEY_ID" \
	--issuer "$APPLE_API_ISSUER_ID" \
	--wait \
	--timeout 30m \
	--output-format json)"
echo "$submit_json"

read -r status submission_id <<<"$(printf '%s' "$submit_json" \
	| python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""), d.get("id",""))')"

if [[ "$status" != "Accepted" ]]; then
	echo "ci-macos-sign: notarization status=$status (expected Accepted)" >&2
	if [[ -n "$submission_id" ]]; then
		xcrun notarytool log "$submission_id" \
			--key "$API_KEY_PATH" \
			--key-id "$APPLE_API_KEY_ID" \
			--issuer "$APPLE_API_ISSUER_ID" >&2 || true
	fi
	exit 1
fi

echo "ci-macos-sign: notarized ($(basename "$BINARY"), submission $submission_id)"
echo "ci-macos-sign: note — a bare Mach-O cannot be stapled; the ticket is verified online."
