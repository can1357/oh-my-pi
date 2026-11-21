export interface ToolTimeoutConfig {
	/** Default timeout in seconds when agent omits the field */
	default: number;
	/** Minimum allowed timeout in seconds */
	min: number;
	/** Maximum allowed timeout in seconds (per-tool ceiling) */
	max: number;
}

export const TOOL_TIMEOUTS = {
	bash: { default: 300, min: 1, max: 3600 },
	eval: { default: 30, min: 1, max: 3600 },
	browser: { default: 30, min: 1, max: 300 },
	computer: { default: 120, min: 1, max: 300 },
	ssh: { default: 60, min: 1, max: 3600 },
	fetch: { default: 20, min: 1, max: 45 },
	lsp: { default: 20, min: 5, max: 300 },
	debug: { default: 30, min: 5, max: 300 },
	dsm: { default: 120, min: 1, max: 3600 },
} as const satisfies Record<string, ToolTimeoutConfig>;

export type ToolWithTimeout = keyof typeof TOOL_TIMEOUTS;

/**
 * Clamp a raw timeout to the allowed range for a tool.
 *
 * When `rawTimeout` is undefined the tool's `default` is used. A positive
 * `maxTimeout` (the `tools.maxTimeout` global ceiling) caps the *resolved*
 * value — including the default-fallback path — before the per-tool `min`/`max`
 * floor and ceiling apply, so a configured global cap governs calls where the
 * agent omits `timeout`, not only explicitly-passed values. `maxTimeout <= 0`
 * means no global cap.
 */
export function clampTimeout(tool: ToolWithTimeout, rawTimeout?: number, maxTimeout?: number): number {
	const config = TOOL_TIMEOUTS[tool];
	const timeout = rawTimeout ?? config.default;
	const capped = maxTimeout !== undefined && maxTimeout > 0 ? Math.min(timeout, maxTimeout) : timeout;
	return Math.max(config.min, Math.min(config.max, capped));
}

/** Budgets for one `lsp` tool call, in seconds. */
export interface LspTimeouts {
	/** Wall-clock deadline for the whole call. */
	call: number;
	/** How long to wait for a server that computes its answer on demand (project-aware diagnostics). */
	wait: number;
	/**
	 * The agent's explicit `timeout` when `lsp.minTimeout` raised it — the value the
	 * call asked for, before the floor applied. Absent otherwise.
	 */
	floorRaisedFrom?: number;
}

/**
 * The `lsp.minTimeout` floor, clamped into the tool's own range. Like the per-tool
 * minimum it wins over a lower `tools.maxTimeout` cap; `0`/undefined disables it.
 * Exported so the `lsp` tool description renders the effective floor, not the raw setting.
 */
export function lspFloorSeconds(minTimeout: number | undefined): number {
	return minTimeout !== undefined && minTimeout > 0
		? Math.min(Math.max(minTimeout, TOOL_TIMEOUTS.lsp.min), TOOL_TIMEOUTS.lsp.max)
		: 0;
}

/**
 * Resolve an `lsp` call's budgets from its `timeout` argument and the `lsp.requestTimeout` setting.
 *
 * Without an argument the server wait is the setting, and the call deadline is the tool default
 * raised to the setting so the call itself never cuts a slow server off first. An explicit
 * `timeout` sets both, raising or lowering them. Every value stays within the tool's
 * `min`/`max` and under a positive `maxTimeout` (`tools.maxTimeout`), like {@link clampTimeout},
 * except that a positive `minTimeout` (`lsp.minTimeout`) floors every budget — agent overrides
 * and the configured default alike — and, like the tool's own minimum, beats a lower global cap.
 */
export function resolveLspTimeouts(
	requested: number | undefined,
	requestTimeout: number,
	maxTimeout?: number,
	minTimeout?: number,
): LspTimeouts {
	const floor = lspFloorSeconds(minTimeout);
	if (requested !== undefined) {
		const seconds = clampTimeout("lsp", requested, maxTimeout);
		const call = Math.max(floor, seconds);
		// The floor beats a lower global cap for the budget, but the note below may
		// only claim a raise when the agent actually asked for less than the floor.
		if (floor > requested) return { call, wait: call, floorRaisedFrom: requested };
		return { call, wait: call };
	}
	return {
		call: Math.max(floor, clampTimeout("lsp", Math.max(TOOL_TIMEOUTS.lsp.default, requestTimeout), maxTimeout)),
		wait: Math.max(floor, clampTimeout("lsp", requestTimeout, maxTimeout)),
	};
}

/**
 * A note for `lsp` timeout errors naming where the budget came from: empty when the
 * agent passed no `timeout` (the configured default speaks for itself), the configured
 * default when an explicit agent override is in effect, and requested/effective values
 * when `lsp.minTimeout` raised an override. Non-empty notes start with a space so they
 * splice into {@link lspTimeoutMessage} after the server name.
 */
export function lspTimeoutSource(
	requested: number | undefined,
	requestTimeoutSec: number,
	budget: LspTimeouts,
): string {
	if (requested === undefined) return "";
	if (budget.floorRaisedFrom !== undefined) {
		return ` (agent requested ${budget.floorRaisedFrom}s; raised to the lsp.minTimeout floor of ${budget.call}s)`;
	}
	return ` (agent override; configured default: ${requestTimeoutSec}s)`;
}

/**
 * The `lsp` deadline ToolError message: budget and server, the budget's source note
 * when there is one, and the standing retry hint.
 */
export function lspTimeoutMessage(
	action: string,
	timeoutSec: number,
	serverName: string | undefined,
	note: string,
): string {
	const server = serverName ? ` on ${serverName}` : "";
	return `LSP ${action} timed out after ${timeoutSec}s${server}${note}. The server may still be indexing; try again or pass timeout=<larger>.`;
}
