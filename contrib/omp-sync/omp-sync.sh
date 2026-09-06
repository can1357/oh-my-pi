#!/bin/sh
# Portable fail-soft wrapper around official `omp update` / `omp update --check`.
#
# Snapshots the current omp launcher before applying an update, keeps the last N
# snapshots, and restores that launcher if the update or an optional smoke
# command fails. User config (settings, sessions, auth, plugins) is never
# deleted or rewritten by this script.
#
# This is an optional contrib. It does not change core `omp update` behavior.
set -eu

EX_OK=0
EX_USAGE=1
EX_NETWORK=2
EX_APPLY=3
EX_ROLLBACK=4
EX_LOCK=5
EX_MISSING=6
EX_IO=7

KEEP_DEFAULT=5
LOCK_FD=9
ACTION=""
ROLLBACK_ID=""
PASS_THROUGH=""
LOCK_KIND=""
LOCK_DIR=""
LOCK_FILE=""

usage() {
	cat <<'EOF'
Usage: omp-sync.sh --check | --apply | --rollback [id] | --list | --help

Fail-soft snapshot/rollback wrapper around official `omp update`.

Actions:
  --check              Run `omp update --check` (no install, no snapshot)
  --apply              Snapshot the current omp binary, then `omp update`
  --rollback [id]      Restore the latest snapshot, or the named snapshot id
  --list               List snapshots (newest last)
  --help               Show this help

Extra arguments after `--` are forwarded to `omp update` on --apply:
  omp-sync.sh --apply -- --canary

Environment:
  HOME                 Used to resolve ~/.omp (never hard-coded user paths)
  OMP_HOME             If set, snapshots live under $OMP_HOME/sync
  PI_CONFIG_DIR        Official config-dir name or absolute path (default .omp)
  OMP_SYNC_DIR         Snapshot root override (takes precedence)
  OMP_SYNC_BIN         omp executable to wrap (default: omp on PATH)
  OMP_SYNC_KEEP        Snapshots to retain after a successful apply (default 5)
  OMP_SYNC_RELINK_EXT  Optional colon-separated local plugin paths to
                       `omp plugin link` after a successful apply
  OMP_SYNC_SMOKE_CMD   Optional shell command run after apply; failure rolls back

Exit codes:
  0  success / already up to date
  1  usage error
  2  network / registry failure (no binary change)
  3  apply failed; previous binary restored when a snapshot existed
  4  rollback failed
  5  another omp-sync holds the lock
  6  omp executable not found
  7  snapshot I/O error
EOF
}

log() {
	printf '%s\n' "$*" >&2
}

die() {
	_rc=$1
	shift
	log "omp-sync: $*"
	exit "$_rc"
}

