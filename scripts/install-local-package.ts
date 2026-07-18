#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { generateNpmPackages } from "../packages/natives/scripts/gen-npm-packages";
import { applyPublishBin, prepareNativeCorePackage } from "./ci-release-publish";

const repoRoot = path.resolve(import.meta.dir, "..");
const codingAgentPackageDir = path.join(repoRoot, "packages", "coding-agent");
const nativesPackageDir = path.join(repoRoot, "packages", "natives");
const launcherMarker = "OMP_LOCAL_PACKAGE_LAUNCHER";

const workspacePackageDirs = [
	"packages/utils",
	"packages/wire",
	"packages/omptype",
	"packages/catalog",
	"packages/ai",
	"packages/mnemopi",
	"packages/snapcompact",
	"packages/agent",
	"packages/tui",
	"packages/stats",
	"packages/collab-web",
] as const;

export interface LocalPackageInstallerOptions {
	installDir: string;
	binDir: string;
	rebuildNative?: boolean;
}

export interface LocalPackageLauncherOptions {
	installDir: string;
	binDir: string;
	bunPath?: string;
	launchDir?: string;
	platform?: NodeJS.Platform;
}

export interface LocalPackageLauncherResult {
	launcherPath: string;
	preservedLaunchers: string[];
}

export interface LocalPackageInstallResult {
	installDir: string;
	tarballDir: string;
	launcherPath: string;
	preservedLaunchers: string[];
}

interface LauncherBackup {
	source: string;
	backup: string;
	preserve: boolean;
}

