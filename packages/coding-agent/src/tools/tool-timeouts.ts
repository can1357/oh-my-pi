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
