import { afterEach, beforeEach, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { cfgTuiMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let state: SettingsTestState;
let tempDir: TempDir;
beforeEach(() => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("@omp-fullscreen-settings-");
});
afterEach(() => {
	restoreSettingsTestState(state);
	AgentStorage.close();
	tempDir.removeSync();
});

it("migrates both old boolean forms, with explicit modes taking precedence", async () => {
	const configPath = tempDir.join("agent", "config.yml");
	const cases = [
		{ raw: { tui: { fullscreen: true } }, expected: "fullscreen" },
		{ raw: { "tui.fullscreen": false }, expected: "regular" },
		{ raw: { tui: { mode: "regular", fullscreen: true } }, expected: "regular" },
		{ raw: { "tui.mode": "fullscreen", tui: { fullscreen: false } }, expected: "fullscreen" },
	] as const;
	for (const { raw, expected } of cases) {
		await Bun.write(configPath, YAML.stringify(raw));
		const settings = await Settings.loadReadOnly({ cwd: tempDir.path(), agentDir: tempDir.join("agent") });
		expect(cfgTuiMode.get(settings), JSON.stringify(raw)).toBe(expected);
	}
});

it("saves a panel choice over the launch override and restores it on the next launch", async () => {
	const configPath = tempDir.join("agent", "config.yml");
	await Bun.write(configPath, YAML.stringify({ tui: { mode: "fullscreen" } }));
	const settings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.join("agent") });
	cfgTuiMode.override(settings, "regular");
	const panel = createSettingsHost();
	expect(panel.get("tui.mode")).toBe("regular");
	panel.set("tui.mode", "fullscreen");
	expect(cfgTuiMode.get(settings)).toBe("fullscreen");
	panel.set("tui.mode", "regular");
	expect(cfgTuiMode.get(settings)).toBe("regular");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ tui: { mode: "regular" } });
	const next = await Settings.loadReadOnly({ cwd: tempDir.path(), agentDir: tempDir.join("agent") });
	expect(cfgTuiMode.get(next)).toBe("regular");

	cfgTuiMode.override(settings, "fullscreen");
	panel.unset("tui.mode");
	expect(cfgTuiMode.get(settings)).toBe("regular");
	await settings.flush();
});
