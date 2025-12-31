/**
 * Global output abstraction that respects --json mode.
 *
 * When --json is active, human-readable output is suppressed entirely.
 * Only the final JSON result goes to stdout via outputJson().
 */

let jsonMode = false;

/**
 * Enable JSON output mode. Human-readable output will be suppressed.
 */
export function setJsonMode(enabled: boolean): void {
	jsonMode = enabled;
}

/**
 * Check if JSON mode is active.
 */
export function isJsonMode(): boolean {
	return jsonMode;
}

/**
 * Print human-readable output to stdout. Suppressed in JSON mode.
 */
export function log(...args: unknown[]): void {
	if (!jsonMode) {
		console.log(...args);
	}
}

/**
 * Print human-readable error/warning to stderr. Suppressed in JSON mode.
 */
export function logError(...args: unknown[]): void {
	if (!jsonMode) {
		console.error(...args);
	}
}

/**
 * Print final JSON output to stdout. Only call this once per command.
 * This is the ONLY output that should appear when --json is active.
 */
export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}
