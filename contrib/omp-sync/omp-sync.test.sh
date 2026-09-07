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
	_launcher=${4:-}
	cat >"$_dest" <<EOF
#!/bin/sh
VERSION=$_version
MODE=$_mode
LAUNCHER=$_launcher
STATE=\$(dirname "\$0")/state
cmd=\${1:-}
is_check=0
has_channel_or_force=0
for _a in "\$@"; do
	case "\$_a" in
		--check | -c) is_check=1 ;;
		--canary | --stable | --force | -f) has_channel_or_force=1 ;;
	esac
done
if [ "\$cmd" = "--version" ]; then
	printf 'omp/%s\n' "\$VERSION"
	exit 0
fi
if [ "\$cmd" = "plugin" ] && [ "\${2:-}" = "link" ]; then
	mkdir -p "\$STATE"
	printf '%s\n' "\$3" >>"\$STATE/relinked"
	exit 0
fi
if [ "\$cmd" != "update" ]; then
	printf 'unexpected: %s\n' "\$*" >&2
	exit 99
fi
if [ "\$is_check" -eq 1 ]; then
	mkdir -p "\$STATE"
	: >"\$STATE/check-args"
	for _a in "\$@"; do
		printf '%s\n' "\$_a" >>"\$STATE/check-args"
	done
	if [ "\$MODE" = "net" ]; then
		printf 'Failed to check for updates: Unable to connect. getaddrinfo ENOTFOUND\n' >&2
		exit 1
	fi
	if [ "\$MODE" = "current" ] && [ "\$has_channel_or_force" -eq 0 ]; then
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
if [ "\$MODE" = "hang" ]; then
	mkdir -p "\$STATE"
	printf '%s\n' "\$\$" >"\$STATE/hang-pid"
	printf 'hanging\n' >"\$STATE/hanging"
	sleep 60
	exit 0
fi
if [ "\$MODE" = "retarget" ]; then
	_target=\$LAUNCHER
	if [ -z "\$_target" ]; then
		_target=\$0
	fi
	_new=\$(dirname "\$_target")/omp-new
	printf '#!/bin/sh\nprintf "omp/2.0.0\\n"\n' >"\$_new"
	chmod +x "\$_new"
	ln -sfn "\$_new" "\$_target"
	printf 'Updated to 2.0.0\n'
	exit 0
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

# network during apply (after a successful check) restores and exits 2
write_fake_omp "$FAKE_OMP" "1.0.0" net-apply
before=$("$FAKE_OMP" --version)
rc=$(run_sync --apply)
assert_eq "apply network after check exits 2" "$rc" "2"
got=$("$FAKE_OMP" --version)
assert_eq "apply network after check restores binary" "$got" "$before"

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
rm -f "$(dirname "$FAKE_OMP")/state/relinked"
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

