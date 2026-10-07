import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedAddonFiles } from "../scripts/embed-native";
import { type EmbeddedAddon, extractEmbeddedAddonArchive } from "../native/loader-state.js";

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

	it("resolves a bundled archive next to the CLI, independent of caller cwd", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		// A pre-stamp addon whose legacy sentinel matches the version (the loader accepts it).
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await Promise.all([fs.mkdir(nativeDir), fs.mkdir(outDir), fs.mkdir(cacheDir)]);
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

			const output = await Bun.build({
				entrypoints: [path.join(nativeDir, "embedded-addon.js")],
				outdir: outDir,
				target: "bun",
				files: embeddedFiles,
				define: { "process.env.PI_ANDROID_BUNDLE": JSON.stringify("1") },
			});
			if (!output.success) {
				throw new Error(`Bundle embedded addon manifest failed:\n${output.logs.map(log => log.message).join("\n")}`);
			}

			const entry = output.outputs.find(artifact => artifact.kind === "entry-point");
			if (!entry) throw new Error("Bundle emitted no entrypoint");
			const runner = path.join(root, "run-bundle.ts");
			await Bun.write(
				runner,
				`import { embeddedAddon } from ${JSON.stringify(entry.path)};\nconsole.log(JSON.stringify(embeddedAddon));\n`,
			);
			const result = Bun.spawnSync([process.execPath, runner], { cwd: cacheDir, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			const embeddedAddon = JSON.parse(result.stdout.toString()) as EmbeddedAddon;
			expect(embeddedAddon.platformTag).toBe("win32-arm64");
			expect(embeddedAddon.version).toBe("18.1.1");
			const archivePath = embeddedAddon.archive?.filePath ?? "";
			expect(path.isAbsolute(archivePath)).toBe(true);
			await fs.access(archivePath);
			extractEmbeddedAddonArchive({
				archivePath,
				files: embeddedAddon.files,
				targetDir: cacheDir,
			});
			expect(await Bun.file(path.join(cacheDir, "pi_natives.win32-arm64.node")).text()).toBe(addon);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
