import { execFileSync } from "node:child_process";
import type { OmpField } from "@omp/manifest";

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
}

export interface NpmSearchResult {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	date?: string;
	author?: { name: string };
}

/**
 * Execute npm command and return output
 */
export function npmExec(args: string[], cwd?: string): string {
	return execFileSync("npm", args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf-8",
	});
}

/**
 * Execute npm command with prefix (for installing to specific directory)
 */
export function npmExecWithPrefix(args: string[], prefix: string): string {
	return execFileSync("npm", ["--prefix", prefix, ...args], {
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf-8",
	});
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

	npmExecWithPrefix(args, prefix);
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
	} catch {
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
	} catch {
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
	npmExecWithPrefix(args, prefix);
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