is_abs() {
	case "$1" in
		/*) return 0 ;;
		*) return 1 ;;
	esac
}

config_root() {
	if [ -n "${OMP_HOME:-}" ]; then
		printf '%s\n' "$OMP_HOME"
		return 0
	fi
	_cfg=${PI_CONFIG_DIR:-.omp}
	if is_abs "$_cfg"; then
		printf '%s\n' "$_cfg"
	else
		printf '%s\n' "${HOME:?HOME is not set}/$_cfg"
	fi
}

sync_root() {
	if [ -n "${OMP_SYNC_DIR:-}" ]; then
		printf '%s\n' "$OMP_SYNC_DIR"
		return 0
	fi
	printf '%s/sync\n' "$(config_root)"
}

snapshots_dir() {
	printf '%s/snapshots\n' "$(sync_root)"
}

ensure_sync_dirs() {
	_root=$(sync_root)
	_snaps=$(snapshots_dir)
	mkdir -p "$_snaps" || die "$EX_IO" "could not create snapshot directory $_snaps"
	# Refuse to operate if sync root is not a directory we own as a folder.
	if [ ! -d "$_root" ]; then
		die "$EX_IO" "sync root is not a directory: $_root"
	fi
}

release_lock() {
	case "$LOCK_KIND" in
		mkdir)
			if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ]; then
				rm -f "$LOCK_DIR/pid" 2>/dev/null || true
				rmdir "$LOCK_DIR" 2>/dev/null || true
			fi
			;;
		flock)
			# Unlocked when this process exits (lock fd closed).
			;;
	esac
	LOCK_KIND=""
}

acquire_lock() {
	_root=$(sync_root)
	mkdir -p "$_root" || die "$EX_IO" "could not create sync root $_root"
	LOCK_FILE=$_root/omp-sync.lock
	LOCK_DIR=$_root/omp-sync.lock.d

	if command -v flock >/dev/null 2>&1; then
		# shellcheck disable=SC2094
		eval "exec ${LOCK_FD}>\"$LOCK_FILE\""
		if flock -n "$LOCK_FD"; then
			LOCK_KIND=flock
			return 0
		fi
		die "$EX_LOCK" "another omp-sync process holds $LOCK_FILE"
	fi

	if mkdir "$LOCK_DIR" 2>/dev/null; then
		printf '%s\n' "$$" >"$LOCK_DIR/pid"
		LOCK_KIND=mkdir
		return 0
	fi

	if [ -f "$LOCK_DIR/pid" ]; then
		_old=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
		if [ -n "$_old" ] && kill -0 "$_old" 2>/dev/null; then
			die "$EX_LOCK" "another omp-sync process (pid $_old) holds $LOCK_DIR"
		fi
	fi
	# Stale lock: take it over.
	rm -rf "$LOCK_DIR" 2>/dev/null || true
	if mkdir "$LOCK_DIR" 2>/dev/null; then
		printf '%s\n' "$$" >"$LOCK_DIR/pid"
		LOCK_KIND=mkdir
		return 0
	fi
	die "$EX_LOCK" "another omp-sync process holds $LOCK_DIR"
}

resolve_omp() {
	if [ -n "${OMP_SYNC_BIN:-}" ]; then
		_omp=$OMP_SYNC_BIN
	else
		_omp=$(command -v omp 2>/dev/null || true)
	fi
	if [ -z "$_omp" ]; then
		die "$EX_MISSING" "omp not found on PATH (set OMP_SYNC_BIN to override)"
	fi
	if [ ! -e "$_omp" ]; then
		die "$EX_MISSING" "omp path does not exist: $_omp"
	fi
	_base=$(basename "$_omp")
	if [ "$_base" = "omp-sync.sh" ]; then
		die "$EX_MISSING" "refusing to treat omp-sync.sh as the omp binary"
	fi
	printf '%s\n' "$_omp"
}

resolve_file() {
	_path=$1
	_i=0
	while [ -L "$_path" ] && [ "$_i" -lt 40 ]; do
		_target=$(readlink "$_path")
		case "$_target" in
			/*) _path=$_target ;;
			*) _path=$(dirname "$_path")/$_target ;;
		esac
		_i=$((_i + 1))
	done
	if [ ! -e "$_path" ]; then
		die "$EX_MISSING" "could not resolve omp file: $1"
	fi
	_dir=$(CDPATH='' cd -- "$(dirname "$_path")" && pwd -P)
	printf '%s/%s\n' "$_dir" "$(basename "$_path")"
}

file_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		printf '\n'
	fi
}

omp_version() {
	_bin=$1
	_out=$("$_bin" --version 2>/dev/null || true)
	_ver=$(printf '%s\n' "$_out" | sed -n 's/.*\/\([0-9][0-9A-Za-z._-]*\).*/\1/p' | head -n 1)
	if [ -z "$_ver" ]; then
		printf 'unknown\n'
	else
		printf '%s\n' "$_ver"
	fi
}

sanitize_id_part() {
	printf '%s\n' "$1" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-'
}

is_snapshot_id() {
	printf '%s\n' "$1" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$'
}

write_meta() {
	_meta=$1
	_version=$2
	_source=$3
	_sha=$4
	{
		printf 'version=%s\n' "$_version"
		printf 'source=%s\n' "$_source"
		printf 'created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'sha256=%s\n' "$_sha"
	} >"$_meta"
}

