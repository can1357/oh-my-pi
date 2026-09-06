#!/bin/sh
# Contract tests for omp-sync.sh. Run from this directory or via:
#   sh contrib/omp-sync/omp-sync.test.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPT=$ROOT/omp-sync.sh
FAILED=0

assert_eq() {
	_name=$1
	_got=$2
	_want=$3
	if [ "$_got" = "$_want" ]; then
		printf 'ok  %s\n' "$_name"
	else
		printf 'not ok  %s: got %s want %s\n' "$_name" "$_got" "$_want"
		FAILED=$((FAILED + 1))
	fi
}

assert_file() {
	_name=$1
	_path=$2
	if [ -f "$_path" ]; then
		printf 'ok  %s\n' "$_name"
	else
		printf 'not ok  %s: missing %s\n' "$_name" "$_path"
		FAILED=$((FAILED + 1))
	fi
}

assert_not_file_changed() {
	_name=$1
	_path=$2
	_want=$3
	_got=$(cat "$_path")
	assert_eq "$_name" "$_got" "$_want"
}

write_fake_omp() {
	_dest=$1
	_version=$2
	_mode=${3:-ok}
	cat >"$_dest" <<EOF
#!/bin/sh
VERSION=$_version
MODE=$_mode
STATE=\$(dirname "\$0")/state
cmd=\${1:-}
if [ "\$cmd" = "--version" ]; then
	printf 'omp/%s\n' "\$VERSION"
	exit 0
fi
if [ "\$cmd" = "plugin" ] && [ "\${2:-}" = "link" ]; then
	printf '%s\n' "\$3" >>"\$STATE/relinked"
	exit 0
fi
if [ "\$cmd" != "update" ]; then
	printf 'unexpected: %s\n' "\$*" >&2
	exit 99
fi
if [ "\${2:-}" = "--check" ]; then
	if [ "\$MODE" = "net" ]; then
		printf 'Failed to check for updates: Unable to connect. getaddrinfo ENOTFOUND\n' >&2
		exit 1
	fi
	if [ "\$MODE" = "current" ]; then
		printf 'Already up to date\n'
		exit 0
	fi
	printf 'New version available: 2.0.0\n'
	exit 0
fi
if [ "\$MODE" = "fail" ]; then
	printf '#!/bin/sh\necho broken\nexit 1\n' >"\$0"
	chmod +x "\$0"
	printf 'Update failed: boom\n' >&2
	exit 1
fi
if [ "\$MODE" = "net-apply" ]; then
	printf 'Failed to check for updates: fetch failed\n' >&2
	exit 1
fi
# Successful self-replace: rewrite VERSION in this file.
tmp=\$0.tmp.\$\$
sed "s/^VERSION=.*/VERSION=2.0.0/" "\$0" >"\$tmp"
chmod +x "\$tmp"
mv -f "\$tmp" "\$0"
printf 'Updated to 2.0.0\n'
exit 0
EOF
	chmod +x "$_dest"
}

run_sync() {
	set +e
	HOME=$TEST_HOME \
		OMP_HOME=$TEST_HOME/.omp \
		OMP_SYNC_BIN=$FAKE_OMP \
		PATH="$(dirname "$FAKE_OMP"):$PATH" \
		"$SCRIPT" "$@" >"$TEST_ROOT/last-stdout" 2>"$TEST_ROOT/last-stderr"
	_rc=$?
	set -e
	printf '%s\n' "$_rc"
}

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/omp-sync-test.XXXXXX")
TEST_HOME=$TEST_ROOT/home
mkdir -p "$TEST_HOME/.omp/agent" "$TEST_HOME/bin" "$TEST_HOME/plugin"
printf 'keep-me: true\n' >"$TEST_HOME/.omp/config.yml"
printf 'sessions-ok\n' >"$TEST_HOME/.omp/agent/session-marker"
FAKE_OMP=$TEST_HOME/bin/omp
CONFIG_COPY='keep-me: true'

# --help
rc=$(
	set +e
	"$SCRIPT" --help >/dev/null
	printf '%s\n' $?
)
assert_eq "help exits 0" "$rc" "0"

