/**
 * Cross-process contract between omp processes and the broker-supervised IDA host daemon.
 *
 * Each open database runs in one daemon named {@link idaDaemonName} under the project's daemon
 * broker (so it shows up in `omp ps`). The daemon is an omp worker (`host.ts`) that owns the
 * IDB lock and one Python worker, and serves NDJSON requests on {@link idaHostEndpoint}.
 */
import type * as net from "node:net";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
export { IDA_HOST_WORKER_ARG } from "../cli/worker-selectors";

/** Environment key carrying the JSON {@link IdaHostConfig} for the daemon. */
export const IDA_HOST_CONFIG_ENV = "OMP_IDA_HOST_CONFIG";

/** Name prefix of every IDA daemon in a broker scope. */
export const IDA_DAEMON_PREFIX = "omp.ida.";

/** Broker daemon names are capped at 48 characters (`broker.ts`). */
const DAEMON_NAME_MAX = 48;

/** Broker readiness regex matched against the banner the host prints once it listens. */
export const IDA_HOST_READY_PATTERN = String.raw`omp ida host listening on \S+`;

/** Banner printed on stdout once the host socket accepts connections. */
export function idaHostReadyBanner(endpoint: string): string {
	return `omp ida host listening on ${endpoint}`;
}

/** Message text of any thrown value, for logs and wire errors. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Feed every complete newline-terminated, non-blank line received on `socket` to `onLine`. */
export function readSocketLines(socket: net.Socket, onLine: (line: string) => void): void {
	const decoder = new TextDecoder();
	let buffer = "";
	socket.on("data", (chunk: Buffer) => {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
		}
	});
}

/** Write one NDJSON frame unless the socket is already gone. */
export function writeFrame(socket: net.Socket, frame: object): void {
	if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
}

function hash16(text: string): string {
	return Bun.hash.wyhash(text).toString(16).padStart(16, "0");
}

/** Broker daemon name for the database registered under `id` (a `locateIdb` id). */
export function idaDaemonName(id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
	const name = `${IDA_DAEMON_PREFIX}${safe}`;
	if (name.length <= DAEMON_NAME_MAX) return name;
	const prefix = `${IDA_DAEMON_PREFIX}${hash16(id)}-`;
	return `${prefix}${safe.slice(0, DAEMON_NAME_MAX - prefix.length)}`;
}

/** Unix socket or Windows named pipe the host for `daemonName` listens on. */
export function idaHostEndpoint(projectDir: string, runtimeDir: string, daemonName: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\omp-ida-${hash16(`${path.resolve(projectDir)}\0${daemonName}`)}`;
	}
	// Hashed to stay under the ~104-byte Unix socket path limit.
	return path.join(runtimeDir, `ida-${hash16(daemonName)}.sock`);
}

/** RPC methods an omp process may forward to the worker through `call`. */
export const IDA_CALL_METHODS = ["view", "exec", "rename", "comment", "set_type", "make_function", "save"] as const;

/** A method forwarded with `call`. */
export type IdaCallMethod = (typeof IDA_CALL_METHODS)[number];

const hostRequestSchema = type({ id: "number", op: "'ping' | 'open' | 'status' | 'flush'" })
	.or({
		id: "number",
		op: "'call'",
		method: type.enumerated(...IDA_CALL_METHODS),
		params: "object",
		"timeoutMs?": "number",
	})
	.or({ id: "number", op: "'cancel'", target: "number" })
	.or({ id: "number", op: "'close'", save: "boolean" });

/**
 * One request frame sent to the host.
 * - `ping`: liveness probe, answered `"pong"` in any state.
 * - `open`: wait until the database is open; answers {@link IdaHostStatus} or the open failure.
 * - `status`: current {@link IdaHostStatus} without waiting.
 * - `call`: forward one worker request; `timeoutMs` covers the queue wait too.
 * - `cancel`: abort the caller's own pending `call` `target` (no answer).
 * - `flush`: save when there are unsaved changes; answers `{ saved }`.
 * - `close`: save (when `save`) and close; the host exits after answering.
 */
export type IdaHostRequest = typeof hostRequestSchema.infer;

/** Decode one request line; throws on a malformed frame. */
export function parseIdaHostRequest(line: string): IdaHostRequest {
	return hostRequestSchema.assert(JSON.parse(line));
}

const hostResponseSchema = type({ id: "number", ok: "true", "result?": "unknown" }).or({
	id: "number",
	ok: "false",
	error: "string",
});

/** One response frame from the host. */
export type IdaHostResponse = typeof hostResponseSchema.infer;

/** Decode one response line; throws on a malformed frame. */
export function parseIdaHostResponse(line: string): IdaHostResponse {
	return hostResponseSchema.assert(JSON.parse(line));
}

const sliceSchema = type({ arch: "string", cpuType: "number", offset: "number", size: "number" });
const fatSchema = type({ slice: sliceSchema, slices: sliceSchema.array() });

const hostStatusSchema = type({
	id: "string",
	ref: "string",
	"fat?": fatSchema,
	idbPath: "string",
	info: { module: "string", format: "string", arch: "string", bitness: "number" },
	state: "'opening' | 'open'",
	busy: "boolean",
	lastUsed: "number",
	current: type({ method: "string", startedAt: "number" }).or("null"),
	dirty: "boolean",
});

/**
 * A host's database as reported by `open`/`status`. `busy` counts queued and running requests
 * from every omp process; `lastUsed` drives LRU eviction; `dirty` means a close would save.
 */
export type IdaHostStatus = typeof hostStatusSchema.infer;

/** Validate a `status`/`open` result. */
export function parseIdaHostStatus(value: unknown): IdaHostStatus {
	return hostStatusSchema.assert(value);
}

const hostConfigSchema = type({
	endpoint: "string",
	loc: {
		id: "string",
		dir: "string",
		sourcePath: "string",
		kind: "'store' | 'inplace'",
		openPath: "string",
		isNew: "boolean",
		lockTarget: "string",
		"fat?": fatSchema,
	},
	runtime: { pythonPath: "string", env: "Record<string, string>" },
	idleCloseMs: "number",
});

/** Everything the host needs to open its database; built by the omp process that starts it. */
export type IdaHostConfig = typeof hostConfigSchema.infer;

/** Decode the host config from {@link IDA_HOST_CONFIG_ENV}; throws on a malformed value. */
export function parseIdaHostConfig(json: string): IdaHostConfig {
	return hostConfigSchema.assert(JSON.parse(json));
}
