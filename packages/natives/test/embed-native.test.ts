import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embedNativeAddon } from "../scripts/embed-native";

describe("native addon embedding", () => {
	it("rejects a longer release sentinel that starts with the expected version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outputPath = path.join(nativeDir, "embedded-addon.js");
		try {
			await fs.mkdir(nativeDir);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), "binary__piNativesV18_1_10");

			await expect(
				embedNativeAddon({
					targetPlatform: "win32",
					targetArch: "arm64",
					nativeDir,
					outputPath,
					version: "18.1.1",
				}),
			).rejects.toThrow("does not contain the @oh-my-pi/pi-natives@18.1.1 version sentinel `__piNativesV18_1_1`");
			expect(await Bun.file(outputPath).exists()).toBe(false);
			expect(await Bun.file(path.join(nativeDir, "embedded-addons.win32-arm64.tar.gz")).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
