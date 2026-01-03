import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config";
import type { InstalledPlugin } from "./types";

const PLUGINS_DIR = join(getAgentDir(), "plugins");

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
	await mkdir(PLUGINS_DIR, { recursive: true });
	await mkdir(join(PLUGINS_DIR, "node_modules"), { recursive: true });
}

export async function installPlugin(packageName: string): Promise<InstalledPlugin> {
	// Validate package name to prevent command injection
	validatePackageName(packageName);

	// Ensure plugins directory exists
	await ensurePluginsDir();

	// Initialize package.json if it doesn't exist
	const pkgJsonPath = join(PLUGINS_DIR, "package.json");
	if (!(await Bun.file(pkgJsonPath).exists())) {
		await Bun.write(pkgJsonPath, JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run npm install in plugins directory
	const proc = Bun.spawn(["npm", "install", packageName], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	const actualName = packageName.replace(/@[^/]+$/, "").replace(/^(@[^/]+\/[^@]+).*$/, "$1");

	// Read the installed package's package.json
	const pkgPath = join(PLUGINS_DIR, "node_modules", actualName, "package.json");
	const pkgFile = Bun.file(pkgPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = await pkgFile.json();

	return {
		name: pkg.name,
		version: pkg.version,
		path: join(PLUGINS_DIR, "node_modules", actualName),
		manifest: pkg.omp || pkg.pi || { version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
}

export async function uninstallPlugin(name: string): Promise<void> {
	// Validate package name
	validatePackageName(name);

	await ensurePluginsDir();

	const proc = Bun.spawn(["npm", "uninstall", name], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pkgJsonPath = join(PLUGINS_DIR, "package.json");
	if (!(await Bun.file(pkgJsonPath).exists())) {
		return [];
	}

	const pkg = await Bun.file(pkgJsonPath).json();
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPkgPath = join(PLUGINS_DIR, "node_modules", name, "package.json");
		if (await Bun.file(pluginPkgPath).exists()) {
			const pluginPkg = await Bun.file(pluginPkgPath).json();
			plugins.push({
				name,
				version: pluginPkg.version,
				path: join(PLUGINS_DIR, "node_modules", name),
				manifest: pluginPkg.omp || pluginPkg.pi || { version: pluginPkg.version },
				enabledFeatures: null,
				enabled: true,
			});
		}
	}

	return plugins;
}

export async function linkPlugin(localPath: string): Promise<void> {
	const cwd = process.cwd();
	const absolutePath = resolve(cwd, localPath);

	// Validate that resolved path is within cwd to prevent path traversal
	const normalizedCwd = resolve(cwd);
	const normalizedPath = resolve(absolutePath);
	if (!normalizedPath.startsWith(`${normalizedCwd}/`) && normalizedPath !== normalizedCwd) {
		throw new Error(`Invalid path: ${localPath} resolves outside working directory`);
	}

	// Validate package.json exists
	const pkgFile = Bun.file(join(absolutePath, "package.json"));
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
	const linkPath = join(PLUGINS_DIR, "node_modules", pkg.name);

	// For scoped packages, ensure the scope directory exists
	if (pkg.name.startsWith("@")) {
		const scopeDir = join(PLUGINS_DIR, "node_modules", pkg.name.split("/")[0]);
		await mkdir(scopeDir, { recursive: true });
	}

	// Remove existing if present
	try {
		const { unlinkSync, lstatSync } = await import("fs");
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink() || stat.isDirectory()) {
			unlinkSync(linkPath);
		}
	} catch {
		// Doesn't exist, that's fine
	}

	// Create symlink using fs instead of shell command
	const { symlinkSync } = await import("fs");
	symlinkSync(absolutePath, linkPath);
}
