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
	ida: { default: 120, min: 1, max: 3600 },
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
}

/**
 * Resolve an `lsp` call's budgets from its `timeout` argument and the `lsp.requestTimeout` setting.
 *
 * Without an argument the server wait is the setting, and the call deadline is the tool default
 * raised to the setting so the call itself never cuts a slow server off first. An explicit
 * `timeout` sets both, raising or lowering them. Every value stays within the tool's
 * `min`/`max` and under a positive `maxTimeout` (`tools.maxTimeout`), like {@link clampTimeout}.
 */
export function resolveLspTimeouts(
	requested: number | undefined,
	requestTimeout: number,
	maxTimeout?: number,
): LspTimeouts {
	if (requested !== undefined) {
		const seconds = clampTimeout("lsp", requested, maxTimeout);
		return { call: seconds, wait: seconds };
	}
	return {
		call: clampTimeout("lsp", Math.max(TOOL_TIMEOUTS.lsp.default, requestTimeout), maxTimeout),
		wait: clampTimeout("lsp", requestTimeout, maxTimeout),
	};
}
