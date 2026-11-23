/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/823.
 *
 * On WSL (and any host where the user moves the standalone binary away from the
 * build-time native artifacts), the compiled `omp` binary fails to load
 * `pi_natives.linux-x64-*.node`. Root cause: the old loader's
 * `isCompiledBinary` detection relied on signals that are unreliable in a Bun
 * standalone binary:
 *   - `process.env.PI_COMPILED` — never set, because `bun build --compile
 *     --define PI_COMPILED=true` substitutes the bare identifier, not
 *     property accesses on `process.env`.
 *   - CommonJS `__filename` bunfs markers — Bun's compiled binaries kept the
 *     original build-host absolute path there, while `import.meta.url` is the
 *     value rewritten to the bunfs URL.
 *
 * When both signals were false, the loader skipped the embedded-addon
 * extraction path and only tried `nativeDir` (the dev machine's checkout) and
 * `execDir`. On WSL with `~/.local/bin/omp` and no sibling `.node` file, this
 * failed with the error reported in the issue.
 *
 * The fix is to make the loader's compiled-binary detection authoritative on
 * the embedded-addon module presence (the embedded-addon stub exports `null`
 * outside of `--compile`, and is regenerated to a populated object during the
 * standalone build), and to expose the candidate-path computation as a pure
 * helper so it can be tested host-agnostically.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectCompiledBinary,
	type EmbeddedAddonFile,
	embeddedAddonPath,
	extractEmbeddedAddons,
	getAddonFilenames,
	pruneStaleEmbeddedAddons,
	resolveLoaderCandidates,
	resolveRuntimeCandidates,
} from "../native/loader-state.js";

