/** Versioned, authenticated daemon wire protocol. */
import type { DaemonProfile, DaemonShard } from "./status";

export type { DaemonProfile, DaemonShard } from "./status";

export const DAEMON_PROTOCOL_MAJOR = 2;
export const DAEMON_MAX_FRAME_BYTES = 1024 * 1024;
const DAEMON_SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const DAEMON_TERMINAL_OUTPUT_CHUNK_CODE_UNITS = 128 * 1024;

export type DaemonEncodedSnapshotChunk = Readonly<{
	encoding: "base64-json";
	data: string;
}>;

export type DaemonCapability = "snapshot" | "events" | "server_status" | (string & {});

export type DaemonEventDelivery = "all" | "terminal";

export type DaemonErrorCode =
	| "invalid_frame"
	| "invalid_version"
	| "unsupported_version"
	| "authentication_failed"
	| "invalid_request"
	| "not_found"
	| "session_busy"
	| "unavailable"
	| "internal";

const DAEMON_ERROR_CODES: Record<DaemonErrorCode, true> = {
	invalid_frame: true,
	invalid_version: true,
	unsupported_version: true,
	authentication_failed: true,
	invalid_request: true,
	not_found: true,
	session_busy: true,
	unavailable: true,
	internal: true,
};

function isDaemonErrorCode(value: string): value is DaemonErrorCode {
	return value in DAEMON_ERROR_CODES;
}

export type DaemonError = {
	code: DaemonErrorCode;
	message: string;
	retryable?: boolean;
};

export type DaemonHello = {
	v: number;
	tag: "hello";
	requestId: string;
	profile: DaemonProfile;
	token: string;
};

export type DaemonHelloOk = {
	v: number;
	tag: "hello_ok";
	requestId: string;
	daemonId: string;
	serverVersion: string;
	protocolVersion: number;
	shard: DaemonShard;
	capabilities: DaemonCapability[];
	/**
	 * Client↔server build pairing identity (see build-stamp.ts). Optional on
	 * the wire: a daemon predating the field parses as `undefined`, which
	 * connecting clients treat as a mismatch (stale build).
	 */
	buildStamp?: string;
};

export type DaemonSessionCreateOverrides = {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	argv?: string[];
	/** Terminal-identity env of the creating client (never the full env). */
	clientEnv?: Record<string, string>;
};
export type DaemonOperation =
	| { op: "ping" }
	| { op: "server_status" }
	| {
			op: "session_create";
			sessionId?: string;
			cwd: string;
			overrides?: DaemonSessionCreateOverrides;
	  }
	| { op: "session_list" }
	| { op: "session_load"; sessionId: string }
	| { op: "session_resume"; sessionId: string }
	| { op: "session_close"; sessionId: string }
	| {
			op: "attach";
			sessionId: string;
			attachmentId: string;
			mode: "interactive" | "observe";
			lastSeq?: number;
			delivery?: DaemonEventDelivery;
	  }
	| { op: "detach"; sessionId: string; attachmentId: string }
	| { op: "session_command"; sessionId: string; attachmentId: string; command: unknown }
	| { op: "snapshot_ack"; sessionId: string; attachmentId: string; seq: number }
	| { op: "shutdown" };

export type DaemonRequest = {
	v: number;
	tag: "request";
	requestId: string;
	operation: DaemonOperation;
};

export type DaemonResponse =
	| { v: number; tag: "response"; requestId: string; ok: true; result: unknown }
	| { v: number; tag: "response"; requestId: string; ok: false; error: DaemonError };

export type DaemonEvent = {
	v: number;
	tag: "event";
	sessionId: string;
	seq: number;
	event: unknown;
};

export type DaemonServerStatus = {
	daemonId: string;
	serverVersion: string;
	protocolVersion: number;
	shard: DaemonShard;
	sessionCount: number;
	attachmentCount: number;
	protectedJobCount: number;
	uptimeMs: number;
	/** Build pairing identity; absent on daemons predating the field. */
	buildStamp?: string;
};

export type DaemonServerStatusFrame = {
	v: number;
	tag: "server_status";
	status: DaemonServerStatus;
};

export type DaemonSnapshotBegin = {
	v: number;
	tag: "snapshot_begin";
	sessionId: string;
	attachmentId: string;
	barrierSeq: number;
};

export type DaemonSnapshotChunk = {
	v: number;
	tag: "snapshot_chunk";
	sessionId: string;
	attachmentId: string;
	barrierSeq: number;
	index: number;
	chunk: unknown;
};

