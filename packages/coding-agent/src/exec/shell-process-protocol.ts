/**
 * What a shell process and the omp process that started it agree on: the
 * worker's command line.
 *
 * A shell process (`exec/shell-process-worker.ts`) is the bash tool's shell
 * run as a process of its own, for a named service or a command on a
 * pseudo-terminal. It has no session: what it needs of one arrives as a
 * script it sources before its command, so the command line stays short
 * whatever the session holds.
 */

/** What one shell process runs. */
export interface ShellProcessSpec {
	command: string;
	/**
	 * Script sourced before the command: `urlmap` lines mounting the session's
	 * file-backed URL paths, then its functions and aliases. A script that is
	 * gone by the time the process starts is skipped.
	 */
	source?: string;
	/** Directory to enter first when it is a URL path; a host directory is the process's own. */
	cwd?: string;
}

/** The worker arguments after its selector; {@link parseShellProcessArgs} reads them back. The command comes last. */
export function shellProcessArgs(spec: ShellProcessSpec): string[] {
	const args: string[] = [];
	if (spec.source !== undefined) args.push("--source", spec.source);
	if (spec.cwd !== undefined) args.push("--cwd", spec.cwd);
	args.push("--", spec.command);
	return args;
}

/** The spec `args` (as {@link shellProcessArgs} wrote them) describe, or undefined when they are malformed. */
export function parseShellProcessArgs(args: readonly string[]): ShellProcessSpec | undefined {
	const spec: ShellProcessSpec = { command: "" };
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === "--") {
			if (at !== args.length - 2) return undefined;
			spec.command = args[at + 1];
			return spec;
		}
		if (at + 1 >= args.length) return undefined;
		const value = args[++at];
		if (arg === "--source") spec.source = value;
		else if (arg === "--cwd") spec.cwd = value;
		else return undefined;
	}
	return undefined;
}
