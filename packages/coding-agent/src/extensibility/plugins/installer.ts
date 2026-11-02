import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { readRegularFileText, regularFileExists, withoutByteOrderMark } from "@oh-my-pi/pi-utils/regular-file";
import { runBunCli } from "./bun-cli";
import { linkPluginDirectory } from "./directory-link";
import { extractPackageName } from "./parser";
import type { InstalledPlugin } from "./types";

const PLUGINS_DIR = path.join(getAgentDir(), "plugins");

// Valid npm package name pattern (scoped and unscoped)
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/**
 * Validate package name to prevent command injection
 */
function validatePackageName(name: string): void {
	if (!VALID_PACKAGE_NAME.test(name)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

/**
 * Ensure the plugins directory exists
 */
async function ensurePluginsDir(): Promise<void> {
	await fs.mkdir(PLUGINS_DIR, { recursive: true });
	await fs.mkdir(path.join(PLUGINS_DIR, "node_modules"), { recursive: true });
}

export async function installPlugin(packageName: string): Promise<InstalledPlugin> {
	// Validate package name to prevent command injection
	validatePackageName(packageName);

	// Ensure plugins directory exists
	await ensurePluginsDir();

	// Initialize package.json if it doesn't exist. `bun install` reads it next,
	// so anything other than a regular file there is refused before it runs.
	const pkgJsonPath = path.join(PLUGINS_DIR, "package.json");
	if (!(await regularFileExists(pkgJsonPath))) {
		await Bun.write(pkgJsonPath, JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run npm install in plugins directory
	const { exitCode, stderr } = await runBunCli(["install", packageName], PLUGINS_DIR);
	if (exitCode !== 0) {
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	const actualName = extractPackageName(packageName);

	// Read the installed package's package.json
	const pkgPath = path.join(PLUGINS_DIR, "node_modules", actualName, "package.json");
	const pkgText = await readRegularFileText(pkgPath);
	if (pkgText === undefined) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = JSON.parse(withoutByteOrderMark(pkgText));

	return {
		name: pkg.name,
		version: pkg.version,
		path: path.join(PLUGINS_DIR, "node_modules", actualName),
		manifest: pkg.omp || pkg.pi || { version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
}

export async function uninstallPlugin(name: string): Promise<void> {
	// Validate package name
	validatePackageName(name);

	await ensurePluginsDir();

	const { exitCode } = await runBunCli(["uninstall", name], PLUGINS_DIR);
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pkgText = await readRegularFileText(path.join(PLUGINS_DIR, "package.json"));
	if (pkgText === undefined) {
		return [];
	}

	const pkg = JSON.parse(withoutByteOrderMark(pkgText));
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPath = path.join(PLUGINS_DIR, "node_modules", name);
		const pluginPkgText = await readRegularFileText(path.join(pluginPath, "package.json"));
		if (pluginPkgText !== undefined) {
			const pkg = JSON.parse(withoutByteOrderMark(pluginPkgText));
			plugins.push({
				name,
				version: pkg.version,
				path: pluginPath,
				manifest: pkg.omp || pkg.pi || { version: pkg.version },
				enabledFeatures: null,
				enabled: true,
			});
		}
	}

	return plugins;
}

export async function linkPlugin(localPath: string): Promise<void> {
	const cwd = getProjectDir();
	const absolutePath = path.resolve(cwd, localPath);

	// Validate that resolved path is within cwd to prevent path traversal
	const normalizedCwd = path.resolve(cwd);
	const normalizedPath = path.resolve(absolutePath);
	if (!normalizedPath.startsWith(`${normalizedCwd}/`) && normalizedPath !== normalizedCwd) {
		throw new Error(`Invalid path: ${localPath} resolves outside working directory`);
	}

	let pkg: { name?: string } | undefined;
	try {
		const text = await readRegularFileText(path.join(absolutePath, "package.json"));
		pkg = text === undefined ? undefined : JSON.parse(withoutByteOrderMark(text));
	} catch (err) {
		throw new Error(`Invalid package.json at ${absolutePath}: ${err}`);
	}

	// Validate package.json exists
	if (pkg === undefined) {
		throw new Error(`package.json not found at ${absolutePath}`);
	}

	if (!pkg.name || typeof pkg.name !== "string") {
		throw new Error("package.json must have a valid name field");
	}

	// Validate package name to prevent path traversal via pkg.name
	if (pkg.name.includes("..") || pkg.name.includes("/") || pkg.name.includes("\\")) {
		// Exception: scoped packages have one slash
		if (!pkg.name.startsWith("@") || (pkg.name.match(/\//g) || []).length !== 1) {
			throw new Error(`Invalid package name in package.json: ${pkg.name}`);
		}
	}

	await ensurePluginsDir();

	// Create symlink in plugins/node_modules
	const linkPath = path.join(PLUGINS_DIR, "node_modules", pkg.name);

	// For scoped packages, ensure the scope directory exists
	if (pkg.name.startsWith("@")) {
		const scopeDir = path.join(PLUGINS_DIR, "node_modules", pkg.name.split("/")[0]);
		await fs.mkdir(scopeDir, { recursive: true });
	}

	// Whatever is there — a stale link, or a real directory from a git install.
	await fs.rm(linkPath, { recursive: true, force: true });

	await linkPluginDirectory(absolutePath, linkPath);
}