export type DaemonSnapshotEnd = {
	v: number;
	tag: "snapshot_end";
	sessionId: string;
	attachmentId: string;
	barrierSeq: number;
	nextSeq: number;
};

export type DaemonSnapshotRestart = {
	v: number;
	tag: "snapshot_restart";
	sessionId: string;
	attachmentId: string;
	previousBarrierSeq: number;
	reason: "overflow" | "gap";
};

export type DaemonSnapshotFrame = DaemonSnapshotBegin | DaemonSnapshotChunk | DaemonSnapshotEnd | DaemonSnapshotRestart;

export type DaemonFrame =
	| DaemonHello
	| DaemonHelloOk
	| DaemonRequest
	| DaemonResponse
	| DaemonEvent
	| DaemonServerStatusFrame
	| DaemonSnapshotFrame;

export class DaemonProtocolError extends Error {
	readonly code: DaemonErrorCode;

	constructor(code: DaemonErrorCode, message: string) {
		super(message);
		this.name = "DaemonProtocolError";
		this.code = code;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DaemonProtocolError("invalid_frame", `${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new DaemonProtocolError("invalid_frame", `${label} must be a non-empty string`);
	}
	return value;
}

function requiredNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new DaemonProtocolError("invalid_frame", `${label} must be a finite number`);
	}
	return value;
}

function integer(value: unknown, label: string): number {
	const number = requiredNumber(value, label);
	if (!Number.isInteger(number) || number < 0) {
		throw new DaemonProtocolError("invalid_frame", `${label} must be a non-negative integer`);
	}
	return number;
}

function requiredBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new DaemonProtocolError("invalid_frame", `${label} must be a boolean`);
	return value;
}

function exact(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(source)) {
		if (!allowedSet.has(key)) throw new DaemonProtocolError("invalid_frame", `${label} has unknown field ${key}`);
	}
}

function version(source: Record<string, unknown>): number {
	const value = source.v;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new DaemonProtocolError("invalid_version", "protocol major must be a numeric integer");
	}
	if (value !== DAEMON_PROTOCOL_MAJOR) {
		throw new DaemonProtocolError("unsupported_version", `unsupported protocol major ${String(value)}`);
	}
	return value;
}

function profile(value: unknown, label: string): DaemonProfile {
	if (value === null) return null;
	const namedProfile = requiredString(value, label);
	if (namedProfile === "default") {
		throw new DaemonProtocolError("invalid_frame", `${label}: unnamed profile must be null`);
	}
	return namedProfile;
}

function shard(value: unknown, label: string): DaemonShard {
	const source = record(value, label);
	exact(source, ["profile"], label);
	return {
		profile: profile(source.profile, `${label}.profile`),
	};
}

function hello(value: unknown): DaemonHello {
	const source = record(value, "hello");
	const v = version(source);
	exact(source, ["v", "tag", "requestId", "profile", "token"], "hello");
	if (source.tag !== "hello") throw new DaemonProtocolError("invalid_frame", "frame tag must be hello");
	return {
		v,
		tag: "hello",
		requestId: requiredString(source.requestId, "hello.requestId"),
		profile: profile(source.profile, "hello.profile"),
		token: requiredString(source.token, "hello.token"),
	};
}

function helloOk(value: unknown): DaemonHelloOk {
	const source = record(value, "hello_ok");
	const v = version(source);
	exact(
		source,
		["v", "tag", "requestId", "daemonId", "serverVersion", "protocolVersion", "shard", "capabilities", "buildStamp"],
		"hello_ok",
	);
	if (source.tag !== "hello_ok") throw new DaemonProtocolError("invalid_frame", "frame tag must be hello_ok");
	const capabilities = source.capabilities;
	if (!Array.isArray(capabilities) || capabilities.some(item => typeof item !== "string" || item.length === 0))
		throw new DaemonProtocolError("invalid_frame", "hello_ok.capabilities must be strings");
	return {
		v,
		tag: "hello_ok",
		requestId: requiredString(source.requestId, "hello_ok.requestId"),
		daemonId: requiredString(source.daemonId, "hello_ok.daemonId"),
		serverVersion: requiredString(source.serverVersion, "hello_ok.serverVersion"),
		protocolVersion: integer(source.protocolVersion, "hello_ok.protocolVersion"),
		shard: shard(source.shard, "hello_ok.shard"),
		capabilities: capabilities as DaemonCapability[],
		...(source.buildStamp === undefined
			? {}
			: { buildStamp: requiredString(source.buildStamp, "hello_ok.buildStamp") }),
	};
}

function operation(value: unknown): DaemonOperation {
	function sessionCreate(source: Record<string, unknown>): DaemonOperation {
		exact(source, ["op", "sessionId", "cwd", "overrides"], "operation");
		const overridesValue = source.overrides;
		let overrides: DaemonSessionCreateOverrides | undefined;
		if (overridesValue !== undefined) {
			const overrideSource = record(overridesValue, "operation.overrides");
			exact(source, ["op", "sessionId", "cwd", "overrides"], "operation");
			exact(
				overrideSource,
				["provider", "model", "thinkingLevel", "steeringMode", "followUpMode", "argv", "clientEnv"],
				"operation.overrides",
			);
			const clientEnvValue = overrideSource.clientEnv;
			if (clientEnvValue !== undefined) {
				const clientEnvSource = record(clientEnvValue, "operation.overrides.clientEnv");
				for (const key in clientEnvSource) {
					if (typeof clientEnvSource[key] !== "string")
						throw new DaemonProtocolError(
							"invalid_request",
							"operation.overrides.clientEnv values must be strings",
						);
				}
			}
			const steeringMode = overrideSource.steeringMode;
			const followUpMode = overrideSource.followUpMode;
			if (steeringMode !== undefined && steeringMode !== "all" && steeringMode !== "one-at-a-time")
				throw new DaemonProtocolError("invalid_request", "operation.overrides.steeringMode is invalid");
			if (followUpMode !== undefined && followUpMode !== "all" && followUpMode !== "one-at-a-time")
				throw new DaemonProtocolError("invalid_request", "operation.overrides.followUpMode is invalid");
			const argvValue = overrideSource.argv;
			if (
				argvValue !== undefined &&
				(!Array.isArray(argvValue) || argvValue.some(argument => typeof argument !== "string"))
			) {
				throw new DaemonProtocolError("invalid_request", "operation.overrides.argv must be an array of strings");
			}
			overrides = {
				...(overrideSource.provider === undefined
					? {}
					: { provider: requiredString(overrideSource.provider, "operation.overrides.provider") }),
				...(overrideSource.model === undefined
					? {}
					: { model: requiredString(overrideSource.model, "operation.overrides.model") }),
				...(overrideSource.thinkingLevel === undefined
					? {}
					: { thinkingLevel: requiredString(overrideSource.thinkingLevel, "operation.overrides.thinkingLevel") }),
				...(steeringMode === undefined ? {} : { steeringMode }),
				...(followUpMode === undefined ? {} : { followUpMode }),
				...(argvValue === undefined ? {} : { argv: argvValue as string[] }),
				...(overrideSource.clientEnv === undefined
					? {}
					: { clientEnv: overrideSource.clientEnv as Record<string, string> }),
			};
		}
		return {
			op: "session_create",
			...(source.sessionId === undefined
				? {}
				: { sessionId: requiredString(source.sessionId, "operation.sessionId") }),
			cwd: requiredString(source.cwd, "operation.cwd"),
			...(overrides === undefined ? {} : { overrides }),
		};
	}

	const source = record(value, "operation");
	const op = requiredString(source.op, "operation.op");
	switch (op) {
		case "ping":
		case "server_status":
		case "session_list":
		case "shutdown":
			exact(source, ["op"], "operation");
			return { op };
		case "session_create":
			return sessionCreate(source);
		case "session_load":
		case "session_resume":
		case "session_close":
			exact(source, ["op", "sessionId"], "operation");
			return { op, sessionId: requiredString(source.sessionId, "operation.sessionId") };
		case "attach": {
			exact(source, ["op", "sessionId", "attachmentId", "mode", "lastSeq", "delivery"], "operation");
			const mode = source.mode;
			if (mode !== "interactive" && mode !== "observe")
				throw new DaemonProtocolError("invalid_request", "operation.mode must be interactive or observe");
			const delivery = source.delivery;
			if (delivery !== undefined && delivery !== "all" && delivery !== "terminal")
				throw new DaemonProtocolError("invalid_request", "operation.delivery must be all or terminal");
			return {
				op,
				sessionId: requiredString(source.sessionId, "operation.sessionId"),
				attachmentId: requiredString(source.attachmentId, "operation.attachmentId"),
				mode,
				...(source.lastSeq === undefined ? {} : { lastSeq: integer(source.lastSeq, "operation.lastSeq") }),
				...(delivery === undefined ? {} : { delivery }),
			};
		}
		case "detach":
			exact(source, ["op", "sessionId", "attachmentId"], "operation");
			return {
				op,
				sessionId: requiredString(source.sessionId, "operation.sessionId"),
				attachmentId: requiredString(source.attachmentId, "operation.attachmentId"),
			};
		case "session_command":
			exact(source, ["op", "sessionId", "attachmentId", "command"], "operation");
			if (source.command === undefined)
				throw new DaemonProtocolError("invalid_request", "operation.command is required");
			return {
				op,
				sessionId: requiredString(source.sessionId, "operation.sessionId"),
				attachmentId: requiredString(source.attachmentId, "operation.attachmentId"),
				command: source.command,
			};
		case "snapshot_ack":
			exact(source, ["op", "sessionId", "attachmentId", "seq"], "operation");
			return {
				op,
				sessionId: requiredString(source.sessionId, "operation.sessionId"),
				attachmentId: requiredString(source.attachmentId, "operation.attachmentId"),
				seq: integer(source.seq, "operation.seq"),
			};
		default:
			throw new DaemonProtocolError("invalid_request", `unsupported operation ${op}`);
	}
}

function request(value: unknown): DaemonRequest {
	const source = record(value, "request");
	const v = version(source);
	exact(source, ["v", "tag", "requestId", "operation"], "request");
	if (source.tag !== "request") throw new DaemonProtocolError("invalid_frame", "frame tag must be request");
	return {
		v,
		tag: "request",
		requestId: requiredString(source.requestId, "request.requestId"),
		operation: operation(source.operation),
	};
}

function daemonError(value: unknown): DaemonError {
	const source = record(value, "response.error");
	exact(source, ["code", "message", "retryable"], "response.error");
	const rawCode = requiredString(source.code, "response.error.code");
	if (!isDaemonErrorCode(rawCode))
		throw new DaemonProtocolError("invalid_frame", `unknown response error code ${rawCode}`);
	return {
		code: rawCode,
		message: requiredString(source.message, "response.error.message"),
		...(source.retryable === undefined
			? {}
			: { retryable: requiredBoolean(source.retryable, "response.error.retryable") }),
	};
}

function response(value: unknown): DaemonResponse {
	const source = record(value, "response");
	const v = version(source);
	exact(source, ["v", "tag", "requestId", "ok", "result", "error"], "response");
	if (source.tag !== "response") throw new DaemonProtocolError("invalid_frame", "frame tag must be response");
	const requestId = requiredString(source.requestId, "response.requestId");
	if (source.ok === true) {
		if (!("result" in source) || "error" in source)
			throw new DaemonProtocolError("invalid_frame", "successful response must contain result only");
		return { v, tag: "response", requestId, ok: true, result: source.result };
	}
	if (source.ok !== false || !("error" in source) || "result" in source)
		throw new DaemonProtocolError("invalid_frame", "failed response must contain error only");
	return { v, tag: "response", requestId, ok: false, error: daemonError(source.error) };
}
function snapshotBegin(value: unknown): DaemonSnapshotBegin {
	const source = record(value, "snapshot_begin");
	const v = version(source);
	exact(source, ["v", "tag", "sessionId", "attachmentId", "barrierSeq"], "snapshot_begin");
	if (source.tag !== "snapshot_begin")
		throw new DaemonProtocolError("invalid_frame", "frame tag must be snapshot_begin");
	return {
		v,
		tag: "snapshot_begin",
		sessionId: requiredString(source.sessionId, "snapshot_begin.sessionId"),
		attachmentId: requiredString(source.attachmentId, "snapshot_begin.attachmentId"),
		barrierSeq: integer(source.barrierSeq, "snapshot_begin.barrierSeq"),
	};
}

function snapshotChunk(value: unknown): DaemonSnapshotChunk {
	const source = record(value, "snapshot_chunk");
	const v = version(source);
	exact(source, ["v", "tag", "sessionId", "attachmentId", "barrierSeq", "index", "chunk"], "snapshot_chunk");
	if (source.tag !== "snapshot_chunk")
		throw new DaemonProtocolError("invalid_frame", "frame tag must be snapshot_chunk");
	if (!("chunk" in source)) throw new DaemonProtocolError("invalid_frame", "snapshot_chunk.chunk is required");
	return {
		v,
		tag: "snapshot_chunk",
		sessionId: requiredString(source.sessionId, "snapshot_chunk.sessionId"),
		attachmentId: requiredString(source.attachmentId, "snapshot_chunk.attachmentId"),
		barrierSeq: integer(source.barrierSeq, "snapshot_chunk.barrierSeq"),
		index: integer(source.index, "snapshot_chunk.index"),
		chunk: source.chunk,
	};
}

function snapshotEnd(value: unknown): DaemonSnapshotEnd {
	const source = record(value, "snapshot_end");
	const v = version(source);
	exact(source, ["v", "tag", "sessionId", "attachmentId", "barrierSeq", "nextSeq"], "snapshot_end");
	if (source.tag !== "snapshot_end") throw new DaemonProtocolError("invalid_frame", "frame tag must be snapshot_end");
	return {
		v,
		tag: "snapshot_end",
		sessionId: requiredString(source.sessionId, "snapshot_end.sessionId"),
		attachmentId: requiredString(source.attachmentId, "snapshot_end.attachmentId"),
		barrierSeq: integer(source.barrierSeq, "snapshot_end.barrierSeq"),
		nextSeq: integer(source.nextSeq, "snapshot_end.nextSeq"),
	};
}

function snapshotRestart(value: unknown): DaemonSnapshotRestart {
	const source = record(value, "snapshot_restart");
	const v = version(source);
	exact(source, ["v", "tag", "sessionId", "attachmentId", "previousBarrierSeq", "reason"], "snapshot_restart");
	if (source.tag !== "snapshot_restart")
		throw new DaemonProtocolError("invalid_frame", "frame tag must be snapshot_restart");
	if (source.reason !== "overflow" && source.reason !== "gap")
		throw new DaemonProtocolError("invalid_frame", "snapshot_restart.reason must be overflow or gap");
	return {
		v,
		tag: "snapshot_restart",
		sessionId: requiredString(source.sessionId, "snapshot_restart.sessionId"),
		attachmentId: requiredString(source.attachmentId, "snapshot_restart.attachmentId"),
		previousBarrierSeq: integer(source.previousBarrierSeq, "snapshot_restart.previousBarrierSeq"),
		reason: source.reason,
	};
}

function event(value: unknown): DaemonEvent {
	const source = record(value, "event");
	const v = version(source);
	exact(source, ["v", "tag", "sessionId", "seq", "event"], "event");
	if (source.tag !== "event") throw new DaemonProtocolError("invalid_frame", "frame tag must be event");
	if (!("event" in source)) throw new DaemonProtocolError("invalid_frame", "event.event is required");
	return {
		v,
		tag: "event",
		sessionId: requiredString(source.sessionId, "event.sessionId"),
		seq: integer(source.seq, "event.seq"),
		event: source.event,
	};
}

function status(value: unknown): DaemonServerStatus {
	const source = record(value, "server_status.status");
	exact(
		source,
		[
			"daemonId",
			"serverVersion",
			"protocolVersion",
			"shard",
			"sessionCount",
			"attachmentCount",
			"protectedJobCount",
			"uptimeMs",
			"buildStamp",
		],
		"server_status.status",
	);
	return {
		daemonId: requiredString(source.daemonId, "status.daemonId"),
		serverVersion: requiredString(source.serverVersion, "status.serverVersion"),
		protocolVersion: integer(source.protocolVersion, "status.protocolVersion"),
		shard: shard(source.shard, "status.shard"),
		sessionCount: integer(source.sessionCount, "status.sessionCount"),
		attachmentCount: integer(source.attachmentCount, "status.attachmentCount"),
		protectedJobCount: integer(source.protectedJobCount, "status.protectedJobCount"),
		uptimeMs: integer(source.uptimeMs, "status.uptimeMs"),
		...(source.buildStamp === undefined
			? {}
			: { buildStamp: requiredString(source.buildStamp, "status.buildStamp") }),
	};
}

function serverStatus(value: unknown): DaemonServerStatusFrame {
	const source = record(value, "server_status");
	const v = version(source);
	exact(source, ["v", "tag", "status"], "server_status");
	if (source.tag !== "server_status")
		throw new DaemonProtocolError("invalid_frame", "frame tag must be server_status");
	return { v, tag: "server_status", status: status(source.status) };
}

/** Strictly decode one protocol frame. */
export function parseDaemonFrame(value: unknown): DaemonFrame {
	const source = record(value, "frame");
	const tag = source.tag;
	switch (tag) {
		case "hello":
			return hello(source);
		case "hello_ok":
			return helloOk(source);
		case "request":
			return request(source);
		case "response":
			return response(source);
		case "event":
			return event(source);
		case "snapshot_begin":
			return snapshotBegin(source);
		case "snapshot_chunk":
			return snapshotChunk(source);
		case "snapshot_end":
			return snapshotEnd(source);
		case "snapshot_restart":
			return snapshotRestart(source);
		case "server_status":
			return serverStatus(source);
		default:
			throw new DaemonProtocolError("invalid_frame", `unknown frame tag ${String(tag)}`);
	}
}

/** Encode one frame as exactly one bounded NDJSON line. */
export function encodeDaemonFrame(frame: DaemonFrame): string {
	const parsed = parseDaemonFrame(frame);
	const line = `${JSON.stringify(parsed)}\n`;
	if (Buffer.byteLength(line, "utf8") > DAEMON_MAX_FRAME_BYTES)
		throw new DaemonProtocolError("invalid_frame", "frame exceeds maximum size");
	return line;
}

/** Decode one complete NDJSON line. */
export function decodeDaemonFrame(line: string): DaemonFrame {
	if (Buffer.byteLength(line, "utf8") > DAEMON_MAX_FRAME_BYTES)
		throw new DaemonProtocolError("invalid_frame", "frame exceeds maximum size");
	if (line.length === 0 || line.includes("\n") || line.includes("\r"))
		throw new DaemonProtocolError("invalid_frame", "frame must contain exactly one line");
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (error) {
		throw new DaemonProtocolError(
			"invalid_frame",
			`invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseDaemonFrame(value);
}

/** Split terminal writes without breaking UTF-16 surrogate pairs or the frame byte budget. */
export function splitDaemonTerminalOutput(data: string): readonly string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < data.length) {
		let end = Math.min(start + DAEMON_TERMINAL_OUTPUT_CHUNK_CODE_UNITS, data.length);
		if (
			end < data.length &&
			data.charCodeAt(end - 1) >= 0xd800 &&
			data.charCodeAt(end - 1) <= 0xdbff &&
			data.charCodeAt(end) >= 0xdc00 &&
			data.charCodeAt(end) <= 0xdfff
		)
			end--;
		chunks.push(data.slice(start, end));
		start = end;
	}
	return chunks.length > 0 ? chunks : [data];
}

