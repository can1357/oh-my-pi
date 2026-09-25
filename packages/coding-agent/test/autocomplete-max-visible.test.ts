import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgAutocompleteMaxVisible } from "@oh-my-pi/pi-coding-agent/modes/settings";

describe("autocompleteMaxVisible setting", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-autocomplete-settings-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	it("should persist and read back a configured value", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		cfgAutocompleteMaxVisible.set(settings, 10);
		await settings.flush();

		// Re-init to verify persistence
		resetSettingsForTest();
		const settings2 = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgAutocompleteMaxVisible.get(settings2)).toBe(10);
	});

	it("should read from config.yml", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ autocompleteMaxVisible: 15 }, null, 2));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgAutocompleteMaxVisible.get(settings)).toBe(15);
	});

	it("should let project config.yml override global config.yml", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ autocompleteMaxVisible: 15 }, null, 2));
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({ autocompleteMaxVisible: 20 }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });

		expect(cfgAutocompleteMaxVisible.get(settings)).toBe(20);
	});
});
