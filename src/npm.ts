import { execFileSync } from "node:child_process";
import type { OmpField } from "@omp/manifest";
import { createProgress } from "@omp/progress";
import chalk from "chalk";

export interface NpmAvailability {
	available: boolean;
	version?: string;
	error?: string;
}

/**
 * Check npm availability and version
 */
export function checkNpmAvailable(): NpmAvailability {
	try {
		const version = execFileSync("npm", ["--version"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// Parse version and check minimum (npm 7+)
		const major = parseInt(version.split(".")[0], 10);
		if (major < 7) {
			return {
				available: false,
				version,
				error: `npm version ${version} is too old. Please upgrade to npm 7 or later.`,
			};
		}

		return { available: true, version };
	} catch {
		return {
			available: false,
			error: "npm is not installed or not in PATH. Please install Node.js/npm.",
		};
	}
}

/**
 * Require npm to be available; throws if not.
 * Use this at the start of commands that need npm.
 */
export function requireNpm(): void {
	const check = checkNpmAvailable();
	if (!check.available) {
		throw new Error(check.error);
	}
}

export interface NpmPackageDist {
	tarball: string;
	integrity?: string;
	shasum?: string;
}

export interface NpmPackageInfo {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	author?: string | { name: string; email?: string };
	homepage?: string;
	repository?: { type: string; url: string } | string;
	versions?: string[];
	"dist-tags"?: Record<string, string>;
	omp?: OmpField;
	dependencies?: Record<string, string>;
	dist?: NpmPackageDist;
}

export interface NpmSearchResult {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	date?: string;
	author?: { name: string };
}

const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Execute npm command and return output
 */
export function npmExec(args: string[], cwd?: string, timeout = DEFAULT_TIMEOUT_MS): string {
	try {
		return execFileSync("npm", args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			encoding: "utf-8",
			timeout,
		});
	} catch (err) {
		const error = err as { killed?: boolean; code?: string; message: string };
		if (error.killed || error.code === "ETIMEDOUT") {
			throw new Error(`npm operation timed out after ${timeout / 1000} seconds`);
		}
		throw err;
	}
}

/**
 * Execute npm command with prefix (for installing to specific directory)
 */
export function npmExecWithPrefix(args: string[], prefix: string, timeout = DEFAULT_TIMEOUT_MS): string {
	try {
		return execFileSync("npm", ["--prefix", prefix, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			encoding: "utf-8",
			timeout,
		});
	} catch (err) {
		const error = err as { killed?: boolean; code?: string; message: string };
		if (error.killed || error.code === "ETIMEDOUT") {
			throw new Error(`npm operation timed out after ${timeout / 1000} seconds`);
		}
		throw err;
	}
}

/**
 * Install packages using npm
 */
export async function npmInstall(
	packages: string[],
	prefix: string,
	options: { save?: boolean; saveDev?: boolean } = {},
): Promise<void> {
	const args = ["install"];

	if (options.save) {
		args.push("--save");
	} else if (options.saveDev) {
		args.push("--save-dev");
	}

	args.push(...packages);

	const pkgList = packages.length === 1 ? packages[0] : `${packages.length} packages`;
	const progress = createProgress(`Installing ${pkgList}...`);

	try {
		npmExecWithPrefix(args, prefix);
		progress.succeed(`Installed ${pkgList} (${progress.elapsed()}s)`);
	} catch (err) {
		progress.fail(`Failed to install ${pkgList}`);
		throw err;
	}
}

/**
 * Uninstall packages using npm
 */
export async function npmUninstall(packages: string[], prefix: string): Promise<void> {
	npmExecWithPrefix(["uninstall", ...packages], prefix);
}

/**
 * Get package info from npm registry
 */
export async function npmInfo(packageName: string): Promise<NpmPackageInfo | null> {
	try {
		const output = npmExec(["info", packageName, "--json"]);
		return JSON.parse(output);
	} catch (err) {
		const error = err as Error;
		console.warn(chalk.yellow(`⚠ Failed to fetch npm info for '${packageName}': ${error.message}`));
		if (process.env.DEBUG) {
			console.warn(chalk.dim(error.stack));
		}
		return null;
	}
}

/**
 * Search npm for packages with a keyword
 */
export async function npmSearch(query: string, keyword = "omp-plugin"): Promise<NpmSearchResult[]> {
	try {
		// Search for packages with the omp-plugin keyword
		const searchTerm = keyword ? `keywords:${keyword} ${query}` : query;
		const output = npmExec(["search", searchTerm, "--json"]);
		return JSON.parse(output);
	} catch (err) {
		const error = err as Error;
		console.warn(chalk.yellow(`⚠ npm search failed for '${query}': ${error.message}`));
		if (process.env.DEBUG) {
			console.warn(chalk.dim(error.stack));
		}
		return [];
	}
}

/**
 * Check for outdated packages
 */
export async function npmOutdated(
	prefix: string,
): Promise<Record<string, { current: string; wanted: string; latest: string }>> {
	try {
		const output = npmExecWithPrefix(["outdated", "--json"], prefix);
		return JSON.parse(output);
	} catch (err) {
		// npm outdated exits with code 1 if there are outdated packages
		const error = err as { stdout?: string };
		if (error.stdout) {
			try {
				return JSON.parse(error.stdout);
			} catch {
				return {};
			}
		}
		return {};
	}
}

/**
 * Update packages using npm
 */
export async function npmUpdate(packages: string[], prefix: string): Promise<void> {
	const args = ["update"];
	if (packages.length > 0) {
		args.push(...packages);
	}

	const pkgList =
		packages.length === 0 ? "all packages" : packages.length === 1 ? packages[0] : `${packages.length} packages`;
	const progress = createProgress(`Updating ${pkgList}...`);

	try {
		npmExecWithPrefix(args, prefix);
		progress.succeed(`Updated ${pkgList} (${progress.elapsed()}s)`);
	} catch (err) {
		progress.fail(`Failed to update ${pkgList}`);
		throw err;
	}
}

/**
 * Get list of installed packages
 */
export async function npmList(prefix: string): Promise<Record<string, { version: string }>> {
	try {
		const output = npmExecWithPrefix(["list", "--json", "--depth=0"], prefix);
		const parsed = JSON.parse(output);
		return parsed.dependencies || {};
	} catch {
		return {};
	}
}

/**
 * Resolve a package version from the registry
 */
export async function resolveVersion(packageName: string, versionRange = "latest"): Promise<string | null> {
	const info = await npmInfo(`${packageName}@${versionRange}`);
	return info?.version || null;
}
