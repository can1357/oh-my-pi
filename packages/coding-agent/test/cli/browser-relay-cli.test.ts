import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";

describe("omp browser-relay install", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = await TempDir.create("@omp-relay-install-");
		spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		mock.restore();
		await dir.remove();
	});

	it("stamps the installing omp's version into the extension manifest", async () => {
		await runBrowserRelayCommand({ action: "install", port: 0, dir: dir.path() });
		const manifest = await Bun.file(dir.join("manifest.json")).json();
		expect(manifest.version_name).toBe(VERSION);
		expect(manifest.manifest_version).toBe(3);
	});
});
