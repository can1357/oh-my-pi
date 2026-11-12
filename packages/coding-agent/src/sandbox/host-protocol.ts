/**
 * JSONL wire protocol between the trusted parent ({@link ./shell-client}) and the in-sandbox host
 * ({@link ./host}). One JSON value per line; the host's stdout carries nothing else.
 *
 * Binary payloads (`Uint8Array`/`Buffer`) and `bigint`s, which the filesystem bridge carries,
 * travel as `{"$b": base64}` / `{"$n": decimal}` objects; {@link encodeHostMessage} and
 * {@link decodeHostMessage} apply that mapping to every message.
 *
 * {@link readHostLines} frames incoming streams, capping a line at {@link MAX_HOST_LINE_BYTES}.
 */
import type {
	AstFindOptions,
	AstFindResult,
	AstReplaceOptions,
	AstReplaceResult,
	GlobOptions,
	GlobResult,
	GrepMatch,
	GrepOptions,
	GrepResult,
	ListWorkspaceOptions,
	ListWorkspaceResult,
	MinimizerOptions,
	PtyRunResult,
	PtyStartOptions,
	ShellFsRequest,
	ShellFsResponse,
	ShellRunResult,
} from "@oh-my-pi/pi-natives";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { LogEvent } from "@oh-my-pi/pi-utils/logger";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import type { ResolvedSqliteReadPath } from "../tools/read-sqlite";

/** Bumped on every incompatible message change; the client refuses a host announcing another. */
export const SANDBOX_HOST_PROTOCOL_VERSION = 3;

/** `ShellOptions` minus `filesystem` (a parent-side callback; runs bridge it per call instead). */
export interface HostShellOptions {
	sessionEnv?: Record<string, string>;
	snapshotPath?: string;
	minimizer?: MinimizerOptions;
}

