/**
 * Model resolution with fuzzy pattern matching.
 *
 * Returns models in "provider/modelId" format for use with --model flag.
 *
 * Supports:
 *   - Exact match: "gpt-5.2" → "p-openai/gpt-5.2"
 *   - Fuzzy match: "opus" → "p-anthropic/claude-opus-4-5"
 *   - Comma fallback: "gpt, opus" → tries gpt first, then opus
 *   - "default" → undefined (use system default)
 *   - "omp/slow" → configured slow model from settings
 */

import { spawnSync } from "node:child_process";
import { readConfigFile } from "../../../config";

/** omp command: 'omp.cmd' on Windows, 'omp' elsewhere */
const OMP_CMD = process.platform === "win32" ? "omp.cmd" : "omp";

/** Windows shell option for spawn/spawnSync */
const OMP_SHELL_OPT = process.platform === "win32";

/** Cache for available models (provider/modelId format) */
let cachedModels: string[] | null = null;

/** Cache expiry time (5 minutes) */
let cacheExpiry = 0;

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get available models from `omp --list-models`.
 * Returns models in "provider/modelId" format.
 * Caches the result for performance.
 */
export function getAvailableModels(): string[] {
	const now = Date.now();
	if (cachedModels !== null && now < cacheExpiry) {
		return cachedModels;
	}

	try {
		const result = spawnSync(OMP_CMD, ["--list-models"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: OMP_SHELL_OPT,
		});

		if (result.status !== 0 || !result.stdout) {
			cachedModels = [];
			cacheExpiry = now + CACHE_TTL_MS;
			return cachedModels;
		}

		// Parse output: skip header line, extract provider/model
		const lines = result.stdout.trim().split("\n");
		cachedModels = lines
			.slice(1) // Skip header
			.map((line) => {
				const parts = line.trim().split(/\s+/);
				// Format: provider/modelId
				return parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : "";
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

interface SettingsWithRoles {
	modelRoles?: Record<string, string>;
}

/**
 * Load model roles from settings file (checks .omp first, then .pi fallback).
 */
function loadModelRoles(): Record<string, string> {
	const result = readConfigFile<SettingsWithRoles>("settings.json", { project: false });
	return result?.content.modelRoles ?? {};
}

/**
 * Resolve an omp/<role> alias to a model string.
 * Looks up the role in settings.modelRoles and returns the configured model.
 * Returns undefined if the role isn't configured.
 */
function resolveOmpAlias(role: string, availableModels: string[]): string | undefined {
	const roles = loadModelRoles();

	// Look up role in settings (case-insensitive)
	const configured = roles[role] || roles[role.toLowerCase()];
	if (!configured) return undefined;

	// configured is in "provider/modelId" format, find in available models
	return availableModels.find((m) => m.toLowerCase() === configured.toLowerCase());
}

/**
 * Extract model ID from "provider/modelId" format.
 */
function getModelId(fullModel: string): string {
	const slashIdx = fullModel.indexOf("/");
	return slashIdx > 0 ? fullModel.slice(slashIdx + 1) : fullModel;
}

/**
 * Resolve a fuzzy model pattern to "provider/modelId" format.
 *
 * Supports comma-separated patterns (e.g., "gpt, opus") - tries each in order.
 * Returns undefined if pattern is "default", undefined, or no match found.
 *
 * @param pattern - Model pattern to resolve
 * @param availableModels - Optional pre-fetched list of available models (in provider/modelId format)
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
		.map((p) => p.trim())
		.filter(Boolean);

	for (const p of patterns) {
		// Handle omp/<role> aliases - looks up role in settings.modelRoles
		if (p.toLowerCase().startsWith("omp/")) {
			const role = p.slice(4); // Remove "omp/" prefix
			const resolved = resolveOmpAlias(role, models);
			if (resolved) return resolved;
			continue; // Role not configured, try next pattern
		}

		// Try exact match on full provider/modelId
		const exactFull = models.find((m) => m.toLowerCase() === p.toLowerCase());
		if (exactFull) return exactFull;

		// Try exact match on model ID only
		const exactId = models.find((m) => getModelId(m).toLowerCase() === p.toLowerCase());
		if (exactId) return exactId;

		// Try fuzzy match on model ID (substring)
		const fuzzyMatch = models.find((m) => getModelId(m).toLowerCase().includes(p.toLowerCase()));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// No match found - use default model
	return undefined;
}
