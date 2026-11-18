/**
 * Contract between omp processes and the daemon's `disasm` module (`daemon/modules/disasm.ts`).
 *
 * Each open database is one global-scope `disasm` unit keyed {@link disasmUnitKey} in the omp
 * daemon (so it shows up in `omp ps`). The unit owns the database lock and one Python worker;
 * omp processes speak NDJSON {@link HostRequest}s to it over an attached daemon tunnel.
 */
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { DisasmBackendId } from "./backend";

/** Daemon unit kind and module name. */
export const DISASM_UNIT_KIND = "disasm";

/** Unit key of the database registered under `id` (a `locateDatabase` id). */
export function disasmUnitKey(backend: DisasmBackendId, id: string): string {
	return `${backend}:${id}`;
}

/** Message text of any thrown value, for logs and wire errors. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Split a byte stream into LF-delimited UTF-8 lines; empty lines are skipped. */
export function lineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffered = "";
	return chunk => {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) onLine(line);
			newline = buffered.indexOf("\n");
		}
	};
}

/** Portable reference to one live database incarnation, safe to pass to another agent or process. */
export interface DatabaseHandle {
	backend: DisasmBackendId;
	id: string;
	instance: string;
}

/** Encode a live unit's identity without exposing its tunnel or connection-owned reference tokens. */
export function formatDatabaseHandle(handle: DatabaseHandle): string {
	return new URL(`dsm://${handle.backend}/${handle.id}/${handle.instance}`).href;
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
	if (
		(url.hostname !== "ida" && url.hostname !== "ghidra") ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		url.search ||
		parts.length !== 3 ||
		!/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[2])
	) {
		throw new ToolError("Invalid dsm handle; pass the string returned by db.handle().");
	}
	return { backend: url.hostname, id: parts[1], instance: parts[2] };
}

/** RPC methods an omp process may forward to the worker through `call`. */
export const HOST_CALL_METHODS = ["view", "exec", "rename", "comment", "set_type", "make_function", "save"] as const;

/** A method forwarded with `call`. */
export type HostCallMethod = (typeof HOST_CALL_METHODS)[number];

const hostRequestSchema = type({ id: "number", op: "'open' | 'status' | 'flush'" })
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
 * One request frame sent over a `disasm` unit tunnel.
 * - `open`: wait until the database is open; answers {@link HostStatus} or the open failure. On a
 *   closing unit it waits for the unit to exit, then fails with `gone`.
 * - `status`: current {@link HostStatus} without waiting; `gone` while the unit is closing.
 * - `call`: forward one worker request; `timeoutMs` covers the queue wait too.
 * - `cancel`: abort the caller's own pending `call` `target` (no answer).
 * - `retain`: pin this incarnation and return a reference token owned by the calling tunnel.
 * - `release`: release that tunnel's token; the last reference closes the database.
 * - `flush`: save when there are unsaved changes; answers `{ saved }`.
 * - `close`: close an unreferenced database; retained databases reject it.
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
	/** The unit is closing or closed: drop the tunnel and open a fresh unit. */
	"gone?": "boolean",
});

/** One response frame from the unit; `gone` marks a unit that is closing or closed. */
export type HostResponse = typeof hostResponseSchema.infer;

/** Decode one response line; throws on a malformed frame. */
export function parseHostResponse(line: string): HostResponse {
	return hostResponseSchema.assert(JSON.parse(line));
}

const sliceSchema = type({ arch: "string", cpuType: "number", offset: "number", size: "number" });
const fatSchema = type({ slice: sliceSchema, slices: sliceSchema.array() });
const infoSchema = type({ module: "string", format: "string", arch: "string", bitness: "number" });

const hostStatusSchema = type({
	id: "string",
	ref: "string",
	handle: "string",
	references: "number",
	"fat?": fatSchema,
	idbPath: "string",
	info: infoSchema,
	state: "'opening' | 'open'",
	busy: "boolean",
	lastUsed: "number",
	current: type({ method: "string", startedAt: "number" }).or("null"),
	dirty: "boolean",
});

/**
 * A unit's database as reported by `open`/`status`. `busy` counts queued and running requests
 * from every omp process; `references` pins against idle/LRU close; `handle` identifies this
 * incarnation; `lastUsed` is when it last ran a request (or started opening); `dirty` means a
 * close would save.
 */
export type HostStatus = typeof hostStatusSchema.infer;

/** Validate a `status`/`open` result. */
export function parseHostStatus(value: unknown): HostStatus {
	return hostStatusSchema.assert(value);
}

const retainedReferenceSchema = type({ lease: "string", handle: "string", references: "number" });

/** One tunnel-owned reference acquired with retain. */
export type RetainedReference = typeof retainedReferenceSchema.infer;

/** Validate a retain response before storing its lifetime token. */
export function parseRetainedReference(value: unknown): RetainedReference {
	return retainedReferenceSchema.assert(value);
}

const locationSchema = type({
	id: "string",
	dir: "string",
	sourcePath: "string",
	stagedPath: "string",
	kind: "'store' | 'inplace'",
	openPath: "string",
	isNew: "boolean",
	lockTarget: "string",
	"fat?": fatSchema,
});

const unitParamsSchema = type({
	backend: "'ida' | 'ghidra'",
	loc: locationSchema,
	runtime: { pythonPath: "string", env: "Record<string, string>" },
	/** Idle time before an unreferenced database is saved and closed; 0 keeps it open. */
	idleCloseMs: "number",
	/** Most databases open at once; the least recently used idle one is closed first. */
	maxOpen: "number",
});

/** `open` params of a `disasm` unit; built by the omp process that opens it (worker runtime included). */
export type DisasmUnitParams = typeof unitParamsSchema.infer;

/** Validate `disasm` unit params; throws on a malformed value. */
export function parseDisasmUnitParams(value: unknown): DisasmUnitParams {
	return unitParamsSchema.assert(value);
}

const workerStateSchema = type({
	pid: "number",
	startedAt: "number | null",
	endpoint: "string",
	token: "string",
	logPath: "string",
	"aliasDir?": "string",
	idbPath: "string",
	info: infoSchema,
});

/** Re-adoptable state of a detached Python worker (see `DisasmWorker.state`). */
export type WorkerState = typeof workerStateSchema.infer;

const unitStateSchema = type({
	params: unitParamsSchema,
	instance: "string",
	startedAt: "number",
	worker: workerStateSchema,
});

/** Snapshot a `disasm` unit persists to survive a daemon restart or crash. */
export type DisasmUnitState = typeof unitStateSchema.infer;

/** Validate a persisted unit snapshot; throws on a malformed value. */
export function parseDisasmUnitState(value: unknown): DisasmUnitState {
	return unitStateSchema.assert(value);
}
