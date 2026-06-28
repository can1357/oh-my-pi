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