describe("issue 823: standalone-binary native loader path resolution", () => {
	it("detects compiled-binary mode from embedded-addon presence when env and url markers are absent", () => {
		// Mirrors what a Bun standalone binary actually sees on linux-x64 / WSL:
		// - `process.env.PI_COMPILED` is undefined (the build flag does not substitute property accesses).
		// - `import.meta.url` points at `$bunfs` for bundled modules; the old CJS
		//   loader used `__filename`, which is NOT rewritten.
		// The embedded-addon module is the authoritative compiled-mode signal: it is `null` in
		// development (the stub) and a populated object in the standalone build (after
		// `embed:native` runs), and is bundled into the binary by `bun build --compile`.
		expect(
			detectCompiledBinary({
				embeddedAddon: {
					platformTag: "linux-x64",
					version: "14.5.2",
					files: [
						{
							variant: "modern",
							filename: "pi_natives.linux-x64-modern.node",
							size: 1,
							hash: "0000000000000001",
							zstdPath: "/$bunfs/root/pi_natives.linux-x64-modern-a1b2c3d4.node.zst",
						},
					],
				},
				env: {},
				importMetaUrl: "/home/u/build-host/packages/natives/native/index.js",
			}),
		).toBe(true);

		// Without an embedded-addon and without env/url markers, we are NOT compiled.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "/home/u/dev/packages/natives/native/index.js",
			}),
		).toBe(false);

		// Env override (e.g. user-set PI_COMPILED=1) still wins.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: { PI_COMPILED: "1" },
				importMetaUrl: "/anywhere",
			}),
		).toBe(true);

		// `import.meta.url` bunfs marker still wins when present.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "file:///$bunfs/root/cli",
			}),
		).toBe(true);
	});

	it("places embedded-extracted candidates ahead of build-host candidates for linux-x64 standalone", () => {
		const versionedDir = "/home/u/.omp/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const nativeDir = "/build-host/packages/natives/native";
		const execDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" }),
			isCompiledBinary: true,
			nativeDir,
			execDir,
			versionedDir,
			userDataDir,
		});

		const versionedModern = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const userDataModern = path.join(userDataDir, "pi_natives.linux-x64-modern.node");
		const buildHostModern = path.join(nativeDir, "pi_natives.linux-x64-modern.node");

		// Versioned cache and user-data dir candidates must exist for compiled binaries —
		// these are where the embedded-addon extraction lands (~/.omp/natives/<v>) and where
		// `omp update` writes the standalone binary on linux (~/.local/bin).
		expect(candidates).toContain(versionedModern);
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(userDataModern);

		// Order matters: embedded-extracted destinations must be probed before the
		// (potentially-missing) build-host nativeDir path from the bundled module location.
		expect(candidates.indexOf(versionedModern)).toBeLessThan(candidates.indexOf(buildHostModern));
	});

	it("prefers platform leaf package candidates ahead of core nativeDir candidates on npm installs", () => {
		const leafPackageDir = "/app/node_modules/@oh-my-pi/pi-natives-linux-x64";
		const nativeDir = "/app/node_modules/@oh-my-pi/pi-natives/native";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			leafPackageDir,
			nativeDir,
			execDir: "/app/node_modules/.bin",
			versionedDir: "/home/u/.omp/natives/15.5.15",
			userDataDir: "/home/u/.local/bin",
		});

		const leafBaseline = path.join(leafPackageDir, "pi_natives.linux-x64-baseline.node");
		const coreBaseline = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");
		expect(candidates).toContain(leafBaseline);
		expect(candidates.indexOf(leafBaseline)).toBeLessThan(candidates.indexOf(coreBaseline));
	});

	it("keeps Windows staging ahead of leaf package and core nativeDir candidates", () => {
		const versionedDir = "/home/u/.omp/natives/15.5.15";
		const leafPackageDir = "/app/node_modules/@oh-my-pi/pi-natives-win32-x64";
		const nativeDir = "/app/node_modules/@oh-my-pi/pi-natives/native";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			leafPackageDir,
			nativeDir,
			execDir: "/app/node_modules/.bin",
			versionedDir,
			userDataDir: "/home/u/AppData/Local/omp",
		});

		const stagedBaseline = path.join(versionedDir, "pi_natives.win32-x64-baseline.node");
		const leafBaseline = path.join(leafPackageDir, "pi_natives.win32-x64-baseline.node");
		const coreBaseline = path.join(nativeDir, "pi_natives.win32-x64-baseline.node");
		expect(candidates.indexOf(stagedBaseline)).toBeLessThan(candidates.indexOf(leafBaseline));
		expect(candidates.indexOf(leafBaseline)).toBeLessThan(candidates.indexOf(coreBaseline));
	});

	it("keeps the development candidate list unchanged when no leaf package is installed", () => {
		const nativeDir = "/repo/packages/natives/native";
		const execDir = "/usr/bin";
		const addonFilenames = getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" });
		const candidates = resolveLoaderCandidates({
			addonFilenames,
			isCompiledBinary: false,
			nativeDir,
			execDir,
			versionedDir: "/home/u/.omp/natives/15.5.15",
			userDataDir: "/home/u/.local/bin",
		});

		expect(candidates).toEqual(
			addonFilenames.flatMap(filename => [path.join(nativeDir, filename), path.join(execDir, filename)]),
		);
	});

	describe("embedded addon extraction", () => {
		let testDir: string;

		afterEach(async () => {
			mock.restore();
			if (testDir) await fs.rm(testDir, { recursive: true, force: true });
		});

		async function embeddedFile(
			variant: EmbeddedAddonFile["variant"],
			filename: string,
			hash: string,
			content: string,
		): Promise<EmbeddedAddonFile> {
			const zstdPath = path.join(testDir, `${hash}-${filename}.zst`);
			await Bun.write(zstdPath, Bun.zstdCompressSync(Buffer.from(content)));
			return { variant, filename, size: Buffer.byteLength(content), hash, zstdPath };
		}

		it("extracts every bundled variant to its build's path and skips builds already extracted", async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-zstd-"));
			const files = [
				await embeddedFile("modern", "pi_natives.linux-x64-modern.node", "aa01", "modern native addon"),
				await embeddedFile("baseline", "pi_natives.linux-x64-baseline.node", "bb02", "baseline native addon"),
			];

			const written = extractEmbeddedAddons({ files, targetDir: testDir });
			expect(written.sort()).toEqual(files.map(file => embeddedAddonPath(testDir, file)).sort());
			expect(await Bun.file(embeddedAddonPath(testDir, files[0])).text()).toBe("modern native addon");
			expect(await Bun.file(embeddedAddonPath(testDir, files[1])).text()).toBe("baseline native addon");

			expect(extractEmbeddedAddons({ files, targetDir: testDir })).toEqual([]);
		});

		it("keeps same-size builds of one version apart, so neither ever loads the other's addon", async () => {
			// Two builds of one version whose addons have identical sizes: what a
			// rebuild routinely produces, and what a shared cache path could not
			// tell apart, however the two extractions interleaved.
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-builds-"));
			const filename = "pi_natives.win32-x64-baseline.node";
			const buildA = await embeddedFile("baseline", filename, "aaaa", "addon from build A");
			const buildB = await embeddedFile("baseline", filename, "bbbb", "addon from build B");

			extractEmbeddedAddons({ files: [buildA], targetDir: testDir });
			extractEmbeddedAddons({ files: [buildB], targetDir: testDir });
			// Build A starting again finds its own copy untouched by B.
			expect(extractEmbeddedAddons({ files: [buildA], targetDir: testDir })).toEqual([]);
			expect(await Bun.file(embeddedAddonPath(testDir, buildA)).text()).toBe("addon from build A");
			expect(await Bun.file(embeddedAddonPath(testDir, buildB)).text()).toBe("addon from build B");
		});

		it("replaces an interrupted extraction instead of trusting it", async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-partial-"));
			const file = await embeddedFile("default", "pi_natives.linux-arm64.node", "c0de", "complete addon");
			const targetPath = embeddedAddonPath(testDir, file);
			// A truncated copy at the build's own path, plus a temp file left by a
			// process that died before its rename.
			await Bun.write(targetPath, "complete");
			await Bun.write(`${targetPath}.tmp.1.1`, "complete addon");

			expect(extractEmbeddedAddons({ files: [file], targetDir: testDir })).toEqual([targetPath]);
			expect(await Bun.file(targetPath).text()).toBe("complete addon");
		});

		it("accepts the same build published by another process first", async () => {
			// On Windows the rename fails when a concurrent process has already
			// published and loaded the same build; its copy is this build's bytes.
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-race-"));
			const file = await embeddedFile("default", "pi_natives.win32-x64.node", "d00d", "shared addon");
			const targetPath = embeddedAddonPath(testDir, file);
			spyOn(nodeFs, "renameSync").mockImplementation(() => {
				nodeFs.writeFileSync(targetPath, "shared addon");
				throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			});

			expect(extractEmbeddedAddons({ files: [file], targetDir: testDir })).toEqual([]);
			expect(await Bun.file(targetPath).text()).toBe("shared addon");
		});

		it("rejects a zstd frame whose size disagrees with the manifest", async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-zstd-"));
			const file = { ...(await embeddedFile("default", "pi_natives.linux-arm64.node", "e1", "addon")), size: 6 };

			expect(() => extractEmbeddedAddons({ files: [file], targetDir: testDir })).toThrow(
				"Embedded addon size mismatch for pi_natives.linux-arm64.node: expected 6, got 5",
			);
			expect(await fs.exists(embeddedAddonPath(testDir, file))).toBe(false);
		});

		it("prunes other builds' extractions and leaves everything else in the version directory", async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-prune-"));
			const current = await embeddedFile("baseline", "pi_natives.win32-x64-baseline.node", "aaaa", "current");
			const older = await embeddedFile("baseline", "pi_natives.win32-x64-baseline.node", "bbbb", "older");
			extractEmbeddedAddons({ files: [current, older], targetDir: testDir });
			// Unhashed files belong to node_modules staging, not to extraction.
			const staged = path.join(testDir, "pi_natives.win32-x64-baseline.node");
			await Bun.write(staged, "staged");

			expect(pruneStaleEmbeddedAddons({ targetDir: testDir, keepHashes: ["aaaa"] })).toEqual([
				path.dirname(embeddedAddonPath(testDir, older)),
			]);
			expect(await fs.exists(embeddedAddonPath(testDir, current))).toBe(true);
			expect(await fs.exists(staged)).toBe(true);
		});
	});

	it("never probes the shared version-directory paths when the binary embeds its own addon", () => {
		// A file there may come from any build of this version and passes the
		// release-version check, so falling back to it after a failed
		// extraction would load another build's addon.
		const versionedDir = "/home/u/.omp/natives/18.20.2";
		const shared = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const userData = "/home/u/.local/bin/pi_natives.linux-x64-modern.node";
		const own = path.join(versionedDir, "embedded-aaaa", "pi_natives.linux-x64-modern.node");
		const ownBaseline = path.join(versionedDir, "embedded-bbbb", "pi_natives.linux-x64-baseline.node");
		const candidates = [shared, userData];

		expect(
			resolveRuntimeCandidates({
				candidates,
				versionedDir,
				hasEmbedded: true,
				embedded: [own, ownBaseline],
				staged: null,
			}),
		).toEqual([own, ownBaseline, userData]);
		// Extraction failed: only non-cache locations remain.
		expect(
			resolveRuntimeCandidates({ candidates, versionedDir, hasEmbedded: true, embedded: [], staged: null }),
		).toEqual([userData]);
		// Without an embedded addon the version directory is still a valid source.
		expect(
			resolveRuntimeCandidates({ candidates, versionedDir, hasEmbedded: false, embedded: [], staged: null }),
		).toEqual(candidates);
	});
});
