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

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectCompiledBinary,
	type EmbeddedAddonFile,
	extractEmbeddedAddonArchive,
	getAddonFilenames,
	resolveLoaderCandidates,
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
							filePath: "/$bunfs/root/packages/natives/native/pi_natives.linux-x64-modern.node",
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

	it("does not probe user-data candidates when running outside a standalone binary", () => {
		const versionedDir = "/home/u/.omp/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			nativeDir: "/repo/packages/natives/native",
			execDir: "/usr/bin",
			versionedDir,
			userDataDir,
		});
		expect(candidates).not.toContain(path.join(versionedDir, "pi_natives.linux-x64-baseline.node"));
		expect(candidates).not.toContain(path.join(userDataDir, "pi_natives.linux-x64-baseline.node"));
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

	it("extracts all bundled native variants from one gzip archive and skips current files", async () => {
		const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-archive-"));
		try {
			const archivePath = path.join(testDir, "embedded-addons.linux-x64.tar.gz");
			const targetDir = path.join(testDir, "cache");
			await fs.mkdir(targetDir);

			const modern = Buffer.from("modern native addon");
			const baseline = Buffer.from("baseline native addon");
			const modernFilename = "pi_natives.linux-x64-modern.node";
			const baselineFilename = "pi_natives.linux-x64-baseline.node";
			await Bun.write(
				archivePath,
				await new Bun.Archive(
					{
						[modernFilename]: modern,
						[baselineFilename]: baseline,
					},
					{ compress: "gzip", level: 9 },
				).bytes(),
			);

			const files: EmbeddedAddonFile[] = [
				{ variant: "modern", filename: modernFilename, size: modern.length },
				{ variant: "baseline", filename: baselineFilename, size: baseline.length },
			];

			const written = extractEmbeddedAddonArchive({ archivePath, files, targetDir });
			expect(written.map(filePath => path.basename(filePath)).sort()).toEqual([baselineFilename, modernFilename]);
			expect(await fs.readFile(path.join(targetDir, modernFilename), "utf8")).toBe("modern native addon");
			expect(await fs.readFile(path.join(targetDir, baselineFilename), "utf8")).toBe("baseline native addon");

			expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([]);
		} finally {
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});
});