function localDataDir(platform = process.platform): string {
	if (platform === "win32") {
		return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
	}
	return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

async function defaultBinDir(): Promise<string> {
	const result = await $`bun pm -g bin`.quiet().nothrow();
	const globalBin = result.exitCode === 0 ? result.text().trim() : "";
	if (globalBin) return globalBin;

	return path.join(process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "bin");
}

function createWindowsLauncher(bunPath: string, preloadPath: string, cliPath: string, launchDir: string): string {
	return [
		"@echo off",
		`rem ${launcherMarker}`,
		"setlocal",
		'set "OMP_LAUNCH_CWD=%CD%"',
		`set "LAUNCH_DIR=${launchDir}"`,
		'if not exist "%LAUNCH_DIR%" mkdir "%LAUNCH_DIR%"',
		'cd /d "%LAUNCH_DIR%"',
		`"${bunPath}" --preload "${preloadPath}" "${cliPath}" %*`,
		'set "OMP_EXIT_CODE=%ERRORLEVEL%"',
		"endlocal & exit /b %OMP_EXIT_CODE%",
		"",
	].join("\r\n");
}

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function createPosixLauncher(bunPath: string, preloadPath: string, cliPath: string, launchDir: string): string {
	return [
		"#!/bin/sh",
		`# ${launcherMarker}`,
		"set -e",
		"OMP_LAUNCH_CWD=$PWD",
		"export OMP_LAUNCH_CWD",
		`launch_dir=${quotePosix(launchDir)}`,
		'mkdir -p "$launch_dir"',
		'cd "$launch_dir"',
		`exec ${quotePosix(bunPath)} --preload ${quotePosix(preloadPath)} ${quotePosix(cliPath)} "$@"`,
		"",
	].join("\n");
}

async function isManagedLauncher(filePath: string): Promise<boolean> {
	try {
		return (await Bun.file(filePath).text()).includes(launcherMarker);
	} catch {
		return false;
	}
}

async function restoreLaunchers(backups: readonly LauncherBackup[], launcherPath: string): Promise<void> {
	await fs.rm(launcherPath, { force: true });
	for (const backup of [...backups].reverse()) {
		await fs.rename(backup.backup, backup.source);
	}
}

/**
 * Replaces the globally discoverable launcher while preserving an existing
 * source link or binary under a timestamped name. The new launcher only points
 * at the installed package directory, never the working tree.
 */
export async function writeLocalPackageLauncher(
	options: LocalPackageLauncherOptions,
): Promise<LocalPackageLauncherResult> {
	const platform = options.platform ?? process.platform;
	const binDir = path.resolve(options.binDir);
	const installDir = path.resolve(options.installDir);
	const bundledBunPath = path.join(binDir, platform === "win32" ? "bun.exe" : "bun");
	const bunPath =
		options.bunPath ??
		((await Bun.file(bundledBunPath).exists()) ? bundledBunPath : (Bun.which("bun") ?? process.execPath));
	const launchDir =
		options.launchDir ??
		(process.env.OMP_LOCAL_PACKAGE_LAUNCH_DIR
			? path.resolve(process.env.OMP_LOCAL_PACKAGE_LAUNCH_DIR)
			: path.join(localDataDir(platform), "omp", ".package-cwd"));
	const launcherName = platform === "win32" ? "omp.cmd" : "omp";
	const launcherPath = path.join(binDir, launcherName);
	const candidates = platform === "win32" ? ["omp.cmd", "omp.exe"] : ["omp"];
	const backupToken = `${Date.now()}-${process.pid}`;
	const backups: LauncherBackup[] = [];

	await fs.mkdir(binDir, { recursive: true });
	for (const candidate of candidates) {
		const source = path.join(binDir, candidate);
		if (!(await Bun.file(source).exists())) continue;

		const preserve = source !== launcherPath || !(await isManagedLauncher(source));
		const backup = `${source}.${preserve ? "before" : "staging"}-local-package-${backupToken}`;
		await fs.rename(source, backup);
		backups.push({ source, backup, preserve });
	}

	const packageDir = path.join(installDir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	const preloadPath = path.join(packageDir, "scripts", "omp.ts");
	const cliPath = path.join(packageDir, "dist", "cli.js");
	const content =
		platform === "win32"
			? createWindowsLauncher(bunPath, preloadPath, cliPath, launchDir)
			: createPosixLauncher(bunPath, preloadPath, cliPath, launchDir);

	try {
		await Bun.write(launcherPath, content);
		if (platform !== "win32") await fs.chmod(launcherPath, 0o755);
	} catch (error) {
		await restoreLaunchers(backups, launcherPath);
		throw error;
	}

	await Promise.all(backups.filter(backup => !backup.preserve).map(backup => fs.rm(backup.backup, { force: true })));
	return {
		launcherPath,
		preservedLaunchers: backups.filter(backup => backup.preserve).map(backup => backup.backup),
	};
}

async function runCommand(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
	const subprocess = Bun.spawn([...argv], { cwd, env, stdout: "inherit", stderr: "inherit" });
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${argv.join(" ")}`);
}

async function packageName(packageDir: string): Promise<string> {
	const manifest = await Bun.file(path.join(packageDir, "package.json")).json();
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("name" in manifest) ||
		typeof manifest.name !== "string"
	) {
		throw new Error(`Package name missing from ${packageDir}`);
	}
	return manifest.name;
}

async function packageVersion(packageDir: string): Promise<string> {
	const manifest = await Bun.file(path.join(packageDir, "package.json")).json();
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	) {
		throw new Error(`Package version missing from ${packageDir}`);
	}
	return manifest.version;
}

/**
 * Returns only native addons carrying the current package's binary sentinel.
 * x64 reuse requires a baseline/default build so the package remains portable.
 */
export async function findCompatibleNativeAddons(
	nativeDir: string,
	hostTag: string,
	version: string,
): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(nativeDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const prefix = `pi_natives.${hostTag}`;
	const sentinel = `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
	const compatible: string[] = [];
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".node")) continue;
		const bytes = await Bun.file(path.join(nativeDir, entry)).bytes();
		const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (contents.includes(sentinel)) compatible.push(entry);
	}

	// Local installs target this machine. A modern-only x64 addon is enough;
	// requiring baseline here forced a full Rust rebuild on every AVX2 host.
	return compatible;
}

async function packPackage(packageDir: string, tarballDir: string): Promise<string> {
	const before = new Set(await fs.readdir(tarballDir));
	await runCommand(["bun", "pm", "pack", "--destination", tarballDir, "--quiet"], packageDir);
	const created = (await fs.readdir(tarballDir)).filter(entry => entry.endsWith(".tgz") && !before.has(entry));
	if (created.length !== 1) {
		throw new Error(`Expected exactly one tarball from ${packageDir}, found ${created.length}`);
	}
	return path.join(tarballDir, created[0]);
}

async function packNamedPackage(tarballs: Map<string, string>, packageDir: string, tarballDir: string): Promise<void> {
	const name = await packageName(packageDir);
	if (tarballs.has(name)) throw new Error(`Duplicate package tarball: ${name}`);
	tarballs.set(name, await packPackage(packageDir, tarballDir));
}

async function withManifestRestored<T>(manifestPath: string, operation: () => Promise<T>): Promise<T> {
	const original = await Bun.file(manifestPath).text();
	try {
		return await operation();
	} finally {
		await Bun.write(manifestPath, original);
	}
}

