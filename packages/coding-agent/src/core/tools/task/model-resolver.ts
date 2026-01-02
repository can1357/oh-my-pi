/**
 * Model resolution with fuzzy pattern matching.
 *
 * Supports:
 *   - Exact match: "claude-opus-4-5"
 *   - Fuzzy match: "opus" → "claude-opus-4-5"
 *   - Comma fallback: "gpt, opus" → tries gpt first, then opus
 *   - "default" → undefined (use system default)
 */

import { spawnSync } from "node:child_process";

/** pi command: 'pi.cmd' on Windows, 'pi' elsewhere */
const PI_CMD = process.platform === "win32" ? "pi.cmd" : "pi";

/** Windows shell option for spawn/spawnSync */
const PI_SHELL_OPT = process.platform === "win32";

/** Cache for available models */
let cachedModels: string[] | null = null;

/** Cache expiry time (5 minutes) */
let cacheExpiry = 0;

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get available models from `pi --list-models`.
 * Caches the result for performance.
 */
export function getAvailableModels(): string[] {
	const now = Date.now();
	if (cachedModels !== null && now < cacheExpiry) {
		return cachedModels;
	}

	try {
		const result = spawnSync(PI_CMD, ["--list-models"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: PI_SHELL_OPT,
		});

		if (result.status !== 0 || !result.stdout) {
			cachedModels = [];
			cacheExpiry = now + CACHE_TTL_MS;
			return cachedModels;
		}

		// Parse output: skip header line, extract model column
		const lines = result.stdout.trim().split("\n");
		cachedModels = lines
			.slice(1) // Skip header
			.map((line) => {
				const parts = line.trim().split(/\s+/);
				return parts[1]; // Model name is second column
			})
			.filter(Boolean);

		cacheExpiry = now + CACHE_TTL_MS;
		return cachedModels;
	} catch {
		cachedModels = [];
		cacheExpiry = now + CACHE_TTL_MS;
		return cachedModels;
	}
}

/**
 * Clear the model cache (for testing).
 */
export function clearModelCache(): void {
	cachedModels = null;
	cacheExpiry = 0;
}

/**
 * Resolve a fuzzy model pattern to an actual model name.
 *
 * Supports comma-separated patterns (e.g., "gpt, opus") - tries each in order.
 * Returns undefined if pattern is "default", undefined, or no match found.
 *
 * @param pattern - Model pattern to resolve
 * @param availableModels - Optional pre-fetched list of available models
 */
export function resolveModelPattern(pattern: string | undefined, availableModels?: string[]): string | undefined {
	if (!pattern || pattern === "default") {
		return undefined;
	}

	const models = availableModels ?? getAvailableModels();
	if (models.length === 0) {
		// Fallback: return pattern as-is if we can't get available models
		return pattern;
	}

	// Split by comma, try each pattern in order
	const patterns = pattern
		.split(",")
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);

	for (const p of patterns) {
		// Try exact match first
		const exactMatch = models.find((m) => m.toLowerCase() === p);
		if (exactMatch) return exactMatch;

		// Try fuzzy match (substring)
		const fuzzyMatch = models.find((m) => m.toLowerCase().includes(p));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// No match found - use default model
	return undefined;
}
