/**
 * Windows package installs load directly unless the updater opts into staging.
 * The updater must load only the cache copy: falling back to node_modules
 * would lock the very addon the package manager needs to replace.
 * Workspace builds and standalone extraction keep their own loading paths.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
	getAddonFilenames,
	initLoaderContext,
	prepareNativeVersionDir,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\oh-my-pi\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@oh-my-pi/pi-natives/native";

describe("windows native addon staging", () => {
	it("stages Windows package installs only when explicitly enabled", () => {
		const installed = {
			platform: "win32",
			isCompiledBinary: false,
			nativeDir: winNodeModulesNativeDir,
		};
		expect(shouldStageNodeModulesAddon(installed)).toBe(false);
		expect(shouldStageNodeModulesAddon({ ...installed, stagingEnabled: true })).toBe(true);
		expect(shouldStageNodeModulesAddon({ ...installed, stagingEnabled: false })).toBe(false);

		// Rebuilds must not be shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				...installed,
				stagingEnabled: true,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);
		// Standalone extraction, not staging, owns the compiled cache.
		expect(shouldStageNodeModulesAddon({ ...installed, stagingEnabled: true, isCompiledBinary: true })).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				stagingEnabled: true,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("never falls back to installed addons when staging is enabled", () => {
		const versionedDir = "C:\\Users\\Admin\\.omp\\natives\\15.0.1";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			leafPackageDir: "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\pi-natives-win32-x64",
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir: "C:\\Users\\Admin\\AppData\\Local\\omp",
		});

		expect(candidates).toEqual([
			path.join(versionedDir, "pi_natives.win32-x64-baseline.node"),
			path.join(versionedDir, "pi_natives.win32-x64.node"),
		]);
	});

	it("classifies only Windows node_modules paths case-insensitively", () => {
		const leafPackageDir = "/tmp/node_modules/@oh-my-pi/pi-natives-darwin-arm64";
		const uppercaseNodeModulesNativeDir = "/tmp/NODE_MODULES/@oh-my-pi/pi-natives/native";
		const variantCacheKey = "__PI_NATIVE_VARIANT_CACHE";
		const previousVariantCache = process.env[variantCacheKey];
		try {
			const workspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/oh-my-pi/packages/natives/native",
				leafPackageDir,
			});
			const installed = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/node_modules/@oh-my-pi/pi-natives/native",
				leafPackageDir,
			});
			const uppercaseWorkspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const uppercaseWindowsInstall = initLoaderContext({
				platform: "win32",
				stagingEnabled: false,
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const leafCandidate = path.join(leafPackageDir, installed.addonFilenames[0]);
			const windowsLeafCandidate = path.join(leafPackageDir, uppercaseWindowsInstall.addonFilenames[0]);
			const workspaceCandidate = path.join(uppercaseNodeModulesNativeDir, uppercaseWorkspace.addonFilenames[0]);

			expect(workspace.isWorkspaceLoad).toBe(true);
			expect(workspace.leafPackageDir).toBeNull();
			expect(workspace.candidates).not.toContain(leafCandidate);
			expect(installed.isWorkspaceLoad).toBe(false);
			expect(installed.leafPackageDir).toBe(leafPackageDir);
			expect(installed.candidates).toContain(leafCandidate);
			expect(installed.candidates[0]).toBe(leafCandidate);

			expect(uppercaseWorkspace.isWorkspaceLoad).toBe(true);
			expect(uppercaseWorkspace.leafPackageDir).toBeNull();
			expect(uppercaseWorkspace.candidates[0]).toBe(workspaceCandidate);

			expect(uppercaseWindowsInstall.isWorkspaceLoad).toBe(false);
			expect(uppercaseWindowsInstall.leafPackageDir).toBe(leafPackageDir);
			expect(uppercaseWindowsInstall.stageFromNodeModules).toBe(false);
			expect(uppercaseWindowsInstall.candidates[0]).toBe(windowsLeafCandidate);
		} finally {
			if (previousVariantCache === undefined) delete process.env[variantCacheKey];
			else process.env[variantCacheKey] = previousVariantCache;
		}
	});

	it("falls back to the node_modules-only candidate list when staging is off", () => {
		// Mirrors the non-Windows / workspace-dev path: same behavior as before
		// the staging feature was introduced.
		const versionedDir = "/home/u/.omp/natives/15.0.1";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: posixNodeModulesNativeDir,
			execDir: "/usr/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const nodeModulesBaseline = path.join(posixNodeModulesNativeDir, "pi_natives.linux-x64-baseline.node");
		expect(candidates).not.toContain(versionedBaseline);
		expect(candidates).toContain(nodeModulesBaseline);
	});

	it("removes only older version directories after the current native version loads", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-cache-"));
		const currentMajor = Number.parseInt(packageJson.version, 10);
		const futureVersion = `${currentMajor + 1}.0.0`;
		const staleVersion = "15.10.11";
		const freshVersion = "15.10.12";
		try {
			await fs.mkdir(path.join(nativesDir, staleVersion));
			await fs.mkdir(path.join(nativesDir, freshVersion));
			await fs.mkdir(path.join(nativesDir, packageJson.version));
			await fs.mkdir(path.join(nativesDir, futureVersion));
			await fs.mkdir(path.join(nativesDir, "not-a-version"));
			await Bun.write(path.join(nativesDir, "README.txt"), "not a version directory");
			await fs.utimes(path.join(nativesDir, staleVersion), new Date(0), new Date(0));
			await fs.utimes(path.join(nativesDir, freshVersion), new Date(0), new Date(0));
			prepareNativeVersionDir(path.join(nativesDir, freshVersion));

			const removed = cleanupStaleNativeVersions({ nativesDir, currentVersion: packageJson.version });

			expect(removed.map(filePath => path.basename(filePath))).toEqual([staleVersion]);
			expect((await fs.readdir(nativesDir)).sort()).toEqual(
				["README.txt", freshVersion, packageJson.version, futureVersion, "not-a-version"].sort(),
			);
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32")(
		"exercises package exports map: updater stages via ./loader, normal loads via . entry, corrupt cache is fatal",
		async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-installed-natives-")));
			try {
				const coreDir = path.join(root, "node_modules/@oh-my-pi/pi-natives");
				const leafDir = path.join(root, `node_modules/@oh-my-pi/pi-natives-${process.platform}-${process.arch}`);
				const nativeDir = path.join(import.meta.dir, "../native");
				await fs.mkdir(coreDir, { recursive: true });
				await fs.mkdir(leafDir, { recursive: true });
				await fs.cp(nativeDir, path.join(coreDir, "native"), {
					recursive: true,
					filter: source => !source.endsWith(".node"),
				});
				await fs.copyFile(path.join(import.meta.dir, "../package.json"), path.join(coreDir, "package.json"));
				await Bun.write(
					path.join(leafDir, "package.json"),
					JSON.stringify({ name: `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`, main: "" }),
				);

				const filenames = getAddonFilenames({
					tag: `${process.platform}-${process.arch}`,
					arch: process.arch,
					variant: "baseline",
				});
				let addonFilename: string | undefined;
				for (const filename of filenames) {
					if (await Bun.file(path.join(nativeDir, filename)).exists()) {
						addonFilename = filename;
						break;
					}
				}
				if (!addonFilename)
					throw new Error("Build the host native addon before running the installed-loader test.");
				const installedAddon = path.join(leafDir, addonFilename);
				await fs.copyFile(path.join(nativeDir, addonFilename), installedAddon);

				const dataHome = path.join(root, "data");
				const cacheDir = path.join(dataHome, "omp/natives");
				const stagedAddon = path.join(cacheDir, packageJson.version, addonFilename);
				await fs.mkdir(path.join(dataHome, "omp"), { recursive: true });
				const probePath = path.join(root, "probe.mjs");
				await Bun.write(
					probePath,
					[
						// Use bare specifiers, not file URLs, so the probe exercises the
						// real package exports map: ./loader subpath + . entrypoint.
						// This catches regressions where an early import loads the native
						// addon before enableNativeAddonStaging runs, or where ./loader
						// resolves a different module instance from the . entry.
						// Dynamic import of the . entry is intentional: it delays the
						// side-effectful loadNative() call until after staging is set.
						'import { enableNativeAddonStaging } from "@oh-my-pi/pi-natives/loader";',
						'import assert from "node:assert/strict";',
						'if (process.argv[2] === "stage") enableNativeAddonStaging();',
						// The . entry calls loadNative() at module evaluation; the
						// dynamic import triggers that side effect. If staging is on,
						// it loads the cache copy; if off, it loads from node_modules.
						'try { await import("@oh-my-pi/pi-natives"); } catch (err) { process.stderr.write(String(err)); process.exit(1); }',
						'if (process.argv[2] === "direct") assert.throws(enableNativeAddonStaging, Error);',
						'process.stdout.write("ok");',
					].join("\n"),
				);
				const runProbe = async (mode: "direct" | "stage") => {
					const child = Bun.spawn([process.execPath, probePath, mode], {
						cwd: root,
						env: {
							...process.env,
							PI_COMPILED: "",
							PI_NATIVE_VARIANT: "baseline",
							XDG_DATA_HOME: dataHome,
							PI_DEBUG_STARTUP: "1",
						},
						stdout: "pipe",
						stderr: "pipe",
					});
					const [exitCode, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					return { exitCode, stdout, stderr };
				};

				const direct = await runProbe("direct");
				expect(direct.exitCode, direct.stderr).toBe(0);
				expect(direct.stdout).toBe("ok");
				expect(direct.stderr).toContain("native:mode:direct");
				expect(direct.stderr).toContain(installedAddon);
				expect(await fs.readdir(path.join(dataHome, "omp"))).toEqual([]);

				const staged = await runProbe("stage");
				expect(staged.exitCode, staged.stderr).toBe(0);
				expect(staged.stdout).toBe("ok");
				expect(staged.stderr).toContain("native:mode:staged");
				expect(staged.stderr).toContain(stagedAddon);
				expect(await Bun.file(stagedAddon).bytes()).toEqual(await Bun.file(installedAddon).bytes());

				// A corrupt cache must fail, not silently lock the valid installed addon.
				await Bun.write(stagedAddon, "invalid addon");
				const corrupt = await runProbe("stage");
				expect(corrupt.exitCode).toBe(1);
				expect(corrupt.stderr).toContain(stagedAddon);

				// Normal launches must ignore even an existing, damaged staging cache.
				const afterStaging = await runProbe("direct");
				expect(afterStaging.exitCode, afterStaging.stderr).toBe(0);
				expect(afterStaging.stdout).toBe("ok");
				expect(afterStaging.stderr).toContain("native:mode:direct");
				expect(afterStaging.stderr).toContain(installedAddon);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("pi-natives version sentinel", () => {
	it("Rust `js_name` matches the package version", async () => {
		// The JS loader (`packages/natives/native/index.js`) computes its expected
		// sentinel from `package.json#version`; if the Rust source falls out of
		// sync we ship a `.node` that the loader will refuse to use. Pinning the
		// pairing here catches release-script regressions before they reach CI.
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/pi-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__piNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch, 'Rust sentinel `js_name = "__piNativesV…"` not found in lib.rs').not.toBeNull();
		const expected = `__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		expect(sentinelMatch?.[1]).toBe(expected);
	});
});