/** Split an arbitrarily large snapshot into independently bounded wire payloads. */
export function encodeDaemonSnapshotChunks(snapshot: unknown): readonly DaemonEncodedSnapshotChunk[] {
	const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
	const chunks: DaemonEncodedSnapshotChunk[] = [];
	for (let offset = 0; offset < serialized.byteLength; offset += DAEMON_SNAPSHOT_CHUNK_BYTES) {
		chunks.push({
			encoding: "base64-json",
			data: serialized.subarray(offset, offset + DAEMON_SNAPSHOT_CHUNK_BYTES).toString("base64"),
		});
	}
	return chunks;
}

/** Reassemble encoded snapshot chunks while accepting legacy single-value snapshots. */
export function decodeDaemonSnapshotChunks(chunks: readonly unknown[]): unknown {
	const encoded = chunks.filter(
		(chunk): chunk is DaemonEncodedSnapshotChunk =>
			typeof chunk === "object" &&
			chunk !== null &&
			!Array.isArray(chunk) &&
			"encoding" in chunk &&
			chunk.encoding === "base64-json" &&
			"data" in chunk &&
			typeof chunk.data === "string",
	);
	if (encoded.length === 0) return chunks.at(-1);
	if (encoded.length !== chunks.length)
		throw new DaemonProtocolError("invalid_frame", "snapshot mixes encoded and legacy chunks");
	try {
		return JSON.parse(
			Buffer.concat(encoded.map(chunk => Buffer.from(chunk.data, "base64"))).toString("utf8"),
		) as unknown;
	} catch (error) {
		throw new DaemonProtocolError(
			"invalid_frame",
			`invalid snapshot JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
/** Parse one hello frame. */
export function parseDaemonHello(value: unknown): DaemonHello {
	return hello(value);
}

/** Parse one hello response frame. */
export function parseDaemonHelloOk(value: unknown): DaemonHelloOk {
	return helloOk(value);
}

/** Parse one request frame. */
export function parseDaemonRequest(value: unknown): DaemonRequest {
	return request(value);
}

/** Parse one response frame. */
export function parseDaemonResponse(value: unknown): DaemonResponse {
	return response(value);
}

/** Parse one authoritative server status payload. */
export function parseDaemonServerStatus(value: unknown): DaemonServerStatus {
	return status(value);
}
