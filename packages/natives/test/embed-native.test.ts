import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedAddonFiles } from "../scripts/embed-native";

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

	it("extracts embedded addon assets from a standalone executable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi natives embed-"));
		const nativeDir = path.join(root, "native");
		const cacheDir = path.join(root, "cache");
		const executablePath = path.join(root, "native-embed-smoke");
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await Promise.all([fs.mkdir(nativeDir), fs.mkdir(cacheDir)]);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), addon);
			const embeddedFiles = await embeddedAddonFiles({
				platform: "win32",
				arch: "arm64",
				nativeDir,
				version: "18.1.1",
			});
			for (const [filePath, contents] of Object.entries(embeddedFiles)) {
				await Bun.write(filePath, contents);
			}

			const runner = path.join(root, "run-compiled.ts");
			await Bun.write(
				runner,
				[
					`import { embeddedAddon } from ${JSON.stringify(path.join(nativeDir, "embedded-addon.js"))};`,
					`import { extractEmbeddedAddons } from ${JSON.stringify(path.join(import.meta.dir, "../native/loader-state.js"))};`,
					`const targetDir = process.env.EMBEDDED_TEST_CACHE_DIR;`,
					`if (!targetDir) throw new Error("Missing embedded test cache directory");`,
					`const [addonPath] = extractEmbeddedAddons({ files: embeddedAddon.files, targetDir });`,
					`if (!addonPath) throw new Error("No embedded addon was extracted");`,
					`process.stdout.write(await Bun.file(addonPath).text());`,
				].join("\n"),
			);
			const output = await Bun.build({
				entrypoints: [runner],
				target: "bun",
				files: embeddedFiles,
				compile: { outfile: executablePath },
				throw: false,
			});
			if (!output.success) {
				throw new Error(
					`Standalone embedded addon build failed:\n${output.logs.map(log => log.message).join("\n")}`,
				);
			}

			const result = Bun.spawnSync([executablePath], {
				cwd: root,
				env: { ...Bun.env, EMBEDDED_TEST_CACHE_DIR: cacheDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			expect(result.stdout.toString()).toBe(addon);
			expect(await Bun.file(path.join(cacheDir, "pi_natives.win32-arm64.node")).text()).toBe(addon);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
