#!/bin/sh
# uninstall.sh — remove the omp deployment kit installation.
#
# Usage:
#   sudo ./uninstall.sh                  # remove binary + completions
#   sudo ./uninstall.sh --with-broker    # also stop/remove the auth-broker service
#   sudo ./uninstall.sh --purge-broker   # --with-broker AND delete the broker home
#                                        # (DESTROYS stored credentials — be sure)
#   ./uninstall.sh --destroot DIR        # remove a staged install
#
# Per-user data (~/.omp) is NEVER touched by this script.

set -eu

PREFIX="/usr/local"
DESTROOT=""
WITH_BROKER=0
PURGE_BROKER=0

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
	--purge-broker)
		WITH_BROKER=1
		PURGE_BROKER=1
		shift
		;;
	*)
		echo "unknown option: $1" >&2
		exit 2
		;;
	esac
done

if [ "$(id -u)" -ne 0 ] && [ -z "$DESTROOT" ]; then
	echo "ERROR: must run as root (sudo) unless --destroot is used" >&2
	exit 1
fi

log() { echo "==> $*"; }

rm -f "$DESTROOT$PREFIX/bin/omp" "$DESTROOT$PREFIX/bin/omp.prev"
log "removed binary"

rm -f "$DESTROOT/etc/profile.d/omp-completions.sh" "$DESTROOT/etc/profile.d/omp-path.sh"
rm -f "$DESTROOT$PREFIX/share/zsh/site-functions/_omp"
rm -f "$DESTROOT/etc/fish/completions/omp.fish"
log "removed completions"

if [ "$WITH_BROKER" -eq 1 ]; then
	if command -v systemctl >/dev/null 2>&1 && [ -z "$DESTROOT" ]; then
		systemctl disable --now omp-auth-broker.service 2>/dev/null || true
	fi
	rm -f "$DESTROOT/etc/systemd/system/omp-auth-broker.service"
	if command -v systemctl >/dev/null 2>&1 && [ -z "$DESTROOT" ]; then
		systemctl daemon-reload 2>/dev/null || true
	fi
	log "removed omp-auth-broker service"

	if [ "$PURGE_BROKER" -eq 1 ]; then
		BROKER_HOME="$(getent passwd omp-broker | cut -d: -f6)"
		userdel --remove omp-broker 2>/dev/null || true
		log "deleted omp-broker user and home ($BROKER_HOME) — stored credentials destroyed"
	else
		log "kept omp-broker user and its credential store (use --purge-broker to destroy)"
	fi
fi

log "uninstall complete (per-user ~/.omp data left untouched)"