read_meta_field() {
	_file=$1
	_key=$2
	sed -n "s/^${_key}=//p" "$_file" | head -n 1
}

snapshot_current() {
	_omp_cmd=$(resolve_omp)
	_source=$(resolve_file "$_omp_cmd")
	_version=$(omp_version "$_omp_cmd")
	_stamp=$(date -u +%Y%m%dT%H%M%SZ)
	_id=${_stamp}-$(sanitize_id_part "$_version")-$$
	_dir=$(snapshots_dir)/$_id
	mkdir -p "$_dir" || die "$EX_IO" "could not create snapshot $_dir"
	if ! cp -p "$_source" "$_dir/omp"; then
		rm -rf "$_dir"
		die "$EX_IO" "could not copy $_source into snapshot"
	fi
	_sha=$(file_sha256 "$_dir/omp")
	write_meta "$_dir/meta" "$_version" "$_source" "$_sha"
	printf '%s\n' "$_id"
}

restore_snapshot() {
	_id=$1
	_dir=$(snapshots_dir)/$_id
	if [ ! -d "$_dir" ] || [ ! -f "$_dir/omp" ]; then
		die "$EX_ROLLBACK" "snapshot not found: $_id"
	fi
	_source=$(read_meta_field "$_dir/meta" source)
	if [ -z "$_source" ]; then
		_omp_cmd=$(resolve_omp)
		_source=$(resolve_file "$_omp_cmd")
	fi
	_parent=$(dirname "$_source")
	if [ ! -d "$_parent" ]; then
		die "$EX_ROLLBACK" "restore target directory missing: $_parent"
	fi
	_tmp=$_source.omp-sync-restore.$$
	if ! cp -p "$_dir/omp" "$_tmp"; then
		rm -f "$_tmp"
		die "$EX_ROLLBACK" "could not stage restored binary at $_tmp"
	fi
	chmod +x "$_tmp" 2>/dev/null || true
	if ! mv -f "$_tmp" "$_source"; then
		rm -f "$_tmp"
		die "$EX_ROLLBACK" "could not replace $_source with snapshot $_id"
	fi
	log "omp-sync: restored $_source from snapshot $_id"
}