# literal ~/ prefix in OMP_SYNC_RELINK_EXT expands via $HOME, not case-tilde
write_fake_omp "$FAKE_OMP" "1.0.0" ok
rm -f "$(dirname "$FAKE_OMP")/state/relinked"
rc=$(
	set +e
	HOME=$TEST_HOME \
		OMP_HOME=$TEST_HOME/.omp \
		OMP_SYNC_BIN=$FAKE_OMP \
		OMP_SYNC_RELINK_EXT='~/plugin' \
		"$SCRIPT" --apply >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "apply with ~/ relink exits 0" "$rc" "0"
relinked=$(cat "$(dirname "$FAKE_OMP")/state/relinked" 2>/dev/null || true)
assert_eq "relink expands literal tilde prefix" "$relinked" "$TEST_HOME/plugin"

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

# --apply -- --canary on a current install must still apply (preflight gets --canary)
write_fake_omp "$FAKE_OMP" "1.0.0" current
mkdir -p "$(dirname "$FAKE_OMP")/state"
rm -f "$(dirname "$FAKE_OMP")/state/check-args"
rc=$(run_sync --apply -- --canary)
assert_eq "apply --canary on current exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "apply --canary on current updates version" "$got" "omp/2.0.0"
if grep -qx -- --canary "$(dirname "$FAKE_OMP")/state/check-args" &&
	grep -qx -- --check "$(dirname "$FAKE_OMP")/state/check-args"; then
	printf 'ok  preflight check received --canary\n'
else
	printf 'not ok  preflight check received --canary: %s\n' "$(cat "$(dirname "$FAKE_OMP")/state/check-args")"
	FAILED=$((FAILED + 1))
fi

# --apply -- --force with a spaced extra arg keeps argument boundaries
write_fake_omp "$FAKE_OMP" "1.0.0" current
rm -f "$(dirname "$FAKE_OMP")/state/check-args"
rc=$(run_sync --apply -- --force --note "hello world")
assert_eq "apply --force with spaced arg exits 0" "$rc" "0"
if grep -qx -- --force "$(dirname "$FAKE_OMP")/state/check-args" &&
	grep -qx -- "hello world" "$(dirname "$FAKE_OMP")/state/check-args"; then
	printf 'ok  preflight preserves spaced argument\n'
else
	printf 'not ok  preflight preserves spaced argument: %s\n' "$(cat "$(dirname "$FAKE_OMP")/state/check-args")"
	FAILED=$((FAILED + 1))
fi

# incomplete snapshot without meta is skipped; rollback uses a complete one
write_fake_omp "$FAKE_OMP" "1.0.0" ok
rc=$(run_sync --apply)
assert_eq "apply before incomplete-snapshot test exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "version is 2.0.0 before incomplete rollback" "$got" "omp/2.0.0"
incomplete_id='20990101T000000Z-incomplete-1'
incomplete_dir=$TEST_HOME/.omp/sync/snapshots/$incomplete_id
mkdir -p "$incomplete_dir"
printf 'partial-not-a-binary\n' >"$incomplete_dir/omp"
rc=$(run_sync --rollback)
assert_eq "rollback skips incomplete snapshot without meta" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "rollback from complete snapshot restores 1.0.0" "$got" "omp/1.0.0"
rc=$(
	set +e
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --rollback "$incomplete_id" >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "explicit incomplete snapshot exits 4" "$rc" "4"

# checksum mismatch is rejected before replacing the live binary
write_fake_omp "$FAKE_OMP" "1.0.0" ok
rc=$(run_sync --apply)
assert_eq "apply before checksum test exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "checksum test starts at 2.0.0" "$got" "omp/2.0.0"
good_id=$(
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --list 2>/dev/null | awk 'NF{id=$1} END{print id}'
)
printf 'tampered\n' >"$TEST_HOME/.omp/sync/snapshots/$good_id/omp"
rc=$(
	set +e
	HOME=$TEST_HOME OMP_HOME=$TEST_HOME/.omp OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --rollback "$good_id" >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "checksum mismatch exits 4" "$rc" "4"
got=$("$FAKE_OMP" --version)
assert_eq "checksum mismatch leaves live binary" "$got" "omp/2.0.0"

# retargeted PATH symlink is restored at the live target, not the stale source
RETARGET_ROOT=$TEST_HOME/retarget
mkdir -p "$RETARGET_ROOT/v1" "$TEST_HOME/bin"
write_fake_omp "$RETARGET_ROOT/v1/omp" "1.0.0" retarget "$TEST_HOME/bin/omp"
ln -sfn "$RETARGET_ROOT/v1/omp" "$TEST_HOME/bin/omp"
FAKE_OMP=$TEST_HOME/bin/omp
rc=$(run_sync --apply)
assert_eq "retarget apply exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "retarget apply updates via new symlink target" "$got" "omp/2.0.0"
rc=$(run_sync --rollback)
assert_eq "retarget rollback exits 0" "$rc" "0"
got=$("$FAKE_OMP" --version)
assert_eq "retarget rollback restores PATH-resolved binary" "$got" "omp/1.0.0"
FAKE_OMP=$TEST_HOME/bin/omp

# lock path with a quote in OMP_SYNC_DIR does not break eval
QUOTE_SYNC=$TEST_ROOT/dir-with-\'-quote
mkdir -p "$QUOTE_SYNC"
write_fake_omp "$FAKE_OMP" "1.0.0" current
rc=$(
	set +e
	HOME=$TEST_HOME \
		OMP_SYNC_DIR="$QUOTE_SYNC" \
		OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --list >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "list with quote in sync dir exits 0" "$rc" "0"

# HOME unset is allowed when an absolute sync root is provided
rc=$(
	set +e
	env -u HOME \
		OMP_SYNC_DIR="$TEST_HOME/.omp/sync" \
		OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --list >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "list without HOME with abs OMP_SYNC_DIR exits 0" "$rc" "0"

rc=$(
	set +e
	env -u HOME \
		OMP_HOME="$TEST_HOME/.omp" \
		OMP_SYNC_BIN=$FAKE_OMP \
		"$SCRIPT" --list >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "list without HOME with OMP_HOME exits 0" "$rc" "0"

rc=$(
	set +e
	env -u HOME \
		"$SCRIPT" --list >/dev/null 2>&1
	printf '%s\n' $?
)
assert_eq "list without HOME or abs root exits 1" "$rc" "1"

# SIGTERM during apply must exit instead of finishing the update
write_fake_omp "$FAKE_OMP" "1.0.0" hang
rm -f "$(dirname "$FAKE_OMP")/state/hanging" "$(dirname "$FAKE_OMP")/state/hang-pid"
HOME=$TEST_HOME \
	OMP_HOME=$TEST_HOME/.omp \
	OMP_SYNC_BIN=$FAKE_OMP \
	"$SCRIPT" --apply >/dev/null 2>&1 &
hang_pid=$!
i=0
while [ "$i" -lt 50 ]; do
	if [ -f "$(dirname "$FAKE_OMP")/state/hanging" ]; then
		break
	fi
	sleep 0.1
	i=$((i + 1))
done
if [ ! -f "$(dirname "$FAKE_OMP")/state/hanging" ]; then
	printf 'not ok  hang apply started: marker missing\n'
	FAILED=$((FAILED + 1))
	kill -KILL "$hang_pid" 2>/dev/null || true
else
	kill -TERM "$hang_pid" 2>/dev/null || true
	j=0
	while [ "$j" -lt 50 ]; do
		if ! kill -0 "$hang_pid" 2>/dev/null; then
			break
		fi
		sleep 0.1
		j=$((j + 1))
	done
	set +e
	wait "$hang_pid"
	hang_rc=$?
	set -e
	child=$(cat "$(dirname "$FAKE_OMP")/state/hang-pid" 2>/dev/null || true)
	if [ -n "$child" ]; then
		kill -KILL "$child" 2>/dev/null || true
	fi
	still=0
	if kill -0 "$hang_pid" 2>/dev/null; then
		still=1
		kill -KILL "$hang_pid" 2>/dev/null || true
	fi
	assert_eq "SIGTERM apply does not stay running" "$still" "0"
	if [ "$j" -ge 50 ]; then
		printf 'not ok  SIGTERM apply returns promptly: still waited 5s\n'
		FAILED=$((FAILED + 1))
	else
		printf 'ok  SIGTERM apply returns promptly\n'
	fi
	if [ "$hang_rc" -eq 0 ]; then
		printf 'not ok  SIGTERM apply exits non-zero: got 0\n'
		FAILED=$((FAILED + 1))
	else
		printf 'ok  SIGTERM apply exits non-zero\n'
	fi
	got=$("$FAKE_OMP" --version)
	assert_eq "SIGTERM apply does not finish update" "$got" "omp/1.0.0"
fi

rm -rf "$TEST_ROOT"

if [ "$FAILED" -ne 0 ]; then
	printf '\n%d test(s) failed\n' "$FAILED"
	exit 1
fi
printf '\nall tests passed\n'
exit 0
