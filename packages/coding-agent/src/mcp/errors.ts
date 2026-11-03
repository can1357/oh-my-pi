import { isRecord } from "@oh-my-pi/pi-utils";
import type { JsonRpcError } from "./types";

/** MCP transport used by a failed operation. */
export type MCPTransportKind = "http" | "stdio" | "unknown";

/** Protocol stage at which an MCP operation failed. */
export type MCPFailureStage = "connect" | "send" | "receive" | "decode" | "protocol";

/** Stable failure classes exposed in MCP tool diagnostics. */
export type MCPFailureClass =
	| "connect"
	| "timeout"
	| "eof"
	| "reset"
	| "malformed_response"
	| "json_rpc"
	| "http_status"
	| "closed"
	| "unknown";

interface MCPTransportErrorOptions {
	transport: MCPTransportKind;
	stage: MCPFailureStage;
	failure: MCPFailureClass;
	message: string;
	retryable: boolean;
	code?: string | number;
	data?: string;
	traceId?: string;
	cause?: unknown;
}

/** Longest MCP error message; the constructor cuts a longer one at its end. */
export const MCP_ERROR_MESSAGE_MAX_CHARS = 1_000;
const MAX_DATA_CHARS = 2_000;
const MAX_TRACE_ID_CHARS = 128;
const MAX_DATA_STRING_CHARS = 256;
const MAX_DATA_DEPTH = 5;
const MAX_DATA_ENTRIES = 30;
/** Bun's fetch hint, lowercased and without its final period. */
const FETCH_VERBOSE_ADVICE = "for more information, pass `verbose: true` in the second argument to fetch()";

/** The run of Bun fetch hints at the end of a text; see {@link trailingFetchAdvice}. */
export interface TrailingFetchAdvice {
	/** Where the run starts: the text before it is what stays. `value.length` when there is none. */
	start: number;
	/** Where each complete hint in the run starts, last first. */
	hints: number[];
}

/**
 * The run of Bun's fetch hints at the end of `value`: complete hints, with or
 * without whitespace or a final period between copies, and pieces of a hint
 * cut off (a process stopped while writing one, or the stream is still
 * writing it). Cut-off pieces count only when a complete hint comes before
 * them, so text that merely starts like a hint ("REFUSED for") is kept, and
 * only while the pieces since that hint are shorter than one hint. The
 * walk goes back over complete hints and cut-off pieces alike and ends the
 * run at the earliest complete hint it reaches, so the text before the run
 * ends in nothing the walk would take: removing the run again removes nothing
 * (redaction is idempotent). Each step goes back at least one character and
 * compares at most one hint's length of candidates, character by character.
 */
export function trailingFetchAdvice(value: string): TrailingFetchAdvice {
	const hints: number[] = [];
	let start = value.length;
	let cursor = value.length;
	/** Where the cut-off pieces since the last complete hint end, whitespace excluded. */
	let piecesEnd: number | undefined;
	for (;;) {
		let end = cursor;
		while (end > 0 && /\s/.test(value[end - 1]!)) end--;
		const before = hints.length;
		completeFetchAdviceStarts(value, end, hints);
		if (hints.length > before) {
			start = cursor = hints[hints.length - 1]!;
			piecesEnd = undefined;
			continue;
		}
		// A cut-off piece joins the run only if a complete hint is reached before it,
		// and the pieces since the last complete hint are shorter than one hint: a
		// process stopped mid-write leaves no more than that, and the walk stays short.
		// Measured from where the pieces end, so a second strip, which starts there,
		// measures the same.
		const partial = fetchAdvicePrefixLength(value, end);
		piecesEnd ??= end;
		if (partial === 0 || piecesEnd - (end - partial) > FETCH_VERBOSE_ADVICE.length) break;
		cursor = end - partial;
	}
	return { start, hints };
}

/** Push where each complete hint ending at or before `end` starts, last first. */
function completeFetchAdviceStarts(value: string, end: number, starts: number[]): void {
	for (;;) {
		let cut = end;
		while (cut > 0 && /\s/.test(value[cut - 1]!)) cut--;
		if (cut > 0 && value[cut - 1] === ".") cut--;
		const start = cut - FETCH_VERBOSE_ADVICE.length;
		if (start < 0 || matchedAdviceLength(value, start, cut) !== FETCH_VERBOSE_ADVICE.length) return;
		starts.push(start);
		end = start;
	}
}

