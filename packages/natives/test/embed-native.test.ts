import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedAddonFiles } from "../scripts/embed-native";
import packageJson from "../package.json" with { type: "json" };
import {
	type EmbeddedAddon,
	type EmbeddedAddonFile,
	embeddedAddonPath,
	extractEmbeddedAddons,
	pruneStaleEmbeddedAddons,
} from "../native/loader-state.js";

describe("native addon embedding", () => {
	for (const [label, contents] of [
		["a longer release stamp that starts with the expected version", `binaryPI_NATIVES_VERSION_STAMP:18.1.10\0\0`],
		["a longer legacy sentinel export that starts with the expected version", "binary__piNativesV18_1_10\0"],
		["an unstamped addon", `binaryPI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`],
	] as const) {
		it(`rejects ${label}`, async () => {
			const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
			try {
				await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), contents);

				await expect(
					embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" }),
				).rejects.toThrow("does not carry the @oh-my-pi/pi-natives@18.1.1 version stamp");
			} finally {
				await fs.rm(nativeDir, { recursive: true, force: true });
			}
		});
	}

	it("embeds identical addon bytes identically", async () => {
		const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		try {
			const stamp = "PI_NATIVES_VERSION_STAMP:18.1.1\0";
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), `modern ${stamp}`.repeat(64));
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-baseline.node"), `baseline ${stamp}`.repeat(64));
			const first = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });
			// Distinct mtimes must not leak into the embedded bytes.
			await fs.utimes(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), 1, 1);
			const second = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });

			expect(Object.keys(first).map(key => path.basename(key))).toEqual([
				"pi_natives.linux-x64-modern.node.zst",
				"pi_natives.linux-x64-baseline.node.zst",
				"embedded-addon.js",
			]);
			expect(second).toEqual(first);
		} finally {
			await fs.rm(nativeDir, { recursive: true, force: true });
		}
	});

	it("emits a manifest whose zstd frames the loader extracts back to the addon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		// A pre-stamp addon whose legacy sentinel matches the version (the loader accepts it).
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), addon);
			await fs.mkdir(cacheDir);
			const files = await embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" });
			for (const filePath in files) {
				await Bun.write(path.join(outDir, path.basename(filePath)), files[filePath]);
			}

			// Dynamic: the manifest under test is generated into a per-test temp dir.
			const { embeddedAddon }: { embeddedAddon: EmbeddedAddon } = await import(
				path.join(outDir, "embedded-addon.js")
			);
			expect(embeddedAddon.platformTag).toBe("win32-arm64");
			expect(embeddedAddon.version).toBe("18.1.1");
			expect(embeddedAddon.files).toEqual([
				{
					variant: "default",
					filename: "pi_natives.win32-arm64.node",
					size: addon.length,
					hash: Bun.hash.xxHash64(addon).toString(16).padStart(16, "0"),
					zstdPath: path.join(await fs.realpath(outDir), "pi_natives.win32-arm64.node.zst"),
				},
			]);
			const extracted = embeddedAddonPath(cacheDir, embeddedAddon.files[0]);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([extracted]);
			expect(await Bun.file(extracted).text()).toBe(addon);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.arch !== "x64")("extracts only the selected addon until the loader tries a fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-first-run-"));
		const nativeDir = path.join(root, "native");
		const manifestDir = path.join(import.meta.dir, "../native");
		const tag = `${process.platform}-${process.arch}`;
		try {
			for (const variant of ["modern", "baseline"]) {
				await Bun.write(
					path.join(nativeDir, `pi_natives.${tag}-${variant}.node`),
					`fake ${variant} PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
				);
			}
			const embedded = await embeddedAddonFiles({
				platform: process.platform,
				arch: process.arch,
				nativeDir,
				version: packageJson.version,
			});
			const files: Record<string, string | Uint8Array> = {};
			for (const file in embedded) files[path.join(manifestDir, path.basename(file))] = embedded[file];

			const entry = path.join(root, "entry.ts");
			await Bun.write(
				entry,
				`import { loadNative } from ${JSON.stringify(path.join(manifestDir, "loader-state.js"))};\ntry { loadNative(); } catch {}\n`,
			);
			const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
			const build = await Bun.build({
				entrypoints: [entry],
				root: path.resolve(import.meta.dir, "../../.."),
				target: "bun",
				format: "esm",
				files,
				compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
			});
			expect(build.success).toBe(true);

			for (const variant of ["baseline", "modern"]) {
				const cache = path.join(root, variant);
				const child = Bun.spawn([binary], {
					env: { ...process.env, PI_NATIVES_DIR: cache, PI_NATIVE_VARIANT: variant },
					stdout: "ignore",
					stderr: "ignore",
				});
				expect(await child.exited).toBe(0);
				const extracted = (await fs.readdir(path.join(cache, packageJson.version), { recursive: true }))
					.filter(file => file.endsWith(".node"))
					.sort();
				// Each extracted addon sits in its own build's `embedded-<hash>/` directory.
				expect(extracted.every(file => path.dirname(file).startsWith("embedded-"))).toBe(true);
				expect(extracted.map(file => path.basename(file)).sort()).toEqual(
					(variant === "modern"
						? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
						: [`pi_natives.${tag}-baseline.node`]
					).sort(),
				);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("embedded addon extraction", () => {
	let testDir: string;

	afterEach(async () => {
		vi.restoreAllMocks();
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
		vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
			nodeFs.writeFileSync(targetPath, "shared addon");
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		});

		expect(extractEmbeddedAddons({ files: [file], targetDir: testDir })).toEqual([]);
		expect(await Bun.file(targetPath).text()).toBe("shared addon");
	});

	it("uses an addon already extracted into a version directory it cannot touch, and fails only when extraction is needed", async () => {
		// Read-only natives dir (container image, immutable system) pre-provisioned with this build's addon.
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-embedded-readonly-"));
		const present = await embeddedFile("modern", "pi_natives.linux-x64-modern.node", "f00d", "provisioned addon");
		const missing = await embeddedFile("baseline", "pi_natives.linux-x64-baseline.node", "beef", "baseline addon");
		extractEmbeddedAddons({ files: [present], targetDir: testDir });
		vi.spyOn(nodeFs, "utimesSync").mockImplementation(() => {
			throw Object.assign(new Error(`EROFS: read-only file system, utime '${testDir}'`), { code: "EROFS" });
		});

		expect(extractEmbeddedAddons({ files: [present], targetDir: testDir })).toEqual([]);
		expect(() => extractEmbeddedAddons({ files: [missing], targetDir: testDir })).toThrow("EROFS");
		expect(await fs.exists(embeddedAddonPath(testDir, missing))).toBe(false);
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