/** The serializable part of `ShellRunOptions`. */
export interface HostRunSpec {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

/** `PtyStartOptions` minus the abort signal (the client turns an abort into `pty.kill`). */
export type HostPtyStart = Omit<PtyStartOptions, "signal">;

/** Present on `shell.run` when the parent supplied a filesystem for URL paths. */
export interface HostRunFs {
	nativeLocalPaths?: boolean;
}

/**
 * A file mutation an in-process file tool (`write`, `edit`, `ast_edit`, `lsp`) delegates to the
 * host, so the OS sandbox decides it at the syscall. `write` creates missing parent directories,
 * like `Bun.write`; `mkdir` is recursive; `create` makes an empty file and fails with `EEXIST` when
 * the path exists; `rmdir` removes an empty directory.
 */
export type HostFileMutation =
	| { kind: "write"; path: string; data: string | Uint8Array }
	/** Appends `data` to an existing file: the later chunks of a write too large for one line. */
	| { kind: "append"; path: string; data: Uint8Array }
	| { kind: "create"; path: string }
	| { kind: "unlink"; path: string }
	| { kind: "mkdir"; path: string }
	| { kind: "rmdir"; path: string }
	| { kind: "rename"; from: string; to: string }
	| { kind: "rm"; path: string; recursive: boolean; force: boolean }
	| { kind: "chmod"; path: string; mode: number };

/** Identity of the file the host opened: what the parent compares its own handle against. */
export interface HostFileIdentity {
	dev: bigint;
	ino: bigint;
}

/** `astEdit` options minus the parent-side callbacks (the filesystem is bridged per request). */
export type HostAstEditOptions = Omit<AstReplaceOptions, "filesystem" | "signal">;
/** `astGrep` options minus the parent-side callbacks. */
export type HostAstGrepOptions = Omit<AstFindOptions, "filesystem" | "signal">;
/** `grep` options minus the parent-side callbacks (`onMatches` streams as `search.matches`). */
export type HostGrepOptions = Omit<GrepOptions, "filesystem" | "signal" | "onMatches">;
/** `glob` options minus the parent-side callbacks. */
export type HostGlobOptions = Omit<GlobOptions, "filesystem" | "signal">;

/** One `write`-tool row write into an existing SQLite database (empty `content`: delete the row). */
export interface HostSqliteWrite {
	dbPath: string;
	table: string;
	key: string | undefined;
	content: string;
}

export type HostRequest =
	| { id: number; op: "shell.create"; shell: number; options: HostShellOptions }
	| { id: number; op: "shell.fork"; shell: number; from: number }
	| { id: number; op: "shell.run"; shell: number; run: HostRunSpec; trace: boolean; fs: HostRunFs | null }
	| { id: number; op: "shell.abort"; shell: number }
	| { id: number; op: "shell.jobs"; shell: number }
	| { id: number; op: "shell.dispose"; shell: number }
	| { id: number; op: "pty.start"; pty: number; start: HostPtyStart }
	| { op: "pty.write"; pty: number; data: string }
	| { op: "pty.resize"; pty: number; cols: number; rows: number }
	| { id: number; op: "pty.kill"; pty: number }
	| { op: "fs.reply"; req: number; response: ShellFsResponse }
	| { id: number; op: "file.mutate"; mutation: HostFileMutation }
	/** Opens `path` for reading in the container and answers with what it opened. */
	| { id: number; op: "file.identify"; path: string }
	| { id: number; op: "dir.list"; options: ListWorkspaceOptions }
	/** `stream`: the parent passed `onMatches`; batches arrive as `search.matches` events. */
	| { id: number; op: "search.grep"; options: HostGrepOptions; fs: HostRunFs | null; stream: boolean }
	| { id: number; op: "search.glob"; options: HostGlobOptions; fs: HostRunFs | null }
	| { id: number; op: "ast.grep"; options: HostAstGrepOptions; fs: HostRunFs | null }
	| { id: number; op: "ast.edit"; options: HostAstEditOptions; fs: HostRunFs | null }
	| { id: number; op: "sqlite.read"; target: ResolvedSqliteReadPath }
	| { id: number; op: "sqlite.write"; write: HostSqliteWrite }
	/** Aborts the in-flight request `target` (its native call gets an aborted signal). */
	| { op: "call.abort"; target: number };

/** Result payload of each request op. */
export interface HostResults {
	"shell.create": null;
	"shell.fork": null;
	"shell.run": ShellRunResult;
	"shell.abort": null;
	"shell.jobs": number;
	"shell.dispose": null;
	"pty.start": { pid: number };
	"pty.kill": null;
	"file.mutate": null;
	"file.identify": HostFileIdentity;
	"dir.list": ListWorkspaceResult;
	"search.grep": GrepResult;
	"search.glob": GlobResult;
	"ast.grep": AstFindResult;
	/** An applied rewrite's `changes` is empty (reported by `fileChanges`); a dry run keeps them. */
	"ast.edit": AstReplaceResult;
	"sqlite.read": AgentToolResult<ReadToolDetails>;
	/** The write tool's result line. */
	"sqlite.write": string;
}

/** Log record forwarded from the host's logger; `timestamp` is epoch milliseconds. */
export type HostLogRecord = Omit<LogEvent, "timestamp"> & { timestamp: number };

export type HostEvent =
	| { ev: "ready"; version: number }
	| { id: number; ok: true; result: HostResults[keyof HostResults] }
	/** `code`: the errno name (`EACCES`, `ENOENT`, …) of a failed filesystem call, when there was one. */
	| { id: number; ok: false; error: string; code?: string }
	/** Output of the run started by request `id`. */
	| { ev: "shell.chunk"; id: number; data: string }
	/** Changed `RunTrace` snapshot (JSON text) of the run started by request `id`. */
	| { ev: "shell.trace"; id: number; snapshot: string }
	/** Changed live pids of the run started by request `id`. */
	| { ev: "shell.pids"; id: number; pids: number[] }
	/** URL-path filesystem operation of the run, search or `ast.edit` started by request `id`; answered by `fs.reply`. */
	| { ev: "fs.request"; id: number; req: number; request: ShellFsRequest }
	/** A batch of matches the streaming `search.grep` request `id` found. */
	| { ev: "search.matches"; id: number; matches: GrepMatch[] }
	| { ev: "pty.data"; pty: number; data: string }
	| { ev: "pty.exit"; pty: number; result: PtyRunResult; error?: string }
	| { ev: "log"; record: HostLogRecord };

interface EncodedBytes {
	$b: string;
}
interface EncodedBigint {
	$n: string;
}

function isEncodedBytes(value: object): value is EncodedBytes {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$b" && typeof (value as EncodedBytes).$b === "string";
}

function isEncodedBigint(value: object): value is EncodedBigint {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$n" && typeof (value as EncodedBigint).$n === "string";
}

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
	// `Buffer#toJSON` runs before the replacer sees `value`; the holder still has the original.
	const raw = this[key];
	if (raw instanceof Uint8Array) {
		return { $b: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") };
	}
	if (typeof value === "bigint") return { $n: value.toString() };
	return value;
}

function reviver(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	if (isEncodedBytes(value)) return Buffer.from(value.$b, "base64");
	if (isEncodedBigint(value)) return BigInt(value.$n);
	return value;
}

/** One protocol line, newline included. */
export function encodeHostMessage(message: HostRequest | HostEvent): string {
	return `${JSON.stringify(message, replacer)}\n`;
}

/** Parses one protocol line (without its newline). Bytes decode to `Buffer`, encoded integers to `bigint`. */
export function decodeHostMessage<T extends HostRequest | HostEvent>(line: string): T {
	return JSON.parse(line, reviver) as T;
}

/** Longest protocol line accepted; a peer exceeding it is broken (or hostile) and is dropped. */
export const MAX_HOST_LINE_BYTES = 64 * 1024 * 1024;

/**
 * The protocol lines of `stream`, decoded. Errors once a line grows past {@link MAX_HOST_LINE_BYTES}
 * without its newline, so a peer cannot make the reader buffer without bound.
 */
export async function* readHostLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	let pending = 0;
	const capped = stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const newline = chunk.lastIndexOf(0x0a);
				pending = newline === -1 ? pending + chunk.length : chunk.length - newline - 1;
				if (pending > MAX_HOST_LINE_BYTES) {
					controller.error(new Error(`Sandbox host protocol line exceeds ${MAX_HOST_LINE_BYTES} bytes`));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	const decoder = new TextDecoder();
	for await (const bytes of readLines(capped)) {
		if (bytes.length > 0) yield decoder.decode(bytes);
	}
}
