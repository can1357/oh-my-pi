import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Issue #13326: 18.3 removed `settings.override(path, value)`. Extensions reach the
// replacement through the `@oh-my-pi/pi-coding-agent/config/registry` subpath
// (documented in docs/extensions.md § Runtime setting overrides); the override only
// lands if that import resolves to the host's registry, not a second copy.
const EXTENSION_SOURCE = `
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export default function (pi) {
	const recap = lookup("recap.enabled");
	if (!recap) throw new Error("recap.enabled is not registered");
	if (!recap.isConfigured(pi.pi.settings)) recap.override(pi.pi.settings, false);
}
`;

describe("extension runtime setting overrides", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@ext-setting-override-");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function loadOverrideExtension(globalConfig?: string): Promise<Settings> {
		const cwd = tempDir!.path();
		const agentDir = path.join(cwd, "agent");
		const extensionPath = path.join(cwd, "extension.ts");
		await Bun.write(extensionPath, EXTENSION_SOURCE);
		if (globalConfig) await Bun.write(path.join(agentDir, "config.yml"), globalConfig);
		const settings = await Settings.init({ cwd, agentDir });
		const result = await loadExtensions([extensionPath], cwd);
		expect(result.errors).toEqual([]);
		return settings;
	}

	it("applies a runtime override the host session observes", async () => {
		const settings = await loadOverrideExtension();
		const recap = lookup("recap.enabled")!;

		expect(recap.get(settings)).toBe(false);
		expect(recap.provenance(settings)).toBe("runtime");
	});

	it("sees the user's configured value and leaves it in place", async () => {
		const settings = await loadOverrideExtension("recap:\n  enabled: true\n");
		const recap = lookup("recap.enabled")!;

		expect(recap.get(settings)).toBe(true);
		expect(recap.provenance(settings)).toBe("global");
	});
});