/**
 * Length of the longest end of `value.slice(0, end)` that is the start of a
 * fetch hint and shorter than one (case-insensitive). The hint starts with
 * "f", and each candidate is compared character by character until it
 * differs, so text full of "f" costs no more than other text.
 */
function fetchAdvicePrefixLength(value: string, end: number): number {
	for (let start = Math.max(0, end - FETCH_VERBOSE_ADVICE.length + 1); start < end; start++) {
		if (matchedAdviceLength(value, start, end) === end - start) return end - start;
	}
	return 0;
}

/** How many characters of `value` from `start` (before `end`) match the hint's start, case-insensitively. */
function matchedAdviceLength(value: string, start: number, end: number): number {
	let length = 0;
	while (
		start + length < end &&
		length < FETCH_VERBOSE_ADVICE.length &&
		value[start + length]!.toLowerCase() === FETCH_VERBOSE_ADVICE[length]
	) {
		length++;
	}
	return length;
}

/**
 * `value` without the run of Bun fetch hints at its end and the whitespace
 * before it ({@link trailingFetchAdvice}). Idempotent, so a caller that budgets
 * text after this never loses room to a hint the error later drops.
 */
export function stripTrailingFetchAdvice(value: string): string {
	let end = trailingFetchAdvice(value).start;
	if (end === value.length) return value;
	while (end > 0 && /\s/.test(value[end - 1]!)) end--;
	return value.slice(0, end);
}

// Substring match, not exact: compound names (`client_secret`, `clientSecret`,
// `private_key`, `signingSecret`, `access_token`) must classify as secrets so
// their values never reach the exposed `data:` diagnostic.
const SECRET_KEY =
	/(?:authorization|bearer|cookie|secret|passw(?:or)?d|pwd|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|signature)/i;
const TRACE_KEYS = /^(?:trace[-_]?id|request[-_]?id|correlation[-_]?id|traceparent)$/i;

export class MCPTransportError extends Error {
	/** Transport implementation handling the failed operation. */
	readonly transport: MCPTransportKind;
	/** Protocol stage reached before failure. */
	readonly stage: MCPFailureStage;
	/** Stable machine-readable failure classification. */
	readonly failure: MCPFailureClass;
	/** Whether reconnecting and replaying follows the existing safe-retry policy. */
	readonly retryable: boolean;
	/** Transport, HTTP, subprocess, or JSON-RPC error code when available. */
	readonly code: string | number | undefined;
	/** Bounded, credential-redacted JSON-RPC error data. */
	readonly data: string | undefined;
	/** Safe server trace or request identifier. */
	readonly traceId: string | undefined;

