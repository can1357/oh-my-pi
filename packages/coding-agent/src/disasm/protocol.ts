/**
 * Cross-process contract between omp processes and the broker-supervised disassembler host daemon.
 *
 * Each open database runs in one daemon named {@link daemonName} under the project's daemon
 * broker (so it shows up in `omp ps`). The daemon is an omp worker (`host.ts`) that owns the
 * database lock and one Python worker, and serves NDJSON requests on {@link hostEndpoint}.
 */
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { DisasmBackendId } from "./backend";
export { DISASM_HOST_WORKER_ARG } from "../cli/worker-selectors";

/** Environment key carrying the JSON {@link HostConfig} for the daemon. */
export const DISASM_HOST_CONFIG_ENV = "OMP_DISASM_HOST_CONFIG";

/** Prefix of a backend's broker-supervised database hosts. */
export function daemonPrefix(backend: DisasmBackendId): string {
	return `omp.${backend}.`;
}

/** Prefixes counted together toward the shared open-database limit. */
export const DISASM_DAEMON_PREFIXES = ["omp.ida.", "omp.ghidra."];

/** Broker daemon names are capped at 48 characters (`broker.ts`). */
const DAEMON_NAME_MAX = 48;

/** Broker readiness regex matched against the banner the host prints once it listens. */
export function hostReadyPattern(backend: DisasmBackendId): string {
	return String.raw`omp ${backend} host listening on \S+`;
}

/** Banner printed on stdout once the host socket accepts connections. */
export function hostReadyBanner(backend: DisasmBackendId, endpoint: string): string {
	return `omp ${backend} host listening on ${endpoint}`;
}

/** Message text of any thrown value, for logs and wire errors. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hash16(text: string): string {
	return Bun.hash.wyhash(text).toString(16).padStart(16, "0");
}

/** Broker daemon name for the database registered under `id` (a `locateDatabase` id). */
export function daemonName(backend: DisasmBackendId, id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
	const name = `${daemonPrefix(backend)}${safe}`;
	if (name.length <= DAEMON_NAME_MAX) return name;
	const prefix = `${daemonPrefix(backend)}${hash16(id)}-`;
	return `${prefix}${safe.slice(0, DAEMON_NAME_MAX - prefix.length)}`;
}

/** Unix socket or Windows named pipe the host for `daemonName` listens on. */
export function hostEndpoint(runtimeDir: string, daemonName: string): string {
	// Hashed to stay under the ~104-byte Unix socket path limit.
	return ipcEndpoint(runtimeDir, `disasm-${hash16(daemonName)}`);
}

/** Portable reference to one live database incarnation, safe to pass to a child in the same project. */
export interface DatabaseHandle {
	backend: DisasmBackendId;
	id: string;
	instance: string;
	project: string;
}

/** Encode a live host's identity without exposing its socket or process-local reference tokens. */
export function formatDatabaseHandle(handle: DatabaseHandle): string {
	const url = new URL(`dsm://${handle.backend}/${handle.id}/${handle.instance}`);
	url.searchParams.set("project", handle.project);
	return url.href;
}

/** Decode a portable reference; ordinary binary paths return undefined and malformed dsm references throw. */
export function parseDatabaseHandle(value: string): DatabaseHandle | undefined {
	if (!value.startsWith("dsm:")) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ToolError("Invalid dsm handle; pass the string returned by db.handle().");
	}
	const parts = url.pathname.split("/");
	const project = url.searchParams.get("project");
	if (
		(url.hostname !== "ida" && url.hostname !== "ghidra") ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		parts.length !== 3 ||
		!/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[2]) ||
		project === null ||
		!path.isAbsolute(project) ||
		url.searchParams.size !== 1
	) {
		throw new ToolError("Invalid dsm handle; pass the string returned by db.handle().");
	}
	return { backend: url.hostname, id: parts[1], instance: parts[2], project };
}

/** RPC methods an omp process may forward to the worker through `call`. */
export const HOST_CALL_METHODS = ["view", "exec", "rename", "comment", "set_type", "make_function", "save"] as const;

/** A method forwarded with `call`. */
export type HostCallMethod = (typeof HOST_CALL_METHODS)[number];

const hostRequestSchema = type({ id: "number", op: "'ping' | 'open' | 'status' | 'flush'" })
	.or({
		id: "number",
		op: "'call'",
		method: type.enumerated(...HOST_CALL_METHODS),
		params: "object",
		"timeoutMs?": "number",
	})
	.or({ id: "number", op: "'retain'", handle: "string" })
	.or({ id: "number", op: "'release'", lease: "string", save: "boolean" })
	.or({ id: "number", op: "'cancel'", target: "number" })
	.or({ id: "number", op: "'close'", save: "boolean" });

/**
 * One request frame sent to the host.
 * - `ping`: liveness probe, answered `"pong"` in any state.
 * - `open`: wait until the database is open; answers {@link HostStatus} or the open failure.
 * - `status`: current {@link HostStatus} without waiting.
 * - `call`: forward one worker request; `timeoutMs` covers the queue wait too.
 * - `cancel`: abort the caller's own pending `call` `target` (no answer).
 * - `retain`: pin this incarnation and return a reference token owned by the calling connection.
 * - `release`: release that connection's token; the last reference closes the database.
 * - `flush`: save when there are unsaved changes; answers `{ saved }`.
 * - `close`: close an unreferenced database for eviction; retained databases reject it.
 */
export type HostRequest = typeof hostRequestSchema.infer;

/** Decode one request line; throws on a malformed frame. */
export function parseHostRequest(line: string): HostRequest {
	return hostRequestSchema.assert(JSON.parse(line));
}

const hostResponseSchema = type({ id: "number", ok: "true", "result?": "unknown" }).or({
	id: "number",
	ok: "false",
	error: "string",
});

/** One response frame from the host. */
export type HostResponse = typeof hostResponseSchema.infer;

/** Decode one response line; throws on a malformed frame. */
export function parseHostResponse(line: string): HostResponse {
	return hostResponseSchema.assert(JSON.parse(line));
}

const sliceSchema = type({ arch: "string", cpuType: "number", offset: "number", size: "number" });
const fatSchema = type({ slice: sliceSchema, slices: sliceSchema.array() });

const hostStatusSchema = type({
	id: "string",
	ref: "string",
	handle: "string",
	references: "number",
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
 * from every omp process; `references` pins against idle/LRU close; `handle` identifies this
 * host incarnation; `lastUsed` drives eviction; `dirty` means a close would save.
 */
export type HostStatus = typeof hostStatusSchema.infer;

/** Validate a `status`/`open` result. */
export function parseHostStatus(value: unknown): HostStatus {
	return hostStatusSchema.assert(value);
}

const retainedReferenceSchema = type({ lease: "string", handle: "string", references: "number" });

/** One connection-owned reference acquired with retain. */
export type RetainedReference = typeof retainedReferenceSchema.infer;

/** Validate a retain response before storing its lifetime token. */
export function parseRetainedReference(value: unknown): RetainedReference {
	return retainedReferenceSchema.assert(value);
}

const hostConfigSchema = type({
	backend: "'ida' | 'ghidra'",
	projectDir: "string",
	endpoint: "string",
	loc: {
		id: "string",
		dir: "string",
		sourcePath: "string",
		stagedPath: "string",
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
export type HostConfig = typeof hostConfigSchema.infer;

/** Decode the host config from {@link DISASM_HOST_CONFIG_ENV}; throws on a malformed value. */
export function parseHostConfig(json: string): HostConfig {
	return hostConfigSchema.assert(JSON.parse(json));
}
