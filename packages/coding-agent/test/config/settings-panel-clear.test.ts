import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

let state: SettingsTestState | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	state = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
});

it("clearing a settings-panel text field unsets the value so its env fallback applies again", () => {
	Bun.env.SEARXNG_ENDPOINT = "https://env.example";
	cfgSearxngEndpoint.set(settings, "https://cfg.example");
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);

	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n"); // open the text field
	selector.handleInput("\x15"); // clear it
	selector.handleInput("\n"); // submit

	expect(settings.getGlobalSettings()).not.toHaveProperty("searxng");
	expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
});
