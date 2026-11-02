import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 250;
const MCP_STARTUP_TIMEOUT_ENV = "OMP_MCP_STARTUP_TIMEOUT_MS";

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
