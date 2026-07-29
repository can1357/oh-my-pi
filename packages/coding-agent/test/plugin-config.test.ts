import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@pk-nerdsaver-ai/pi-utils";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("plugin config", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;
	// Restore each spy individually rather than via `mock.restore()`. These patch
	// the pi-utils barrel — a sealed ESM namespace that nearly every other test
	// file imports — and the global restore walks Bun's whole mock registry to
	// undo that, segfaulting the shared-process bucket (exit 132) as soon as a
	// later file touches an overlapping module graph.
	let spies: Array<{ mockRestore: () => void }> = [];

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-config-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "omp-plugins.lock.json");

		spies = [
			spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir),
			spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile),
			spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot),
			spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json")),
		];
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		await removeWithRetries(tmpRoot);
	});

	async function writeLegacyLockfile(pluginName: string): Promise<void> {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "0.2.2", enabledFeatures: null, enabled: true },
				},
			}),
		);
	}

	test("set initializes missing settings in legacy runtime config", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await new PluginManager(tmpRoot).setPluginSetting(pluginName, "autoContext.enabled", true);

		const lock = await Bun.file(lockfile).json();
		expect(lock.settings[pluginName]).toEqual({ "autoContext.enabled": true });
		expect(lock.plugins[pluginName]).toEqual({ version: "0.2.2", enabledFeatures: null, enabled: true });
	});

	test("list treats missing settings in legacy runtime config as empty", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await expect(new PluginManager(tmpRoot).getPluginSettings(pluginName)).resolves.toEqual({});
	});
});
