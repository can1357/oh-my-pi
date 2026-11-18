/**
 * What a shell process and the omp process that started it agree on: the
 * worker's command line, and the frames that carry its internal-URL requests
 * back to the session that owns them.
 *
 * A shell process (`exec/shell-process-worker.ts`) is the bash tool's shell
 * run as a process of its own, for a named service or a command on a
 * pseudo-terminal. URL paths (`local://…`, `skill://…`) are served by the
 * session, so the process forwards each filesystem request it gets for one,
 * unchanged, over a line-framed IPC connection and awaits the response.
 */
import type { ShellFsRequest, ShellFsResponse } from "@oh-my-pi/pi-natives";

/** Where a shell process reaches the session serving its URL paths. */
export interface ShellProcessUrls {
	/** IPC endpoint of the session's URL server. */
	endpoint: string;
	/** Names the filesystem (session, approval tier) this process was granted. */
	token: string;
}

/** What one shell process runs. */
export interface ShellProcessSpec {
	command: string;
	/** Serves URL paths; without it every URL path is missing. */
	urls?: ShellProcessUrls;
	/** Script sourced before the command: the functions and aliases of the session it was started from. */
	source?: string;
	/** Directory to enter first when it is a URL path; a host directory is the process's own. */
	cwd?: string;
}

/** The worker arguments after its selector; {@link parseShellProcessArgs} reads them back. The command comes last. */
export function shellProcessArgs(spec: ShellProcessSpec): string[] {
	const args: string[] = [];
	if (spec.urls) args.push("--urls", spec.urls.endpoint, spec.urls.token);
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
		if (arg === "--urls" && at + 2 < args.length) {
			spec.urls = { endpoint: args[at + 1], token: args[at + 2] };
			at += 2;
		} else if (arg === "--source" && at + 1 < args.length) {
			spec.source = args[++at];
		} else if (arg === "--cwd" && at + 1 < args.length) {
			spec.cwd = args[++at];
		} else {
			return undefined;
		}
	}
	return undefined;
}

/** First frame of a connection: the grant every later request runs under. */
export interface ShellUrlHello {
	token: string;
}

/** One filesystem request of a shell process. */
export interface ShellUrlRequest {
	id: number;
	request: ShellFsRequest;
}

/** The session's answer to the {@link ShellUrlRequest} with the same id. */
export interface ShellUrlResponse {
	id: number;
	response: ShellFsResponse;
}

/** What a shell process is told once nothing serves its URL paths: they are missing. */
export const SHELL_URLS_GONE: ShellFsResponse = {
	error: { code: "ENOENT", message: "The session serving internal URLs is gone" },
};

/**
 * One frame as a line of JSON. Requests and responses are plain data except
 * for byte arrays and 64-bit offsets, which travel tagged.
 */
export function encodeShellUrlFrame(frame: ShellUrlHello | ShellUrlRequest | ShellUrlResponse): string {
	return JSON.stringify(frame, function (this: Record<string, unknown>, key, value) {
		// `Buffer#toJSON` has already run on `value`; the holder still has the bytes.
		const raw = this[key];
		if (raw instanceof Uint8Array) {
			return { $bytes: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") };
		}
		return typeof value === "bigint" ? { $bigint: value.toString() } : value;
	});
}

/** The frame {@link encodeShellUrlFrame} wrote as `line`; throws on malformed JSON. */
export function decodeShellUrlFrame(line: string): unknown {
	return JSON.parse(line, (_key, value) => {
		if (typeof value !== "object" || value === null) return value;
		if (typeof value.$bytes === "string") return new Uint8Array(Buffer.from(value.$bytes, "base64"));
		if (typeof value.$bigint === "string") return BigInt(value.$bigint);
		return value;
	});
}
