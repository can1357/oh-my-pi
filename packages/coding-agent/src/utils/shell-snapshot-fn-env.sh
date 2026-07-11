# Helpers inlined into `generateSnapshotScript` (shell-snapshot.ts).
#
# Activation idioms like `mise activate` install a shell function whose body
# expands a sidecar env var (e.g. `mise() { command "$__MISE_EXE" "$@"; }`).
# The function survives `declare -f`/`typeset -f` capture, but the helper var
# is set on the rc-sourced shell and lost when only PATH gets re-exported.
# The replay shell then calls `command "" …` and dies with
# `command: command not found:` (issue #3470).
#
# `__omp_emit_referenced_exports` reads captured function bodies from stdin,
# extracts every `$VAR` / `${VAR…}` reference, and emits a single
# `export VAR='value'` line to stdout for each referenced var that
# (a) is currently set in this shell and (b) is not a shell-internal name.
# The script bodies are scanned, not interpreted — over-inclusion (refs inside
# comments / heredocs) is harmless because we only emit names that are set.
#
# Pure POSIX so the same helper works under bash and zsh.

# Wrap $1 in single quotes, escaping every embedded `'` as `'\''`.
__omp_sq_quote() {
	__omp_qbuf=$1
	__omp_qout=
	__omp_sq=\'
	while case "$__omp_qbuf" in *$__omp_sq*) true ;; *) false ;; esac; do
		__omp_qout=$__omp_qout${__omp_qbuf%%$__omp_sq*}"'\\''"
		__omp_qbuf=${__omp_qbuf#*$__omp_sq}
	done
	__omp_qout=$__omp_qout$__omp_qbuf
	printf "'%s'" "$__omp_qout"
}

# Emit `export NAME='value'` for $1 unless the name is a shell-internal we
# must never overwrite, a likely secret (token / key / password / credential
# patterns — kept conservative, since `__MISE_EXE` and `FOO_DIR` style helper
# vars never carry secrets), or the var is unset. POSIX `case` patterns are
# byte-exact so we list common uppercase variants; lowercase secret vars are
# rare and out of scope.
__omp_emit_export_for() {
	case "$1" in
		_|PATH|HOME|USER|LOGNAME|PWD|OLDPWD|SHELL|SHLVL|TERM|TERMINFO|TERMCAP|IFS|TMPDIR|TMOUT|LANG|RANDOM|LINENO|SECONDS|FUNCNAME|HISTFILE|HISTSIZE|HISTFILESIZE|HISTCMD|PS1|PS2|PS3|PS4|UID|EUID|GROUPS|HOSTNAME|HOSTTYPE|OSTYPE|MACHTYPE|PIPESTATUS|BASH|ZSH|argv|PROMPT|RPROMPT|RPS1|RPS2|status|pipestatus|COLUMNS|LINES|COLORTERM|FUNCNEST) return ;;
		LC_*|BASH_*|ZSH_*) return ;;
		# Common secret-name patterns — never materialise these into the
		# snapshot file even though it's now created 0600 (defence in depth
		# against the file ending up in a backup, tarball, or NFS share).
		*TOKEN*|*SECRET*|*PASSWORD*|*PASSWD*|*API_KEY*|*PRIVATE_KEY*|*ACCESS_KEY*|*CREDENTIAL*|*SESSION_KEY*) return ;;
	esac
	eval "[ \"\${$1+x}\" = x ]" 2>/dev/null || return
	eval "__omp_xv=\"\${$1}\"" 2>/dev/null || return
	printf 'export %s=%s\n' "$1" "$(__omp_sq_quote "$__omp_xv")"
}

# Read function bodies on stdin, emit dedup'd export lines on stdout.
__omp_emit_referenced_exports() {
	grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' \
		| sed -E 's/^\$\{?//' \
		| sort -u \
		| while IFS= read -r __omp_name; do
			__omp_emit_export_for "$__omp_name"
		done
}