latest_snapshot_id() {
	_snaps=$(snapshots_dir)
	if [ ! -d "$_snaps" ]; then
		return 1
	fi
	_last=""
	for _name in "$_snaps"/*; do
		[ -d "$_name" ] || continue
		_id=$(basename "$_name")
		is_snapshot_id "$_id" || continue
		_last=$_id
	done
	if [ -z "$_last" ]; then
		return 1
	fi
	printf '%s\n' "$_last"
}

prune_snapshots() {
	_keep=${OMP_SYNC_KEEP:-$KEEP_DEFAULT}
	case "$_keep" in
		'' | *[!0-9]*) _keep=$KEEP_DEFAULT ;;
	esac
	if [ "$_keep" -lt 1 ]; then
		_keep=1
	fi
	_snaps=$(snapshots_dir)
	_list=""
	_n=0
	for _name in "$_snaps"/*; do
		[ -d "$_name" ] || continue
		_id=$(basename "$_name")
		is_snapshot_id "$_id" || continue
		_list="$_list $_id"
		_n=$((_n + 1))
	done
	# Word-split is safe: snapshot ids never contain whitespace.
	# shellcheck disable=SC2086
	set -- $_list
	while [ "$#" -gt "$_keep" ]; do
		_old=$1
		shift
		# Only delete a recognized snapshot directory under the snapshots root.
		if is_snapshot_id "$_old" && [ -d "$_snaps/$_old" ]; then
			rm -rf "$_snaps/$_old"
			log "omp-sync: pruned snapshot $_old"
		fi
	done
}

looks_like_network_error() {
	_text=$1
	printf '%s\n' "$_text" | grep -Ei \
		'failed to check for updates|unable to connect|enotfound|econnreset|etimedout|networkerror|getaddrinfo|could not resolve host|operation timed out|certificate|tls|socket hang up|network is unreachable|temporary failure in name resolution|429|rate.?limit|fetch failed' \
		>/dev/null 2>&1
}

LAST_UPDATE_RC=0

run_omp_update() {
	_omp=$1
	shift
	_log=$(sync_root)/last-run.log
	set +e
	"$_omp" update "$@" >"$_log" 2>&1
	LAST_UPDATE_RC=$?
	set -e
	cat "$_log" || true
}

cmd_check() {
	_omp=$(resolve_omp)
	run_omp_update "$_omp" --check
	_log=$(cat "$(sync_root)/last-run.log" 2>/dev/null || true)
	if [ "$LAST_UPDATE_RC" -eq 0 ]; then
		exit "$EX_OK"
	fi
	if looks_like_network_error "$_log"; then
		log "omp-sync: update check failed due to network; existing install left unchanged"
		exit "$EX_NETWORK"
	fi
	die "$EX_APPLY" "omp update --check failed (exit $LAST_UPDATE_RC)"
}

relink_extensions() {
	_omp=$1
	_spec=${OMP_SYNC_RELINK_EXT:-}
	if [ -z "$_spec" ]; then
		return 0
	fi
	_oldifs=$IFS
	IFS=:
	# shellcheck disable=SC2086
	set -- $_spec
	IFS=$_oldifs
	for _path in "$@"; do
		[ -n "$_path" ] || continue
		case "$_path" in
			~/*) _path=$HOME/${_path#~/} ;;
		esac
		if [ ! -e "$_path" ]; then
			log "omp-sync: skip relink, path does not exist: $_path"
			continue
		fi
		log "omp-sync: relinking local plugin $_path"
		if ! "$_omp" plugin link "$_path"; then
			log "omp-sync: warning: plugin link failed for $_path"
		fi
	done
}

run_smoke() {
	if [ -z "${OMP_SYNC_SMOKE_CMD:-}" ]; then
		return 0
	fi
	log "omp-sync: running smoke command"
	# Intentionally a shell command so callers can compose checks.
	# shellcheck disable=SC2086
	sh -c "$OMP_SYNC_SMOKE_CMD"
}

restore_and_fail() {
	_id=$1
	_msg=$2
	if [ -n "$_id" ]; then
		restore_snapshot "$_id" || die "$EX_APPLY" "update failed and restore of $_id also failed: $_msg"
		log "omp-sync: $_msg; previous binary restored"
	else
		log "omp-sync: $_msg; no snapshot to restore"
	fi
	exit "$EX_APPLY"
}

cmd_apply() {
	_omp=$(resolve_omp)
	_source=$(resolve_file "$_omp")
	_before=$(omp_version "$_omp")

	# Probe first so a registry outage never replaces the binary.
	run_omp_update "$_omp" --check
	_check_log=$(cat "$(sync_root)/last-run.log" 2>/dev/null || true)
	if [ "$LAST_UPDATE_RC" -ne 0 ]; then
		if looks_like_network_error "$_check_log"; then
			log "omp-sync: network failure during check; not applying"
			exit "$EX_NETWORK"
		fi
		die "$EX_APPLY" "omp update --check failed (exit $LAST_UPDATE_RC); not applying"
	fi
	if printf '%s\n' "$_check_log" | grep -q 'Already up to date'; then
		log "omp-sync: already up to date ($_before); no snapshot taken"
		exit "$EX_OK"
	fi

	_id=$(snapshot_current)
	log "omp-sync: snapshot $_id of $_source ($_before)"

	# Re-resolve in case PATH/env changed; still the official updater.
	set +e
	# shellcheck disable=SC2086
	"$_omp" update $PASS_THROUGH >"$(sync_root)/last-run.log" 2>&1
	_upd_rc=$?
	set -e
	cat "$(sync_root)/last-run.log" >&2 || true
	_upd_log=$(cat "$(sync_root)/last-run.log" 2>/dev/null || true)

	if [ "$_upd_rc" -ne 0 ]; then
		if looks_like_network_error "$_upd_log"; then
			restore_and_fail "$_id" "network failure during apply"
		fi
		restore_and_fail "$_id" "omp update failed (exit $_upd_rc)"
	fi

	_after_bin=$(resolve_omp)
	if ! "$_after_bin" --version >/dev/null 2>&1; then
		restore_and_fail "$_id" "updated binary does not run --version"
	fi

	if ! run_smoke; then
		restore_and_fail "$_id" "smoke command failed"
	fi

	relink_extensions "$_after_bin"
	prune_snapshots
	_after=$(omp_version "$_after_bin")
	log "omp-sync: apply complete ($_before -> $_after); snapshot $_id retained"
	exit "$EX_OK"
}

cmd_rollback() {
	_id=${ROLLBACK_ID:-}
	if [ -z "$_id" ]; then
		_id=$(latest_snapshot_id) || die "$EX_ROLLBACK" "no snapshots under $(snapshots_dir)"
	fi
	if ! is_snapshot_id "$_id"; then
		die "$EX_USAGE" "invalid snapshot id: $_id"
	fi
	restore_snapshot "$_id"
	_omp=$(resolve_omp)
	if ! "$_omp" --version >/dev/null 2>&1; then
		die "$EX_ROLLBACK" "restored binary does not run --version"
	fi
	log "omp-sync: rollback complete to $_id ($(omp_version "$_omp"))"
	exit "$EX_OK"
}

cmd_list() {
	_snaps=$(snapshots_dir)
	if [ ! -d "$_snaps" ]; then
		log "omp-sync: no snapshot directory"
		exit "$EX_OK"
	fi
	_any=0
	for _dir in "$_snaps"/*; do
		[ -d "$_dir" ] || continue
		_id=$(basename "$_dir")
		is_snapshot_id "$_id" || continue
		_any=1
		_ver=$(read_meta_field "$_dir/meta" version)
		_src=$(read_meta_field "$_dir/meta" source)
		_created=$(read_meta_field "$_dir/meta" created)
		_size=$(wc -c <"$_dir/omp" 2>/dev/null | tr -d ' ')
		printf '%s\t%s\t%s\t%s\t%s bytes\n' "$_id" "${_ver:-?}" "${_created:-?}" "${_src:-?}" "${_size:-?}"
	done
	if [ "$_any" -eq 0 ]; then
		log "omp-sync: no snapshots"
	fi
	exit "$EX_OK"
}

parse_args() {
	if [ "$#" -eq 0 ]; then
		usage
		exit "$EX_USAGE"
	fi
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--check)
				[ -z "$ACTION" ] || die "$EX_USAGE" "conflicting actions"
				ACTION=check
				shift
				;;
			--apply)
				[ -z "$ACTION" ] || die "$EX_USAGE" "conflicting actions"
				ACTION=apply
				shift
				;;
			--rollback)
				[ -z "$ACTION" ] || die "$EX_USAGE" "conflicting actions"
				ACTION=rollback
				shift
				if [ "$#" -gt 0 ]; then
					case "$1" in
						--*) ;;
						*)
							ROLLBACK_ID=$1
							shift
							;;
					esac
				fi
				;;
			--list)
				[ -z "$ACTION" ] || die "$EX_USAGE" "conflicting actions"
				ACTION=list
				shift
				;;
			--help | -h)
				usage
				exit "$EX_OK"
				;;
			--)
				shift
				PASS_THROUGH=$*
				break
				;;
			*)
				die "$EX_USAGE" "unknown option: $1"
				;;
		esac
	done
	if [ -z "$ACTION" ]; then
		usage
		exit "$EX_USAGE"
	fi
}

main() {
	parse_args "$@"
	if [ -z "${HOME:-}" ]; then
		die "$EX_USAGE" "HOME is not set"
	fi
	ensure_sync_dirs
	trap release_lock EXIT INT TERM HUP
	acquire_lock
	case "$ACTION" in
		check) cmd_check ;;
		apply) cmd_apply ;;
		rollback) cmd_rollback ;;
		list) cmd_list ;;
		*) die "$EX_USAGE" "unknown action: $ACTION" ;;
	esac
}

main "$@"