async function nativeReuseDirectories(installRoot: string, hostTag: string): Promise<string[]> {
	const releasesDir = path.join(installRoot, "releases");
	let releases: string[] = [];
	try {
		releases = (await fs.readdir(releasesDir, { withFileTypes: true }))
			.filter(entry => entry.isDirectory() && entry.name.startsWith("release-"))
			.map(entry => entry.name)
			.sort()
			.reverse();
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const leafPath = ["node_modules", "@oh-my-pi", `pi-natives-${hostTag}`];
	return [
		...releases.map(release => path.join(releasesDir, release, ...leafPath)),
		path.join(installRoot, ...leafPath),
		path.join(nativesPackageDir, "native"),
	];
}

async function prepareHostNativeAddon(
	hostTag: string,
	buildOutputDir: string,
	installDir: string,
	rebuildNative: boolean,
): Promise<void> {
	await fs.mkdir(buildOutputDir, { recursive: true });
	const version = await packageVersion(nativesPackageDir);
	const reusableDirs = await nativeReuseDirectories(installDir, hostTag);

	if (!rebuildNative) {
		for (const reusableDir of reusableDirs) {
			const compatible = await findCompatibleNativeAddons(reusableDir, hostTag, version);
			if (compatible.length === 0) continue;
			for (const filename of compatible) {
				await fs.copyFile(path.join(reusableDir, filename), path.join(buildOutputDir, filename));
			}
			process.stdout.write(`Reusing compatible native addon from ${reusableDir}\n`);
			await generateNpmPackages({
				packageDir: nativesPackageDir,
				nativeDir: buildOutputDir,
				tags: [hostTag],
			});
			return;
		}
	}

	process.stdout.write(
		`${rebuildNative ? "Rebuilding" : "No compatible addon found; building"} ${hostTag} native addon.\n`,
	);
	await runCommand(["bun", "run", "build", "--dest", buildOutputDir], nativesPackageDir);
	await generateNpmPackages({
		packageDir: nativesPackageDir,
		nativeDir: buildOutputDir,
		tags: [hostTag],
	});
}

async function createTarballs(
	tarballDir: string,
	installDir: string,
	rebuildNative: boolean,
): Promise<Map<string, string>> {
	const tarballs = new Map<string, string>();
	const hostTag = `${process.platform}-${process.arch}`;

	const nativeBuildDir = path.join(path.dirname(tarballDir), "native-build");
	try {
		await prepareHostNativeAddon(hostTag, nativeBuildDir, installDir, rebuildNative);
		await packNamedPackage(tarballs, path.join(nativesPackageDir, "npm", hostTag), tarballDir);
	} finally {
		await fs.rm(nativeBuildDir, { recursive: true, force: true });
	}

	await withManifestRestored(path.join(nativesPackageDir, "package.json"), async () => {
		await prepareNativeCorePackage(nativesPackageDir, true);
		await packNamedPackage(tarballs, nativesPackageDir, tarballDir);
	});

	for (const packageDir of workspacePackageDirs) {
		await packNamedPackage(tarballs, path.join(repoRoot, packageDir), tarballDir);
	}

	await withManifestRestored(path.join(codingAgentPackageDir, "package.json"), async () => {
		await applyPublishBin("packages/coding-agent", true);
		await packNamedPackage(tarballs, codingAgentPackageDir, tarballDir);
	});

	return tarballs;
}

async function assertFile(filePath: string): Promise<void> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) throw new Error(`Expected file: ${filePath}`);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Missing expected file: ${filePath}`);
		throw error;
	}
}

async function assertDirectory(dirPath: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) throw new Error(`Expected directory: ${dirPath}`);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Missing expected directory: ${dirPath}`);
		throw error;
	}
}

