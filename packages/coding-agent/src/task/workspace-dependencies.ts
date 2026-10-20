import * as fs from "node:fs/promises";
import * as path from "node:path";

interface WorkspacePackages {
	paths: Map<string, string>;
	bins: Map<string, string>;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = await Bun.file(filePath).json();
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function workspacePatterns(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (value && typeof value === "object" && !Array.isArray(value) && "packages" in value) {
		const packages = (value as { packages?: unknown }).packages;
		return Array.isArray(packages) ? packages.filter((item): item is string => typeof item === "string") : [];
	}
	return [];
}

function packageBins(manifest: Record<string, unknown>, packageRoot: string): Map<string, string> {
	const result = new Map<string, string>();
	const bin = manifest.bin;
	if (typeof bin === "string") {
		const name = typeof manifest.name === "string" ? manifest.name.split("/").at(-1) : undefined;
		if (name) result.set(name, path.resolve(packageRoot, bin));
	} else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
		for (const [name, target] of Object.entries(bin)) {
			if (typeof target === "string") result.set(name, path.resolve(packageRoot, target));
		}
	}
	return result;
}

async function workspacePackages(root: string): Promise<WorkspacePackages> {
	const rootManifest = await readJsonObject(path.join(root, "package.json"));
	const patterns = workspacePatterns(rootManifest?.workspaces);
	try {
		const pnpmWorkspace = Bun.YAML.parse(await Bun.file(path.join(root, "pnpm-workspace.yaml")).text()) as unknown;
		if (pnpmWorkspace && typeof pnpmWorkspace === "object" && !Array.isArray(pnpmWorkspace)) {
			patterns.push(...workspacePatterns((pnpmWorkspace as Record<string, unknown>).packages));
		}
	} catch {
		// package.json workspaces are sufficient when no readable pnpm manifest exists.
	}

	const paths = new Map<string, string>();
	const bins = new Map<string, string>();
	for (const pattern of new Set(patterns)) {
		if (pattern.startsWith("!")) continue;
		const glob = new Bun.Glob(path.join(pattern, "package.json"));
		for await (const match of glob.scan({ cwd: root, onlyFiles: true })) {
			const packageRoot = path.dirname(path.join(root, match));
			const manifest = await readJsonObject(path.join(packageRoot, "package.json"));
			if (!manifest || typeof manifest.name !== "string") continue;
			paths.set(manifest.name, packageRoot);
			for (const [name, target] of packageBins(manifest, packageRoot)) bins.set(name, target);
		}
	}
	return { paths, bins };
}

async function linkPath(target: string, destination: string): Promise<void> {
	const stat = await fs.stat(target).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) {
		// Keep a stale dependency symlink dangling instead of failing all worker startup.
		const linkTarget = await fs.readlink(target).catch(() => undefined);
		if (linkTarget !== undefined) await fs.symlink(path.resolve(path.dirname(target), linkTarget), destination);
		return;
	}
	const type = stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file";
	await fs.symlink(target, destination, type);
}

async function linkPackageEntry(
	name: string,
	sourceEntry: string,
	destination: string,
	packages: ReadonlyMap<string, string>,
): Promise<void> {
	const workspacePath = packages.get(name);
	if (workspacePath) return;
	await linkPath(sourceEntry, destination);
}

async function rebindWorkspaceBins(
	borrowedRoot: string,
	stagingRoot: string,
	bins: ReadonlyMap<string, string>,
): Promise<void> {
	const source = path.join(borrowedRoot, ".bin");
	const destination = path.join(stagingRoot, ".bin");
	await fs.mkdir(destination);
	const entries = await fs.readdir(source).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const workspaceBinNames = new Set(bins.keys());
	for (const entry of entries) {
		const name = entry.replace(/\.(cmd|ps1)$/i, "");
		if (workspaceBinNames.has(name)) continue;
		await linkPath(path.join(source, entry), path.join(destination, entry));
	}
	for (const [name, target] of bins) {
		const launcher = path.join(destination, name);
		if (process.platform === "win32") {
			const relativeTarget = path.relative(destination, target).split(path.sep).join("\\");
			const windowsTarget = relativeTarget.startsWith(".") ? relativeTarget : `.\\${relativeTarget}`;
			await Bun.write(`${launcher}.cmd`, `@"${process.execPath}" "%~dp0${windowsTarget}" %*\r\n`);
			await Bun.write(
				`${launcher}.ps1`,
				`& "${process.execPath}" "$PSScriptRoot\\${relativeTarget}" @args\nexit $LASTEXITCODE\n`,
			);
			continue;
		}
		await linkPath(target, launcher);
	}
}

/**
 * Rebind workspace package links when an isolated checkout inherited a
 * symlink to another checkout's node_modules. Registry packages remain linked
 * to that external cache; workspace packages and their commands resolve to
 * the worker checkout.
 */
export async function repairBorrowedWorkspaceNodeModules(workerRoot: string): Promise<void> {
	const nodeModules = path.join(workerRoot, "node_modules");
	try {
		if (!(await fs.lstat(nodeModules)).isSymbolicLink()) return;
	} catch {
		return;
	}

	let borrowedRoot: string;
	try {
		borrowedRoot = await fs.realpath(nodeModules);
	} catch {
		return;
	}
	const relativeTarget = path.relative(path.resolve(workerRoot), borrowedRoot);
	if (
		relativeTarget === "" ||
		(relativeTarget !== ".." && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget))
	) {
		return;
	}

	const packages = await workspacePackages(workerRoot);
	if (packages.paths.size === 0) return;
	const entries = await fs.readdir(borrowedRoot);
	const stagingRoot = await fs.mkdtemp(path.join(workerRoot, ".omp-node_modules-"));
	try {
		for (const entry of entries) {
			if (entry === ".bin") continue;
			const sourceEntry = path.join(borrowedRoot, entry);
			const destination = path.join(stagingRoot, entry);
			const packageName = entry;
			if (packageName.startsWith("@")) {
				const stat = await fs.stat(sourceEntry).catch(() => undefined);
				if (!stat?.isDirectory()) {
					await linkPath(sourceEntry, destination);
					continue;
				}
				await fs.mkdir(destination);
				for (const member of await fs.readdir(sourceEntry)) {
					await linkPackageEntry(
						`${packageName}/${member}`,
						path.join(sourceEntry, member),
						path.join(destination, member),
						packages.paths,
					);
				}
				continue;
			}
			await linkPackageEntry(packageName, sourceEntry, destination, packages.paths);
		}

		for (const [name, packageRoot] of packages.paths) {
			const destination = path.join(stagingRoot, ...name.split("/"));
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await linkPath(packageRoot, destination);
		}
		await rebindWorkspaceBins(borrowedRoot, stagingRoot, packages.bins);
		await fs.rm(nodeModules);
		await fs.rename(stagingRoot, nodeModules);
	} catch (error) {
		await fs.rm(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}
