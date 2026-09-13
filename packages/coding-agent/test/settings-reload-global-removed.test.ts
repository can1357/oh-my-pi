import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// A global config.yml that existed at session start then gets deleted or
// renamed must not leave its values stranded in the live merged view after an
// in-session `reload()`. Pre-fix, `#loadReadOnly` only assigned `#global` when
// the file was still present, so the deleted layer's values persisted.
let settingsState: SettingsTestState | undefined;
let tempDir: TempDir | undefined;
let agentDir = "";
let projectDir = "";

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@test-settings-global-removed-");
	agentDir = path.join(tempDir.path(), "agent");
	projectDir = path.join(tempDir.path(), "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(async () => {
	AgentStorage.close();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	if (tempDir) {
		try {
			await tempDir.remove();
		} catch {}
		tempDir = undefined;
	}
});

it("resets the global layer to empty when config.yml is removed before reload", async () => {
	const globalConfigPath = path.join(agentDir, "config.yml");
	fs.writeFileSync(globalConfigPath, "autocompleteMaxVisible: 3\n");

	const settings = await Settings.init({ cwd: projectDir, agentDir });
	expect(settings.get("autocompleteMaxVisible")).toBe(3);

	// Global config removed at runtime (deleted/renamed).
	fs.rmSync(globalConfigPath);
	const { changed } = await settings.reload();

	// The stale global value must not survive: the setting falls back to its
	// schema default, and the reload reports the change.
	expect(changed).toBe(true);
	expect(settings.get("autocompleteMaxVisible")).not.toBe(3);
});
