import { loadPluginsJson, type PluginPackageJson, readPluginPackageJson } from "@omp/manifest";
import { sanitize } from "@omp/output";
import { resolveScope } from "@omp/paths";
import chalk from "chalk";

/**
 * Simple concurrency limiter for parallel operations.
 * Limits the number of concurrent promises to avoid overwhelming the filesystem.
 */
async function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;

	async function worker(): Promise<void> {
		while (index < items.length) {
			const currentIndex = index++;
			results[currentIndex] = await fn(items[currentIndex]);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

export interface ListOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * Known file categories with their patterns and display info
 */
interface FileCategory {
	pattern: RegExp;
	label: string;
	color: (s: string) => string;
	extractName: (dest: string) => string;
}

const FILE_CATEGORIES: FileCategory[] = [
	{
		pattern: /^agent\/tools\/([^/]+)\//,
		label: "Tools",
		color: chalk.cyan,
		extractName: (dest) => dest.match(/^agent\/tools\/([^/]+)\//)?.[1] || dest,
	},
	{
		pattern: /^agent\/agents\/(.+)\.md$/,
		label: "Agents",
		color: chalk.magenta,
		extractName: (dest) => dest.match(/^agent\/agents\/(.+)\.md$/)?.[1] || dest,
	},
	{
		pattern: /^agent\/commands\/(.+)\.md$/,
		label: "Commands",
		color: chalk.yellow,
		extractName: (dest) => dest.match(/^agent\/commands\/(.+)\.md$/)?.[1] || dest,
	},
	{
		pattern: /^agent\/themes\/(.+)\.json$/,
		label: "Themes",
		color: chalk.green,
		extractName: (dest) => dest.match(/^agent\/themes\/(.+)\.json$/)?.[1] || dest,
	},
	{
		pattern: /^agent\/prompts?\//,
		label: "Prompts",
		color: chalk.blue,
		extractName: (dest) =>
			dest
				.split("/")
				.pop()
				?.replace(/\.[^.]+$/, "") || dest,
	},
	{
		pattern: /^agent\/hooks?\//,
		label: "Hooks",
		color: chalk.red,
		extractName: (dest) =>
			dest
				.split("/")
				.pop()
				?.replace(/\.[^.]+$/, "") || dest,
	},
];

/**
 * Categorize installed files into known categories
 */
function categorizeFiles(files: string[]): {
	categorized: Map<string, string[]>;
	uncategorized: string[];
} {
	const categorized = new Map<string, string[]>();
	const uncategorized: string[] = [];

	for (const file of files) {
		let matched = false;
		for (const category of FILE_CATEGORIES) {
			if (category.pattern.test(file)) {
				const name = category.extractName(file);
				const existing = categorized.get(category.label) || [];
				if (!existing.includes(name)) {
					existing.push(name);
					categorized.set(category.label, existing);
				}
				matched = true;
				break;
			}
		}
		if (!matched) {
			uncategorized.push(file);
		}
	}

	return { categorized, uncategorized };
}

/**
 * Format categorized files for display
 */
function formatContributes(files: string[]): string[] {
	const { categorized, uncategorized } = categorizeFiles(files);
	const lines: string[] = [];

	if (categorized.size > 0 || uncategorized.length > 0) {
		lines.push(`    ${chalk.white("Contributes:")}`);

		for (const category of FILE_CATEGORIES) {
			const items = categorized.get(category.label);
			if (items && items.length > 0) {
				const count = category.color(`${items.length}`);
				const names = items.map((n) => chalk.dim(n)).join(chalk.dim(", "));
				lines.push(`      ${chalk.green("+")} ${category.label} (${count}): ${names}`);
			}
		}

		if (uncategorized.length > 0) {
			const count = chalk.gray(`${uncategorized.length}`);
			const names = uncategorized.map((n) => chalk.dim(n)).join(chalk.dim(", "));
			lines.push(`      ${chalk.green("+")} Files (${count}): ${names}`);
		}
	}

	return lines;
}

/**
 * List all installed plugins
 */
export async function listPlugins(options: ListOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);
	const pluginNames = Object.keys(pluginsJson.plugins);

	if (pluginNames.length === 0) {
		console.log(chalk.yellow("No plugins installed."));
		console.log(chalk.dim("Install one with: omp install <package>"));
		process.exitCode = 1;
		return;
	}

	// Read all package.json files in parallel with concurrency limit
	const CONCURRENCY_LIMIT = 16;
	const pkgJsonMap = new Map<string, PluginPackageJson | null>();
	const pkgJsonResults = await parallelLimit(pluginNames, CONCURRENCY_LIMIT, async (name) => ({
		name,
		pkgJson: await readPluginPackageJson(name, isGlobal),
	}));
	for (const { name, pkgJson } of pkgJsonResults) {
		pkgJsonMap.set(name, pkgJson);
	}

	if (options.json) {
		const plugins: Record<string, unknown> = {};
		for (const name of pluginNames) {
			const pkgJson = pkgJsonMap.get(name);
			const disabled = pluginsJson.disabled?.includes(name) || false;
			plugins[name] = {
				version: pkgJson?.version || pluginsJson.plugins[name],
				description: pkgJson?.description,
				disabled,
				files: pkgJson?.omp?.install?.map((e) => e.dest) || [],
			};
		}
		console.log(JSON.stringify({ plugins }, null, 2));
		return;
	}

	const location = isGlobal ? "~/.pi/plugins" : ".pi";
	console.log(chalk.bold(`Installed plugins (${pluginNames.length}) [${location}]:\n`));

	for (const name of pluginNames.sort()) {
		const pkgJson = pkgJsonMap.get(name);
		const specifier = pluginsJson.plugins[name];
		const isLocal = specifier.startsWith("file:");
		const disabled = pluginsJson.disabled?.includes(name);
		const isMissing = !pkgJson;

		const localBadge = isLocal ? chalk.cyan(" (local)") : "";
		const disabledBadge = disabled ? chalk.yellow(" (disabled)") : "";
		const missingBadge = isMissing ? chalk.red(" (missing)") : "";
		const icon = disabled ? chalk.gray("○") : isMissing ? chalk.red("✗") : chalk.green("◆");

		// Sanitize npm metadata to prevent escape injection
		const safeName = sanitize(name);
		const safeVersion = pkgJson?.version ? chalk.dim(`v${sanitize(pkgJson.version)}`) : chalk.dim(`(${specifier})`);
		console.log(`${icon} ${chalk.bold(safeName)} ${safeVersion}${localBadge}${disabledBadge}${missingBadge}`);

		if (pkgJson?.description) {
			console.log(chalk.dim(`    ${sanitize(pkgJson.description)}`));
		}

		if (isLocal) {
			const localPath = specifier.replace("file:", "");
			console.log(chalk.dim(`    Path: ${localPath}`));
		}

		if (pkgJson?.omp?.install?.length) {
			const files = pkgJson.omp.install.map((e) => e.dest);
			const contributeLines = formatContributes(files);
			for (const line of contributeLines) {
				console.log(line);
			}
		}

		console.log();
	}
}
