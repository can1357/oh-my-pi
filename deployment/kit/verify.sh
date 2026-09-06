#!/bin/sh
# verify.sh — post-install health check for the omp deployment kit.
#
# Usage:
#   ./verify.sh                  # check binary + smoke test + completions
#   ./verify.sh --with-broker    # also check the auth-broker service
#   ./verify.sh --destroot DIR   # check a staged install instead of the live one
#
# Exits 0 when everything passes; prints PASS/FAIL per check.

set -u

PREFIX="/usr/local"
DESTROOT=""
WITH_BROKER=0
FAILURES=0

while [ $# -gt 0 ]; do
	case "$1" in
	--prefix)
		PREFIX="${2:?missing value for --prefix}"
		shift 2
		;;
	--destroot)
		DESTROOT="${2:?missing value for --destroot}"
		shift 2
		;;
	--with-broker)
		WITH_BROKER=1
		shift
		;;
	*)
		echo "unknown option: $1" >&2
		exit 2
		;;
	esac
done

pass() { echo "PASS: $*"; }
fail() {
	echo "FAIL: $*"
	FAILURES=$((FAILURES + 1))
}

OMP_BIN="$DESTROOT$PREFIX/bin/omp"

if [ -x "$OMP_BIN" ]; then
	pass "binary present and executable: $OMP_BIN"
else
	fail "binary missing or not executable: $OMP_BIN"
fi

if VERSION="$("$OMP_BIN" --version 2>&1)" && [ -n "$VERSION" ]; then
	pass "binary runs: $VERSION"
else
	fail "binary failed to execute (missing libstdc++ on musl? see README troubleshooting)"
fi

# Official CI-grade probe: spawns bundled workers, exercises the stats assets.
if "$OMP_BIN" --smoke-test >/dev/null 2>&1; then
	pass "smoke test (workers, stats assets)"
else
	fail "smoke test failed — run '$OMP_BIN --smoke-test' directly for details"
fi

if [ -f "$DESTROOT/etc/profile.d/omp-completions.sh" ]; then
	pass "bash completions installed"
else
	fail "bash completions missing: $DESTROOT/etc/profile.d/omp-completions.sh"
fi

if [ "$WITH_BROKER" -eq 1 ]; then
	if command -v systemctl >/dev/null 2>&1 &&
		systemctl is-active --quiet omp-auth-broker.service; then
		pass "omp-auth-broker service is active"
		TOKEN_FILE="$(getent passwd omp-broker | cut -d: -f6)/.omp/auth-broker.token"
		if [ -r "$TOKEN_FILE" ] &&
			curl -fsS --max-time 5 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
				http://127.0.0.1:8765/v1/snapshot >/dev/null 2>&1; then
			pass "auth-broker API answers with valid bearer token"
		elif [ ! -r "$TOKEN_FILE" ]; then
			fail "cannot read broker token: $TOKEN_FILE (run as root?)"
		else
			fail "auth-broker API check failed on http://127.0.0.1:8765"
		fi
	else
		fail "omp-auth-broker service is not active (systemctl status omp-auth-broker)"
	fi
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
	echo "ALL CHECKS PASSED"
	exit 0
else
	echo "$FAILURES CHECK(S) FAILED"
	exit 1
fi
