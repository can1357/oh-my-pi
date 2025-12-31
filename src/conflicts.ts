import type { PluginPackageJson } from "@omp/manifest";

export interface Conflict {
	dest: string;
	plugins: Array<{ name: string; src: string }>;
}

export interface IntraPluginDuplicate {
	dest: string;
	sources: string[];
}

/**
 * Detect duplicate destinations within a single plugin's omp.install array
 */
export function detectIntraPluginDuplicates(pkgJson: PluginPackageJson): IntraPluginDuplicate[] {
	const duplicates: IntraPluginDuplicate[] = [];

	if (!pkgJson.omp?.install?.length) {
		return duplicates;
	}

	const destMap = new Map<string, string[]>();

	for (const entry of pkgJson.omp.install) {
		const sources = destMap.get(entry.dest) || [];
		sources.push(entry.src);
		destMap.set(entry.dest, sources);
	}

	for (const [dest, sources] of destMap) {
		if (sources.length > 1) {
			duplicates.push({ dest, sources });
		}
	}

	return duplicates;
}

/**
 * Detect conflicts between a new plugin and existing plugins
 */
export function detectConflicts(
	newPluginName: string,
	newPkgJson: PluginPackageJson,
	existingPlugins: Map<string, PluginPackageJson>,
): Conflict[] {
	const conflicts: Conflict[] = [];

	if (!newPkgJson.omp?.install?.length) {
		return conflicts;
	}

	// Build a map of existing destinations
	const destMap = new Map<string, Array<{ name: string; src: string }>>();

	for (const [name, pkgJson] of existingPlugins) {
		if (pkgJson.omp?.install) {
			for (const entry of pkgJson.omp.install) {
				const existing = destMap.get(entry.dest) || [];
				existing.push({ name, src: entry.src });
				destMap.set(entry.dest, existing);
			}
		}
	}

	// Check new plugin's destinations
	for (const entry of newPkgJson.omp.install) {
		const existing = destMap.get(entry.dest);
		if (existing && existing.length > 0) {
			conflicts.push({
				dest: entry.dest,
				plugins: [...existing, { name: newPluginName, src: entry.src }],
			});
		}
	}

	return conflicts;
}

/**
 * Detect all conflicts among a set of plugins
 */
export function detectAllConflicts(plugins: Map<string, PluginPackageJson>): Conflict[] {
	const conflicts: Conflict[] = [];
	const destMap = new Map<string, Array<{ name: string; src: string }>>();

	for (const [name, pkgJson] of plugins) {
		if (pkgJson.omp?.install) {
			for (const entry of pkgJson.omp.install) {
				const existing = destMap.get(entry.dest) || [];
				existing.push({ name, src: entry.src });
				destMap.set(entry.dest, existing);
			}
		}
	}

	// Find destinations with multiple sources
	for (const [dest, sources] of destMap) {
		if (sources.length > 1) {
			conflicts.push({ dest, plugins: sources });
		}
	}

	return conflicts;
}

/**
 * Format conflicts for display
 */
export function formatConflicts(conflicts: Conflict[]): string[] {
	return conflicts.map((conflict) => {
		const plugins = conflict.plugins.map((p) => p.name).join(" and ");
		return `${plugins} both install ${conflict.dest}`;
	});
}