# missing binary
rc=$(
	set +e
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$TEST_HOME/bin/missing \
		"$SCRIPT" --check >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "missing omp exits 6" "$rc" "6"
assert_not_file_changed "config intact after missing omp" "$TEST_HOME/.omp/config.yml" "$CONFIG_COPY"

# --check already up to date
write_fake_omp "$FAKE_OMP" "1.0.0" current
rc=$(run_sync --check)
assert_eq "check up to date exits 0" "$rc" "0"

# --check network
write_fake_omp "$FAKE_OMP" "1.0.0" net
rc=$(run_sync --check)
assert_eq "check network exits 2" "$rc" "2"
assert_not_file_changed "config intact after network check" "$TEST_HOME/.omp/config.yml" "$CONFIG_COPY"
assert_file "session marker intact after network check" "$TEST_HOME/.omp/agent/session-marker"

# --apply already up to date: no snapshot
write_fake_omp "$FAKE_OMP" "1.0.0" current
rc=$(run_sync --apply)
assert_eq "apply up to date exits 0" "$rc" "0"
snap_count=$(find "$TEST_HOME/.omp/sync/snapshots" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
assert_eq "apply up to date takes no snapshot" "$snap_count" "0"

# --apply success
write_fake_omp "$FAKE_OMP" "1.0.0" ok
rc=$(run_sync --apply)
assert_eq "apply success exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "apply success updates version" "$got" "omp/2.0.0"
snap_count=$(find "$TEST_HOME/.omp/sync/snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
assert_eq "apply success keeps one snapshot" "$snap_count" "1"

# --list is non-empty
list_out=$(
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$FAKE_OMP "$SCRIPT" --list 2>/dev/null
)
case "$list_out" in
	*1.0.0*) printf 'ok  list shows snapshot version\n' ;;
	*)
		printf 'not ok  list shows snapshot version: %s\n' "$list_out"
		FAILED=$((FAILED + 1))
		;;
esac

# --rollback restores 1.0.0
rc=$(run_sync --rollback)
assert_eq "rollback exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "rollback restores previous version" "$got" "omp/1.0.0"

# --apply failure restores previous binary
write_fake_omp "$FAKE_OMP" "1.0.0" fail
rc=$(run_sync --apply)
assert_eq "apply failure exits 3" "$rc" "3"
got=$("$FAKE_OMP" --version)
assert_eq "apply failure restores binary" "$got" "omp/1.0.0"
assert_not_file_changed "config intact after failed apply" "$TEST_HOME/.omp/config.yml" "$CONFIG_COPY"

# smoke failure restores
write_fake_omp "$FAKE_OMP" "1.0.0" ok
rc=$(
	set +e
	HOME=$TEST_HOME \
		OMP_HOME=$TEST_HOME/.omp \
		OMP_SYNC_BIN=$FAKE_OMP \
		OMP_SYNC_SMOKE_CMD='exit 42' \
		"$SCRIPT" --apply >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "smoke failure exits 3" "$rc" "3"
got=$("$FAKE_OMP" --version)
assert_eq "smoke failure restores binary" "$got" "omp/1.0.0"

# relink after success
write_fake_omp "$FAKE_OMP" "1.0.0" ok
mkdir -p "$TEST_HOME/plugin"
printf 'plugin\n' >"$TEST_HOME/plugin/package.json"
mkdir -p "$(dirname "$FAKE_OMP")/state"
rc=$(
	set +e
	HOME=$TEST_HOME \
		OMP_HOME=$TEST_HOME/.omp \
		OMP_SYNC_BIN=$FAKE_OMP \
		OMP_SYNC_RELINK_EXT="$TEST_HOME/plugin" \
		"$SCRIPT" --apply >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "apply with relink exits 0" "$rc" "0"
relinked=$(cat "$(dirname "$FAKE_OMP")/state/relinked")
assert_eq "relink called plugin path" "$relinked" "$TEST_HOME/plugin"

# prune keeps last N
write_fake_omp "$FAKE_OMP" "1.0.0" ok
i=0
while [ "$i" -lt 4 ]; do
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$FAKE_OMP \
		OMP_SYNC_KEEP=2 "$SCRIPT" --apply >/dev/null 2>&1 || true
	write_fake_omp "$FAKE_OMP" "1.0.0" ok
	i=$((i + 1))
done
snap_count=$(find "$TEST_HOME/.omp/sync/snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
assert_eq "prune keeps 2 snapshots" "$snap_count" "2"
assert_file "config still present after prune" "$TEST_HOME/.omp/config.yml"
assert_file "agent marker still present after prune" "$TEST_HOME/.omp/agent/session-marker"

# network during apply check does not snapshot-replace
write_fake_omp "$FAKE_OMP" "1.0.0" net
before=$("$FAKE_OMP" --version)
rc=$(run_sync --apply)
assert_eq "apply network check exits 2" "$rc" "2"
got=$("$FAKE_OMP" --version)
assert_eq "apply network leaves binary" "$got" "$before"

rm -rf "$TEST_ROOT"

if [ "$FAILED" -ne 0 ]; then
	printf '\n%d test(s) failed\n' "$FAILED"
	exit 1
fi
printf '\nall tests passed\n'
exit 0
