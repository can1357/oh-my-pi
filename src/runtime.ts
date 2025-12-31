import type { OmpVariable, PluginPackageJson } from "@omp/manifest";
import { loadPluginsJson, readPluginPackageJson } from "@omp/manifest";

/**
 * Collect all variables from a plugin (top-level + enabled features)
 */
function collectVariables(pkgJson: PluginPackageJson, enabledFeatures: string[]): Record<string, OmpVariable> {
	const vars: Record<string, OmpVariable> = {};

	// Top-level variables
	if (pkgJson.omp?.variables) {
		Object.assign(vars, pkgJson.omp.variables);
	}

	// Variables from enabled features
	if (pkgJson.omp?.features) {
		for (const fname of enabledFeatures) {
			const feature = pkgJson.omp.features[fname];
			if (feature?.variables) {
				Object.assign(vars, feature.variables);
			}
		}
	}

	return vars;
}

/**
 * Resolve which features are currently enabled
 *
 * - null/undefined: use plugin defaults (features with default !== false)
 * - ["*"]: explicitly all features
 * - []: no optional features
 * - ["f1", "f2"]: specific features
 */
function resolveEnabledFeatures(
	allFeatureNames: string[],
	storedFeatures: string[] | null | undefined,
	pluginFeatures: Record<string, { default?: boolean }>,
): string[] {
	// Explicit "all features" request
	if (Array.isArray(storedFeatures) && storedFeatures.includes("*")) return allFeatureNames;
	// Explicit feature list (including empty array = no features)
	if (Array.isArray(storedFeatures)) return storedFeatures;
	// null/undefined = use defaults
	return Object.entries(pluginFeatures)
		.filter(([_, f]) => f.default !== false)
		.map(([name]) => name);
}

/**
 * Get all environment variables for enabled plugins
 */
export async function getPluginEnvVars(global = true): Promise<Record<string, string>> {
	const pluginsJson = await loadPluginsJson(global);
	const env: Record<string, string> = {};

	for (const pluginName of Object.keys(pluginsJson.plugins)) {
		// Skip disabled plugins
		if (pluginsJson.disabled?.includes(pluginName)) continue;

		const pkgJson = await readPluginPackageJson(pluginName, global);
		if (!pkgJson?.omp) continue;

		const config = pluginsJson.config?.[pluginName];
		const allFeatureNames = Object.keys(pkgJson.omp.features || {});
		const enabledFeatures = resolveEnabledFeatures(allFeatureNames, config?.features, pkgJson.omp.features || {});

		// Collect variables from top-level and enabled features
		const variables = collectVariables(pkgJson, enabledFeatures);

		for (const [key, varDef] of Object.entries(variables)) {
			if (varDef.env) {
				const value = config?.variables?.[key] ?? varDef.default;
				if (value !== undefined) {
					env[varDef.env] = String(value);
				}
			}
		}
	}

	return env;
}

/**
 * Generate shell export statements
 * omp env > ~/.pi/env.sh && source ~/.pi/env.sh
 */
export async function generateEnvScript(global = true, shell: "sh" | "fish" = "sh"): Promise<string> {
	const vars = await getPluginEnvVars(global);

	if (shell === "fish") {
		return Object.entries(vars)
			.map(([k, v]) => `set -gx ${k} ${JSON.stringify(v)}`)
			.join("\n");
	}

	// POSIX sh/bash/zsh
	return Object.entries(vars)
		.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
		.join("\n");
}

/**
 * Get environment variables as a JSON object for programmatic use
 */
export async function getEnvJson(global = true): Promise<Record<string, string>> {
	return getPluginEnvVars(global);
}