	constructor(options: MCPTransportErrorOptions) {
		super(
			sanitizeDiagnosticText(options.message, MCP_ERROR_MESSAGE_MAX_CHARS),
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "MCPTransportError";
		this.transport = options.transport;
		this.stage = options.stage;
		this.failure = options.failure;
		this.retryable = options.retryable;
		this.code = options.code;
		this.data = options.data;
		this.traceId = options.traceId;
	}
}

/** Prevent replay once a request may have reached the server. */
export function nonRetryableMCPTransportError(error: MCPTransportError): MCPTransportError {
	if (!error.retryable) return error;
	return new MCPTransportError({
		transport: error.transport,
		stage: error.stage,
		failure: error.failure,
		message: error.message,
		retryable: false,
		code: error.code,
		data: error.data,
		traceId: error.traceId,
		cause: error,
	});
}

function errorCode(error: unknown): string | number | undefined {
	if (!isRecord(error)) return undefined;
	if (typeof error.code === "string" || typeof error.code === "number") return error.code;
	return error.cause === undefined ? undefined : errorCode(error.cause);
}

/**
 * Diagnostic text as an error shows it: without Bun's trailing fetch hints
 * ({@link stripTrailingFetchAdvice}), with credential values replaced
 * ({@link redactCredentials}). Idempotent.
 */
export function redactDiagnosticText(value: string): string {
	return redactCredentials(stripTrailingFetchAdvice(value));
}

/**
 * Replace credential values in text: bearer and basic credentials, credential
 * query parameters, and `key: value` / `key=value` pairs whose key names a
 * secret. A value is found from its label, so text must be redacted whole,
 * before any of it is cut away. Idempotent.
 */
export function redactCredentials(value: string): string {
	return (
		value
			// A credential is token68 and never contains `"`; `Bearer name="…"` is a
			// WWW-Authenticate challenge whose params (resource_metadata, scope, error)
			// drive OAuth discovery, so leave it intact.
			.replace(/\b(Bearer|Basic)\s+(?![\w.~+/-]+\s*=\s*")[^\s,;]+/gi, "$1 [redacted]")
			.replace(/([?&](?:access[-_]?token|api[-_]?key|key|token|secret|password)=)[^&#\s]+/gi, "$1[redacted]")
			.replace(
				/((?:authorization|api[-_]?key|private[-_]?key|access[-_]?key|token|secret|passw(?:or)?d|pwd|credential)\s*[:=]\s*)[^\s,;}]+/gi,
				"$1[redacted]",
			)
	);
}

function sanitizeDiagnosticText(value: string, maxChars: number): string {
	return redactDiagnosticText(value).slice(0, maxChars).trim();
}

function sanitizeData(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (depth > MAX_DATA_DEPTH) return "[truncated]";
	if (typeof value === "string") return sanitizeDiagnosticText(value, MAX_DATA_STRING_CHARS);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		return value.slice(0, MAX_DATA_ENTRIES).map(item => sanitizeData(item, depth + 1, seen));
	}
	if (!isRecord(value)) return String(value);
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	const result: Record<string, unknown> = {};
	let count = 0;
	for (const key in value) {
		if (count++ === MAX_DATA_ENTRIES) break;
		const item = value[key];
		result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeData(item, depth + 1, seen);
	}
	return result;
}

function serializeData(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(sanitizeData(value, 0, new WeakSet()));
		if (serialized.length <= MAX_DATA_CHARS) return serialized;
		let previewChars = MAX_DATA_CHARS - 64;
		for (;;) {
			const bounded = JSON.stringify({ truncated: true, preview: serialized.slice(0, previewChars) });
			if (bounded.length <= MAX_DATA_CHARS) return bounded;
			previewChars -= bounded.length - MAX_DATA_CHARS;
		}
	} catch {
		return undefined;
	}
}

function safeTraceId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_TRACE_ID_CHARS || !/^[A-Za-z0-9._:/-]+$/.test(trimmed)) return undefined;
	return trimmed;
}

