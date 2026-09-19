import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
/** Claude-style `.mcp.json` values below this are treated as seconds, not milliseconds. */
const CLAUDE_STYLE_TIMEOUT_MS_FLOOR = 1_000;

let neverAbortController: AbortController | undefined;

/**
 * Convert a Claude-style `.mcp.json` `timeout` into OMP milliseconds.
 *
 * Marketplace plugins (SAP `"timeout": 600`) use seconds. OMP's canonical
 * `MCPServer.timeout` is milliseconds. Bare numbers in `(0, 1000)` are
 * implausible as a connect/request deadline, so they are multiplied by 1000.
 * `0` still disables. Values `>= 1000` are already milliseconds and pass
 * through. Invalid values are ignored so callers fall back to the default.
 *
 * Do not use this for native OMP configs (`.omp/mcp.json`) or for
 * `resolveMCPTimeoutMs`; those already speak milliseconds.
 */
export function normalizeClaudeStyleMcpTimeoutMs(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
	if (raw === 0) return 0;
	if (raw < CLAUDE_STYLE_TIMEOUT_MS_FLOOR) return raw * 1_000;
	return raw;
}

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
}

/** Apply a deadline without allowing a later abort source to overwrite the first one. */
export function createMCPTimeout(timeoutMs: number, signal?: AbortSignal): MCPTimeoutOperation {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
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
	const onCallerAbort = (): void => {
		callerAborted = true;
		clearTimeout(timeoutId);
	};
	if (signal?.aborted) {
		callerAborted = true;
		abortController.abort(signal.reason);
	} else {
		timeoutId = setTimeout(() => {
			if (callerAborted) return;
			timerFired = true;
			abortController.abort();
		}, timeoutMs);
		signal?.addEventListener("abort", onCallerAbort, { once: true });
	}
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onCallerAbort);
		},
		isTimeoutAbort: error =>
			timerFired &&
			(error instanceof Error
				? error.name === "AbortError" || (error.name === "SyntaxError" && operationSignal.aborted)
				: false),
		timedOut: () => timerFired,
	};
}
