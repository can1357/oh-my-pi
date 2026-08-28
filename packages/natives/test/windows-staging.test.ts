/**
 * Regression for the Windows `bun install -g` update path: when an `omp`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * The fix has two halves, both pinned by this test:
 *   1. The loader stages `nativeDir/<filename>.node` → `versionedDir/<filename>.node`
 *      (per-package-version cache under `~/.omp/natives/<version>/`) so the
 *      running process holds its OS-level handle on a path bun is never asked
 *      to overwrite. Gated to Windows + node_modules installs + non-compiled
 *      mode by `shouldStageNodeModulesAddon`.
 *   2. `resolveLoaderCandidates` puts the staged path ahead of the
 *      `node_modules` path so subsequent updates land in node_modules without
 *      contention.
 *
 * Both behaviors are off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
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
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("prepends versionedDir candidates ahead of node_modules when staging on Windows", () => {
		const versionedDir = "C:\\Users\\Admin\\.omp\\natives\\15.0.1";
		const userDataDir = "C:\\Users\\Admin\\AppData\\Local\\omp";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir,
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.win32-x64-baseline.node");
		const versionedDefault = path.join(versionedDir, "pi_natives.win32-x64.node");
		const nodeModulesBaseline = path.join(winNodeModulesNativeDir, "pi_natives.win32-x64-baseline.node");

		// Staged paths must be probed first so the running process locks the cache
		// copy and bun is free to replace the node_modules copy on next update.
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(versionedDefault);
		expect(candidates.indexOf(versionedBaseline)).toBeLessThan(candidates.indexOf(nodeModulesBaseline));

		// User-data dir is reserved for compiled-binary mode — staging must not
		// quietly start probing it on npm installs (where it never contains the
		// addon anyway).
		const userDataBaseline = path.join(userDataDir, "pi_natives.win32-x64-baseline.node");
		expect(candidates).not.toContain(userDataBaseline);
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
			expect(uppercaseWindowsInstall.stageFromNodeModules).toBe(true);
			expect(uppercaseWindowsInstall.candidates).toContain(windowsLeafCandidate);
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
