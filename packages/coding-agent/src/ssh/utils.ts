export function sanitizeHostName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

export function buildSshTarget(username: string | undefined, host: string): string {
	// SSH treats a destination starting with "-" as an option, so a host/user of
	// `-oProxyCommand=...` becomes local command execution. Reject before this
	// string reaches any `ssh` argv (this is the single render chokepoint for
	// every connection, transfer, and sshfs mount).
	if (host.startsWith("-")) {
		throw new Error(
			`Invalid SSH host "${host}": an SSH destination must not begin with "-" (argument-injection guard)`,
		);
	}
	if (username?.startsWith("-")) {
		throw new Error(
			`Invalid SSH username "${username}": an SSH username must not begin with "-" (argument-injection guard)`,
		);
	}
	return username ? `${username}@${host}` : host;
}

/**
 * Single-quote a path for a POSIX remote shell, escaping embedded single quotes.
 * Mirrors the private `quoteRemotePath` in `tools/ssh.ts`; shared here for the
 * `ssh://` file-transfer helpers.
 */
export function quotePosixPath(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a POSIX command in `<shell> -c '<command>'` so it runs under the
 * named shell rather than whatever `$SHELL` happens to be on the remote.
 *
 * Used by the `ssh://` transfer helpers and the Windows compat dispatch:
 * OpenSSH passes our snippets to `<login-shell> -c`, so a remote whose
 * login shell is fish/csh/tcsh (or cmd/powershell on Windows compat)
 * can't parse `if [ … ]; then …`. Wrapping forces parsing under the
 * shell OMP actually verified can run the snippet.
 *
 * `-c` (not `-lc`): the transfer snippets only call absolute POSIX
 * builtins (`head`/`cat`/`mv`/`test`/`ls`/`mkdir`/`rm`/`dirname`) and
 * don't need login-profile setup. Capability *probing* still uses
 * `-lc` to mirror the user's real environment.
 */
export function wrapInPosixShell(shell: "sh" | "bash" | "zsh", command: string): string {
	return `${shell} -c ${quotePosixPath(command)}`;
}
