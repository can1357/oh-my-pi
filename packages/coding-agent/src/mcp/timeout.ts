import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const DEFAULT_MCP_MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MCP_MAX_TIMEOUT_ENV = "OMP_MCP_MAX_TIMEOUT_MS";

let neverAbortController: AbortController | undefined;

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	const raw = Bun.env[MCP_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn("Ignoring invalid OMP_MCP_TIMEOUT_MS env value; expected a non-negative number", {
			value: raw,
		});
	}
	return configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

/**
 * Ceiling on a single request's total wait once `notifications/progress`
 * starts resetting its deadline. The MCP spec allows progress to reset the
 * timeout clock but requires a maximum regardless, so a server that keeps
 * reporting progress without ever answering cannot hold a turn forever.
 * `0` removes the ceiling.
 */
export function resolveMCPMaxTimeoutMs(): number {
	const raw = Bun.env[MCP_MAX_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn("Ignoring invalid OMP_MCP_MAX_TIMEOUT_MS env value; expected a non-negative number", {
			value: raw,
		});
	}
	return DEFAULT_MCP_MAX_TIMEOUT_MS;
}

/**
 * Window to grant a request that just reported progress: another full
 * `timeoutMs`, shortened so the request still expires at
 * `startedAt + maxTimeoutMs`. `0` means the ceiling is already spent and the
 * pending deadline must stand.
 */
export function progressWindowMs(args: {
	timeoutMs: number;
	startedAt: number;
	maxTimeoutMs: number;
	now?: number;
}): number {
	if (args.maxTimeoutMs <= 0) return args.timeoutMs;
	const remaining = args.startedAt + args.maxTimeoutMs - (args.now ?? Date.now());
	if (remaining <= 0) return 0;
	return Math.min(args.timeoutMs, remaining);
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

/** A request deadline composed with caller cancellation. */
export interface MCPTimeoutOperation {
	/** Signal to hand the underlying I/O, or `undefined` when nothing can abort it. */
	signal?: AbortSignal;
	/** Release the timer and listeners this operation owns. */
	clear: () => void;
	/**
	 * Re-arm the deadline because the server reported progress on this request.
	 * Capped by {@link resolveMCPMaxTimeoutMs}, and a no-op once the operation
	 * has already timed out or the caller aborted.
	 */
	refresh: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
	/** True when this operation's own timer fired (regardless of what error a consumer saw). */
	timedOut: () => boolean;
}

export function createMCPTimeout(timeoutMs: number, signal?: AbortSignal): MCPTimeoutOperation {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			refresh: () => {},
			isTimeoutAbort: () => false,
			timedOut: () => false,
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
	const startedAt = Date.now();
	const maxTimeoutMs = resolveMCPMaxTimeoutMs();
	const clearFns: Array<() => void> = [];
	const expire = () => {
		if (callerAborted) return;
		timerFired = true;
		abortController.abort();
	};
	if (signal?.aborted) {
		callerAborted = true;
		abortController.abort();
	} else {
		timeoutId = setTimeout(expire, timeoutMs);
		clearFns.push(() => clearTimeout(timeoutId));
		if (signal) {
			const onCallerAbort = () => {
				callerAborted = true;
				clearTimeout(timeoutId);
			};
			signal.addEventListener("abort", onCallerAbort, { once: true });
			clearFns.push(() => signal.removeEventListener("abort", onCallerAbort));
		}
	}
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => {
			for (const fn of clearFns) fn();
		},
		refresh: () => {
			if (timeoutId === undefined || timerFired || callerAborted) return;
			const window = progressWindowMs({ timeoutMs, startedAt, maxTimeoutMs });
			if (window <= 0) return;
			clearTimeout(timeoutId);
			timeoutId = setTimeout(expire, window);
		},
		isTimeoutAbort: error =>
			timerFired &&
			(error instanceof Error
				? error.name === "AbortError" || (error.name === "SyntaxError" && operationSignal.aborted)
				: false),
		timedOut: () => timerFired,
	};
}
