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
 *   - "omp/slow" or "pi/slow" → configured slow model from settings
 */

import { type Settings, settingsCapability } from "../../../capability/settings";
import { loadCapability } from "../../../discovery";
import { resolveOmpCommand } from "./omp-command";

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
		const ompCommand = resolveOmpCommand();
		const result = Bun.spawnSync([ompCommand.cmd, ...ompCommand.args, "--list-models"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		if (result.exitCode !== 0 || !result.stdout) {
			cachedModels = [];
			cacheExpiry = now + CACHE_TTL_MS;
			return cachedModels;
		}

		// Parse output: skip header line, extract provider/model
		const lines = result.stdout.toString().trim().split("\n");
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

/**
 * Load model roles from settings files using capability API.
 */
async function loadModelRoles(): Promise<Record<string, string>> {
	const result = await loadCapability<Settings>(settingsCapability.id, { cwd: process.cwd() });

	// Merge all settings, prioritizing first (highest priority)
	let modelRoles: Record<string, string> = {};
	for (const settings of result.items.reverse()) {
		const roles = settings.data.modelRoles as Record<string, string> | undefined;
		if (roles) {
			modelRoles = { ...modelRoles, ...roles };
		}
	}

	return modelRoles;
}

/**
 * Resolve an omp/<role> alias to a model string.
 * Looks up the role in settings.modelRoles and returns the configured model.
 * Returns undefined if the role isn't configured.
 */
async function resolveOmpAlias(role: string, availableModels: string[]): Promise<string | undefined> {
	const roles = await loadModelRoles();

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
 * Extract provider from "provider/modelId" format.
 * Returns undefined if no provider prefix.
 */
function getProvider(fullModel: string): string | undefined {
	const slashIdx = fullModel.indexOf("/");
	return slashIdx > 0 ? fullModel.slice(0, slashIdx) : undefined;
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
export async function resolveModelPattern(
	pattern: string | undefined,
	availableModels?: string[],
): Promise<string | undefined> {
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
		// Handle omp/<role> or pi/<role> aliases - looks up role in settings.modelRoles
		const lower = p.toLowerCase();
		if (lower.startsWith("omp/") || lower.startsWith("pi/")) {
			const role = lower.startsWith("omp/") ? p.slice(4) : p.slice(3);
			const resolved = await resolveOmpAlias(role, models);
			if (resolved) return resolved;
			continue; // Role not configured, try next pattern
		}

		// Try exact match on full provider/modelId
		const exactFull = models.find((m) => m.toLowerCase() === p.toLowerCase());
		if (exactFull) return exactFull;

		// Try exact match on model ID only
		const exactId = models.find((m) => getModelId(m).toLowerCase() === p.toLowerCase());
		if (exactId) return exactId;

		// Check if pattern has provider prefix (e.g., "zai/glm-4.7")
		const patternProvider = getProvider(p);
		const patternModelId = getModelId(p);

		// If pattern has provider prefix, fuzzy match must stay within that provider
		// (don't cross provider boundaries when user explicitly specifies provider)
		if (patternProvider) {
			const providerFuzzyMatch = models.find(
				(m) =>
					getProvider(m)?.toLowerCase() === patternProvider.toLowerCase() &&
					getModelId(m).toLowerCase().includes(patternModelId.toLowerCase()),
			);
			if (providerFuzzyMatch) return providerFuzzyMatch;
			// No match in specified provider - don't fall through to other providers
			continue;
		}

		// No provider prefix - fall back to general fuzzy match on model ID (substring)
		const fuzzyMatch = models.find((m) => getModelId(m).toLowerCase().includes(patternModelId.toLowerCase()));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// No match found - use default model
	return undefined;
}