function findTraceId(value: unknown, depth = 0): string | undefined {
	if (depth > MAX_DATA_DEPTH || !isRecord(value)) return undefined;
	for (const key in value) {
		const item = value[key];
		if (TRACE_KEYS.test(key)) {
			const traceId = safeTraceId(item);
			if (traceId) return traceId;
		}
		const nested = findTraceId(item, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

/** Extract a safe request or trace identifier from MCP HTTP response headers. */
export function mcpTraceIdFromHeaders(headers: Headers): string | undefined {
	for (const name of ["traceparent", "x-request-id", "x-trace-id", "x-correlation-id", "cf-ray"]) {
		const traceId = safeTraceId(headers.get(name));
		if (traceId) return traceId;
	}
	return undefined;
}

/** Preserve a server-provided JSON-RPC error without exposing credential-shaped data. */
export function createMCPJsonRpcError(
	transport: MCPTransportKind,
	error: JsonRpcError,
	traceId?: string,
): MCPTransportError {
	return new MCPTransportError({
		transport,
		stage: "protocol",
		failure: "json_rpc",
		message: `MCP error ${error.code}: ${error.message}`,
		retryable: false,
		code: error.code,
		data: serializeData(error.data),
		traceId: safeTraceId(traceId) ?? findTraceId(error.data),
	});
}

/** Classify an arbitrary transport exception while removing runtime-only advice. */
export function normalizeMCPTransportError(
	error: unknown,
	options: { transport: MCPTransportKind; stage: MCPFailureStage; traceId?: string },
): MCPTransportError {
	if (error instanceof MCPTransportError) return error;
	const message = sanitizeDiagnosticText(
		error instanceof Error ? error.message : String(error),
		MCP_ERROR_MESSAGE_MAX_CHARS,
	);
	let code = errorCode(error);
	const normalizedCode = typeof code === "string" ? code.toUpperCase() : code;
	const httpStatusMatch = /^HTTP (\d{3}):/i.exec(message);
	let failure: MCPFailureClass = "unknown";
	let retryable = false;

	if (
		normalizedCode === "ECONNREFUSED" ||
		normalizedCode === "CONNECTIONREFUSED" ||
		normalizedCode === "ENETUNREACH" ||
		normalizedCode === "EHOSTUNREACH" ||
		normalizedCode === "ENOTFOUND" ||
		normalizedCode === "EAI_AGAIN" ||
		normalizedCode === "FAILEDTOOPENSOCKET" ||
		/\b(?:ECONNREFUSED|ConnectionRefused|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|FailedToOpenSocket)\b/i.test(
			message,
		)
	) {
		failure = "connect";
		retryable = true;
	} else if (normalizedCode === "ECONNRESET" || /\bECONNRESET\b/i.test(message)) {
		failure = "reset";
		retryable = true;
	} else if (normalizedCode === "EPIPE" || /\b(?:EPIPE|eof|transport closed|socket closed)\b/i.test(message)) {
		failure = "eof";
		retryable = true;
	} else if (/timeout|timed out/i.test(message)) {
		failure = "timeout";
		retryable = false;
	} else if (
		error instanceof SyntaxError ||
		/(?:invalid|unexpected end).*(?:json|jsonl)|jsonl? (?:parse|parser) error|malformed/i.test(message)
	) {
		failure = "malformed_response";
	} else if (httpStatusMatch) {
		code = Number(httpStatusMatch[1]);
		failure = "http_status";
		retryable = code === 404 || code === 502 || code === 503;
	} else if (/not connected|connection failed|fetch failed/i.test(message)) {
		failure = "connect";
		retryable = true;
	}

	return new MCPTransportError({
		transport: options.transport,
		stage: failure === "connect" ? "connect" : failure === "malformed_response" ? "decode" : options.stage,
		failure,
		message: message || "Unknown MCP transport failure",
		retryable,
		code,
		traceId: safeTraceId(options.traceId),
		cause: error,
	});
}

function nextStep(error: MCPTransportError): string {
	// Every connection-class failure is retryable before dispatch, so a non-retryable one was lost after sending.
	if (
		!error.retryable &&
		(error.failure === "connect" ||
			error.failure === "eof" ||
			error.failure === "reset" ||
			error.failure === "closed")
	) {
		return "The connection was lost after the request was sent, so it may already have run; check its effect before retrying.";
	}
	switch (error.failure) {
		case "connect":
			return "Check that the MCP server is running and reachable, then retry.";
		case "timeout":
			return "Check server health or increase the MCP timeout; the request outcome is unknown.";
		case "eof":
		case "reset":
			return error.transport === "stdio"
				? "Inspect the MCP subprocess logs, restart the server, then retry."
				: "Check the MCP server logs and availability, then retry.";
		case "malformed_response":
			return "Inspect the MCP server logs for an invalid JSON-RPC response.";
		case "json_rpc":
			return "Address the server-reported MCP error before retrying.";
		case "http_status":
			return error.retryable
				? "Check the MCP server status, then retry."
				: "Check the MCP endpoint and authentication configuration.";
		case "closed":
			return "Reconnect the MCP server, then retry.";
		case "unknown":
			return "Inspect the MCP server logs and transport configuration.";
	}
}

/** Render an MCP tool failure as stable, actionable diagnostic fields. */
export function formatMCPToolFailure(error: unknown, serverName: string, toolName: string): string {
	const diagnostic =
		error instanceof MCPTransportError
			? error
			: normalizeMCPTransportError(error, { transport: "unknown", stage: "protocol" });
	const lines = [
		"MCP failure",
		`server: ${sanitizeDiagnosticText(serverName, MCP_ERROR_MESSAGE_MAX_CHARS)}`,
		`tool: ${sanitizeDiagnosticText(toolName, MCP_ERROR_MESSAGE_MAX_CHARS)}`,
		`transport: ${diagnostic.transport}`,
		`stage: ${diagnostic.stage}`,
		`failure: ${diagnostic.failure}`,
		`retryable: ${diagnostic.retryable ? "yes" : "no"}`,
		`message: ${diagnostic.message}`,
	];
	if (diagnostic.code !== undefined) lines.push(`code: ${String(diagnostic.code)}`);
	if (diagnostic.traceId !== undefined) lines.push(`trace_id: ${diagnostic.traceId}`);
	if (diagnostic.data !== undefined) lines.push(`data: ${diagnostic.data}`);
	lines.push(`next: ${nextStep(diagnostic)}`);
	return lines.join("\n");
}
