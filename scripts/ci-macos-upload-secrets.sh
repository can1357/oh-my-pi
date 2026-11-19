#!/usr/bin/env bash
#
# Upload the macOS signing/notarization secrets to GitHub Actions WITHOUT ever
# printing a secret value. Every value is read from a file on disk and piped to
# `gh secret set` over stdin, so nothing lands in argv, the shell history, or a
# terminal transcript.
#
# Prepare a directory (default ~/omp-signing) containing:
#   *.p12                 Developer ID Application identity exported from Keychain
#                         Access (right-click identity -> Export -> .p12).
#   p12-password.txt      the password you set on that .p12 export.
#   AuthKey_<KEYID>.p8    App Store Connect API key (download-once from the web).
#   issuer-id.txt         App Store Connect API issuer id (UUID).
#   key-id.txt            optional; otherwise the <KEYID> is read from the .p8
#                         filename.
#
# Usage:
#   scripts/ci-macos-upload-secrets.sh [dir] [--dry-run]
#   OMP_REPO=owner/repo scripts/ci-macos-upload-secrets.sh ~/omp-signing

set -euo pipefail

DIR=""
DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY_RUN=1 ;;
	*) DIR="$arg" ;;
	esac
done
DIR="${DIR:-${OMP_SIGNING_DIR:-$HOME/omp-signing}}"
REPO="${OMP_REPO:-can1357/oh-my-pi}"

die() {
	echo "ci-macos-upload-secrets: $1" >&2
	exit 1
}

[[ -d "$DIR" ]] || die "directory not found: $DIR"

find_one() {
	# Echo the single file in $DIR matching the glob, or fail.
	local pattern="$1" matches=()
	while IFS= read -r f; do matches+=("$f"); done < <(find "$DIR" -maxdepth 1 -type f -name "$pattern" | sort)
	((${#matches[@]} == 1)) || die "expected exactly one '$pattern' in $DIR, found ${#matches[@]}"
	printf '%s' "${matches[0]}"
}

read_file_value() {
	# Trim a single trailing newline; reject empty.
	local path="$1" name="$2" value
	[[ -f "$path" ]] || die "missing $name file: $path"
	value="$(cat "$path")"
	[[ -n "$value" ]] || die "$name file is empty: $path"
	printf '%s' "$value"
}

P12="$(find_one '*.p12')"
P8="$(find_one '*.p8')"
PW="$(read_file_value "$DIR/p12-password.txt" "p12-password.txt")"
ISSUER="$(read_file_value "$DIR/issuer-id.txt" "issuer-id.txt")"

if [[ -f "$DIR/key-id.txt" ]]; then
	KEYID="$(read_file_value "$DIR/key-id.txt" "key-id.txt")"
else
	# AuthKey_ABCDE12345.p8 -> ABCDE12345
	KEYID="$(basename "$P8" .p8)"
	KEYID="${KEYID#AuthKey_}"
	[[ -n "$KEYID" && "$KEYID" != "$(basename "$P8" .p8)" ]] \
		|| die "could not derive key id from '$(basename "$P8")'; add key-id.txt"
fi

# Validate the .p12 + password the same way CI consumes it — `security import`
# into a throwaway keychain — and confirm a Developer ID identity is inside, so a
# typo or wrong cert fails here instead of in CI. (We avoid `openssl pkcs12`:
# OpenSSL 3.x can't read the legacy RC2-40-CBC algorithm Keychain Access still
# uses, which `security import` handles fine.)
validate_p12=$(
	kc="$(mktemp -d)/validate.keychain-db"
	kp="$(openssl rand -hex 16)"
	security create-keychain -p "$kp" "$kc" >/dev/null 2>&1
	security unlock-keychain -p "$kp" "$kc" >/dev/null 2>&1
	if security import "$P12" -P "$PW" -k "$kc" -T /usr/bin/codesign >/dev/null 2>&1 \
		&& security find-identity -v -p codesigning "$kc" 2>/dev/null | grep -q "Developer ID Application"; then
		echo ok
	fi
	security delete-keychain "$kc" >/dev/null 2>&1 || true
)
[[ "$validate_p12" == ok ]] \
	|| die "the .p12 did not import with the password in p12-password.txt, or holds no Developer ID Application identity"
grep -q "BEGIN PRIVATE KEY" "$P8" \
	|| die "the .p8 does not look like a PEM private key"

echo "ci-macos-upload-secrets: repo=$REPO"
echo "  cert : $(basename "$P12")"
echo "  key  : $(basename "$P8") (key id $KEYID)"
echo "  -> APPLE_CERTIFICATE_P12, APPLE_CERTIFICATE_PASSWORD, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_KEY"

if ((DRY_RUN)); then
	echo "ci-macos-upload-secrets: --dry-run, not uploading"
	exit 0
fi

set_secret_stdin() {
	# $1 = secret name; value piped on stdin. Never echoes the value.
	gh secret set "$1" --repo "$REPO"
}

base64 <"$P12" | tr -d '\n' | set_secret_stdin APPLE_CERTIFICATE_P12
printf '%s' "$PW" | set_secret_stdin APPLE_CERTIFICATE_PASSWORD
printf '%s' "$KEYID" | set_secret_stdin APPLE_API_KEY_ID
printf '%s' "$ISSUER" | set_secret_stdin APPLE_API_ISSUER_ID
base64 <"$P8" | tr -d '\n' | set_secret_stdin APPLE_API_KEY

echo "ci-macos-upload-secrets: done. Verify with: gh secret list --repo $REPO"
