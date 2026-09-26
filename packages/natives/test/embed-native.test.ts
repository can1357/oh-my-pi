import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embedNativeAddon } from "../scripts/embed-native";

describe("native addon embedding", () => {
	for (const [label, contents] of [
		["a longer release stamp that starts with the expected version", `binaryPI_NATIVES_VERSION_STAMP:18.1.10\0\0`],
		["a legacy sentinel export for the expected version", "binary__piNativesV18_1_1\0"],
		["an unstamped addon", `binaryPI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`],
	] as const) {
		it(`rejects ${label}`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
			const nativeDir = path.join(root, "native");
			const outputPath = path.join(nativeDir, "embedded-addon.js");
			try {
				await fs.mkdir(nativeDir);
				await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), contents);

				await expect(
					embedNativeAddon({
						targetPlatform: "win32",
						targetArch: "arm64",
						nativeDir,
						outputPath,
						version: "18.1.1",
					}),
				).rejects.toThrow("does not carry the @oh-my-pi/pi-natives@18.1.1 version stamp");
				expect(await Bun.file(outputPath).exists()).toBe(false);
				expect(await Bun.file(path.join(nativeDir, "embedded-addons.win32-arm64.tar.gz")).exists()).toBe(false);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
