import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 600_000;
/** Hard cap on a default-deadline tool call that keeps reporting progress. */
const DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_MS = 3_600_000;
const MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 250;
const MCP_STARTUP_TIMEOUT_ENV = "OMP_MCP_STARTUP_TIMEOUT_MS";

let neverAbortController: AbortController | undefined;

function envTimeoutMs(): number | undefined {
	const raw = Bun.env[MCP_TIMEOUT_ENV]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (Number.isFinite(value) && value >= 0) return value;
	logger.warn("Ignoring invalid OMP_MCP_TIMEOUT_MS env value; expected a non-negative number", {
		value: raw,
	});
	return undefined;
}

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	return envTimeoutMs() ?? configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

/** Headroom over a tool's own requested wait, so its result can still arrive. */
const TOOL_TIMEOUT_ARG_MARGIN_MS = 30_000;
const SECONDS_ARG = /(?:^|_)(?:s|sec|secs|seconds?)$|Seconds?$|Secs?$/;
const MILLISECONDS_ARG = /(?:^|_)ms$|Ms$|_?millis(?:econds)?$/i;
const TIMEOUT_ARG = /^(?:timeout|wait|deadline|max_?wait)/i;

/**
 * The longest wait a `tools/call`'s own arguments ask for (`timeout`, `timeout_ms`,
 * `timeoutInSeconds`, `wait_seconds`, …), in ms. A bare `timeout` reads as seconds
 * up to 1000 and as milliseconds above.
 */
export function requestedToolTimeoutMs(args: unknown): number | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	let longest: number | undefined;
	for (const [key, value] of Object.entries(args)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !TIMEOUT_ARG.test(key)) continue;
		const ms = MILLISECONDS_ARG.test(key) ? value : SECONDS_ARG.test(key) || value <= 1000 ? value * 1000 : value;
		longest = longest === undefined ? ms : Math.max(longest, ms);
	}
	return longest;
}

/** Deadline for one request: `timeoutMs` restarts on progress, `maxTotalMs` bounds the whole call. */
export interface MCPRequestDeadline {
	timeoutMs: number;
	maxTotalMs: number;
}

/**
 * Deadline for one request. A configured timeout (`OMP_MCP_TIMEOUT_MS` or the server's `timeout`) is a
 * hard cap, as are handshakes and listings. A `tools/call` without one gets
 * {@link DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS}, restarted by progress up to
 * {@link DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_MS}. Neither is ever shorter than the wait the call's own
 * arguments request.
 */
export function resolveMCPRequestDeadline(
	configTimeout: number | undefined,
	method: string,
	params?: Record<string, unknown>,
): MCPRequestDeadline {
	const configured = envTimeoutMs() ?? configTimeout;
	if (method !== "tools/call") {
		const timeoutMs = configured ?? DEFAULT_MCP_TIMEOUT_MS;
		return { timeoutMs, maxTotalMs: timeoutMs };
	}
	const base = configured ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS;
	if (!isMCPTimeoutEnabled(base)) return { timeoutMs: base, maxTotalMs: base };
	const requested = requestedToolTimeoutMs(params?.arguments);
	const timeoutMs = requested === undefined ? base : Math.max(base, requested + TOOL_TIMEOUT_ARG_MARGIN_MS);
	const maxTotalMs = configured === undefined ? Math.max(timeoutMs, DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_MS) : timeoutMs;
	return { timeoutMs, maxTotalMs };
}

/** Resolve the non-blocking discovery window; zero waits for initial connections to settle. */
export function resolveMCPStartupTimeoutMs(configTimeout?: number): number {
	const raw = Bun.env[MCP_STARTUP_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn("Ignoring invalid OMP_MCP_STARTUP_TIMEOUT_MS env value; expected a non-negative number", {
			value: raw,
		});
	}
	return configTimeout ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

/** Tracks a request deadline separately from caller and transport cancellation. */
export interface MCPTimeoutOperation {
	signal?: AbortSignal;
	/** Clear the deadline while preserving cancellation of any still-open response stream. */
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
	/** True when this operation's own timer fired (regardless of what error a consumer saw). */
	timedOut: () => boolean;
	/** Restart the deadline (the server reported progress), never past the hard cap. No-op once it fired or was cleared. */
	refresh: () => void;
}

/** Apply a deadline without allowing a later abort source to overwrite the first one. */
export function createMCPTimeout(
	timeoutMs: number,
	signal?: AbortSignal,
	maxTotalMs: number = timeoutMs,
): MCPTimeoutOperation {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			isTimeoutAbort: () => false,
			timedOut: () => false,
			refresh: () => {},
		};
	}

	const abortController = new AbortController();
	// Track which abort source fired first so neither a later caller abort nor
	// a later timer can overwrite the earlier one. Without this:
	// - Timer fires during response.json(), caller aborts before catch →
	//   both signals aborted, old `!signal?.aborted` was false → timeout
	//   leaked as SyntaxError ("Unexpected end of JSON input").
	// - Caller aborts first, body-read rejects after timeoutMs → timer still
	//   fires → caller cancellation misreported as timeout.
	let timerFired = false;
	let callerAborted = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let cleared = false;
	const startedAt = Date.now();
	function onDeadline(): void {
		if (callerAborted) return;
		timerFired = true;
		abortController.abort();
	}
	const onCallerAbort = (): void => {
		callerAborted = true;
		clearTimeout(timeoutId);
	};
	if (signal?.aborted) {
		callerAborted = true;
		abortController.abort(signal.reason);
	} else {
		timeoutId = setTimeout(onDeadline, timeoutMs);
		signal?.addEventListener("abort", onCallerAbort, { once: true });
	}
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => {
			cleared = true;
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onCallerAbort);
		},
		refresh: () => {
			if (cleared || timerFired || callerAborted || timeoutId === undefined) return;
			const delay = Math.min(timeoutMs, startedAt + maxTotalMs - Date.now());
			if (delay <= 0) return;
			clearTimeout(timeoutId);
			timeoutId = setTimeout(onDeadline, delay);
		},
		isTimeoutAbort: error =>
			timerFired &&
			(error instanceof Error
				? error.name === "AbortError" || (error.name === "SyntaxError" && operationSignal.aborted)
				: false),
		timedOut: () => timerFired,
	};
}
