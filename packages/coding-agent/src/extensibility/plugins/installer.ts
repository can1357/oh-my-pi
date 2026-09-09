import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
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

	// Initialize package.json if it doesn't exist
	const pkgJsonPath = path.join(PLUGINS_DIR, "package.json");
	const pkgJson = Bun.file(pkgJsonPath);
	if (!(await pkgJson.exists())) {
		await pkgJson.write(JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run npm install in plugins directory
	const proc = Bun.spawn(["bun", "install", packageName], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	// Drain both pipes concurrently with proc.exited to avoid a pipe-buffer
	// deadlock if bun install floods stdout/stderr.
	const [exitCode, , stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	const actualName = extractPackageName(packageName);

	// Read the installed package's package.json
	const pkgPath = path.join(PLUGINS_DIR, "node_modules", actualName, "package.json");
	const pkgFile = Bun.file(pkgPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = await pkgFile.json();

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

	const proc = Bun.spawn(["bun", "uninstall", name], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const [exitCode] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pkgJsonPath = Bun.file(path.join(PLUGINS_DIR, "package.json"));
	if (!(await pkgJsonPath.exists())) {
		return [];
	}

	const pkg = await pkgJsonPath.json();
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPath = path.join(PLUGINS_DIR, "node_modules", name);
		const fpkg = Bun.file(path.join(pluginPath, "package.json"));
		if (await fpkg.exists()) {
			const pkg = await fpkg.json();
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

	// Validate package.json exists
	const pkgFile = Bun.file(path.join(absolutePath, "package.json"));
	if (!(await pkgFile.exists())) {
		throw new Error(`package.json not found at ${absolutePath}`);
	}

	let pkg: { name?: string };
	try {
		pkg = await pkgFile.json();
	} catch (err) {
		throw new Error(`Invalid package.json at ${absolutePath}: ${err}`);
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

	// Remove existing if present
	try {
		const stats = await fs.lstat(linkPath);
		if (stats.isSymbolicLink() || stats.isDirectory()) {
			await fs.unlink(linkPath);
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// Create symlink using fs instead of shell command
	await fs.symlink(absolutePath, linkPath);
}
