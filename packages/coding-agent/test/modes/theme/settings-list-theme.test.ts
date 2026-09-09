import { beforeAll, describe, expect, it } from "bun:test";
import { getSettingsListTheme, initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("getSettingsListTheme", () => {
	it("keeps modified labels and values dirty even when selected", () => {
		const settingsTheme = getSettingsListTheme();

		const selectedChangedLabel = settingsTheme.label("Changed", true, true);
		const selectedChangedValue = settingsTheme.value("changed", true, true);
		const unselectedChangedValue = settingsTheme.value("changed", false, true);
		const selectedDefaultValue = settingsTheme.value("default", true, false);

		expect(selectedChangedLabel).toBe(theme.fg("statusLineGitDirty", "Changed"));
		expect(selectedChangedValue).toBe(theme.fg("statusLineGitDirty", "changed"));
		expect(unselectedChangedValue).toBe(theme.fg("statusLineGitDirty", "changed"));
		expect(selectedDefaultValue).toBe(theme.fg("accent", "default"));
	});
});
