/**
 * What a shell process and the omp process that started it agree on: the
 * worker's command line.
 *
 * A shell process (`exec/shell-process-worker.ts`) is the bash tool's shell
 * run as a process of its own, for a named service or a command on a
 * pseudo-terminal. It has no session, so the URL paths its command may name
 * arrive as a {@link ShellPathMap}: the host locations behind the file-backed
 * schemes, fixed when the process starts.
 */

/** Host locations behind the URL schemes a shell process can open. */
export interface ShellPathMap {
	/** Root directory of `local://`. */
	local?: string;
	/** `local://` refuses writes: the command was approved below the tier its writes need. */
	localReadOnly?: true;
	/** Directory of `<id>.<ext>` files: `artifact://N` is its first entry named `N.*`, looked up per request. */
	artifacts?: string;
	/** Skill name → its instruction file: `skill://name` is that file, `skill://name/rest` is `rest` beside it. */
	skills?: Record<string, string>;
	/** `attachment://N` → its image file. */
	attachments?: Record<string, string>;
}

/** What one shell process runs. */
export interface ShellProcessSpec {
	command: string;
	/** Backs the URL paths the command names; without it every URL path is missing. */
	paths?: ShellPathMap;
	/** Script sourced before the command: the functions and aliases of the session it was started from. */
	source?: string;
	/** Directory to enter first when it is a URL path; a host directory is the process's own. */
	cwd?: string;
}

/** The worker arguments after its selector; {@link parseShellProcessArgs} reads them back. The command comes last. */
export function shellProcessArgs(spec: ShellProcessSpec): string[] {
	const args: string[] = [];
	if (spec.paths) args.push("--paths", JSON.stringify(spec.paths));
	if (spec.source !== undefined) args.push("--source", spec.source);
	if (spec.cwd !== undefined) args.push("--cwd", spec.cwd);
	args.push("--", spec.command);
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it maps names to strings. */
function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const record: Record<string, string> = {};
	for (const name in value) {
		const entry = value[name];
		if (typeof entry !== "string") return undefined;
		record[name] = entry;
	}
	return record;
}

/** The map `json` (as {@link shellProcessArgs} wrote it) holds, or undefined when it is not one. */
function parseShellPathMap(json: string): ShellPathMap | undefined {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const map: ShellPathMap = {};
	for (const key in value) {
		const entry = value[key];
		if ((key === "local" || key === "artifacts") && typeof entry === "string") map[key] = entry;
		else if (key === "localReadOnly" && entry === true) map.localReadOnly = true;
		else if (key === "skills" || key === "attachments") {
			const record = stringRecord(entry);
			if (!record) return undefined;
			map[key] = record;
		} else return undefined;
	}
	return map;
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
		if (arg === "--paths") {
			spec.paths = parseShellPathMap(value);
			if (!spec.paths) return undefined;
		} else if (arg === "--source") spec.source = value;
		else if (arg === "--cwd") spec.cwd = value;
		else return undefined;
	}
	return undefined;
}