async function installTarballs(stagingDir: string, tarballs: ReadonlyMap<string, string>): Promise<void> {
	const hostTag = `${process.platform}-${process.arch}`;
	const nativeLeafName = `@oh-my-pi/pi-natives-${hostTag}`;
	if (!tarballs.has(nativeLeafName)) throw new Error(`Missing native leaf tarball: ${nativeLeafName}`);

	const overrides = Object.fromEntries(
		[...tarballs].map(([name, tarball]) => [name, `file:./tarballs/${path.basename(tarball)}`]),
	);
	await Bun.write(
		path.join(stagingDir, "package.json"),
		`${JSON.stringify(
			{
				name: "omp-local-package-install",
				private: true,
				version: "0.0.0",
				overrides,
			},
			null,
			"\t",
		)}\n`,
	);

	const directTarballs = [...tarballs].filter(([name]) => name !== nativeLeafName).map(([, tarball]) => tarball);
	await runCommand(["bun", "add", ...directTarballs], stagingDir);

	const packageDir = path.join(stagingDir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	const preloadPath = path.join(packageDir, "scripts", "omp.ts");
	const cliPath = path.join(packageDir, "dist", "cli.js");
	await assertDirectory(path.join(stagingDir, "node_modules", "@oh-my-pi", `pi-natives-${hostTag}`));
	await assertFile(preloadPath);
	await assertFile(cliPath);
	await runCommand([process.execPath, "--preload", preloadPath, cliPath, "--version"], stagingDir);
}

async function cleanupOldReleases(releasesDir: string, currentRelease: string): Promise<void> {
	const entries = await fs.readdir(releasesDir, { withFileTypes: true });
	await Promise.all(
		entries
			.filter(entry => entry.isDirectory() && entry.name.startsWith("release-") && entry.name !== currentRelease)
			.map(async entry => {
				try {
					await fs.rm(path.join(releasesDir, entry.name), { recursive: true, force: true });
				} catch {
					// Windows keeps the release used by a running OMP process locked.
				}
			}),
	);
}

/** Packages every runtime workspace dependency, installs the tarballs outside the repo, and replaces `omp`. */
export async function installLocalPackage(options: LocalPackageInstallerOptions): Promise<LocalPackageInstallResult> {
	const installRoot = path.resolve(options.installDir);
	const binDir = path.resolve(options.binDir);
	// `prepack` bundles the CLI from source, so repair a partial workspace install before packaging.
	await runCommand(["bun", "install", "--frozen-lockfile"], repoRoot);
	const releasesDir = path.join(installRoot, "releases");
	await fs.mkdir(releasesDir, { recursive: true });
	const stagingDir = await fs.mkdtemp(path.join(releasesDir, ".staging-"));
	const releaseName = `release-${Date.now()}-${process.pid}`;
	const releaseDir = path.join(releasesDir, releaseName);

	try {
		const tarballDir = path.join(stagingDir, "tarballs");
		await fs.mkdir(tarballDir);
		const tarballs = await createTarballs(tarballDir, installRoot, options.rebuildNative ?? false);
		await installTarballs(stagingDir, tarballs);
		await fs.rename(stagingDir, releaseDir);

		const launcher = await writeLocalPackageLauncher({ installDir: releaseDir, binDir });
		await runCommand([launcher.launcherPath, "--version"], repoRoot);
		await cleanupOldReleases(releasesDir, releaseName);
		return {
			installDir: releaseDir,
			tarballDir: path.join(releaseDir, "tarballs"),
			launcherPath: launcher.launcherPath,
			preservedLaunchers: launcher.preservedLaunchers,
		};
	} finally {
		await fs.rm(stagingDir, { recursive: true, force: true });
	}
}

async function parseInstallerOptions(argv: readonly string[]): Promise<LocalPackageInstallerOptions | null> {
	let installDir: string | undefined;
	let binDir: string | undefined;
	let rebuildNative = false;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"Usage: bun run install:local-package [--install-dir <path>] [--bin-dir <path>] [--rebuild-native]\n\n" +
					"Packages the current workspace, installs it outside the repository, and replaces the omp launcher.\n" +
					"Compatible native addons are reused by default; --rebuild-native forces a fresh Rust build.\n",
			);
			return null;
		}
		if (arg === "--rebuild-native") {
			rebuildNative = true;
			continue;
		}
		if (arg === "--install-dir" || arg === "--bin-dir") {
			const value = argv[++index];
			if (!value) throw new Error(`${arg} requires a path`);
			if (arg === "--install-dir") installDir = value;
			else binDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	const resolvedInstallDir =
		installDir ?? process.env.OMP_LOCAL_PACKAGE_DIR ?? path.join(localDataDir(), "omp", "local-package");
	return {
		installDir: path.resolve(resolvedInstallDir),
		binDir: path.resolve(binDir ?? (await defaultBinDir())),
		rebuildNative,
	};
}

async function main(): Promise<void> {
	const options = await parseInstallerOptions(process.argv.slice(2));
	if (!options) return;

	process.stdout.write("Packing and installing a detached local OMP package...\n");
	const result = await installLocalPackage(options);
	process.stdout.write(`Installed package: ${result.installDir}\nLauncher: ${result.launcherPath}\n`);
	if (result.preservedLaunchers.length > 0) {
		process.stdout.write(`Preserved previous launcher(s): ${result.preservedLaunchers.join(", ")}\n`);
	}
}

if (import.meta.main) await main();
