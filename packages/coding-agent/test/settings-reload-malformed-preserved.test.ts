import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// A pure-read in-session `reload()` (the `/refresh settings` path) must NOT move
// a malformed config.yml aside. The startup loaders acquire a write lock and
// rename invalid YAML to `.broken-*` before rejecting; wiring the read reload to
// those would let a read MOVE the user's file. `reload()` must use the hardened,
// non-quarantining readers and preserve the malformed file in place.
let settingsState: SettingsTestState | undefined;
let tempDir: TempDir | undefined;
let agentDir = "";
let projectDir = "";

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@test-settings-malformed-");
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

it("preserves a config.yml that becomes malformed after start, without quarantining it", async () => {
	const globalConfigPath = path.join(agentDir, "config.yml");
	fs.writeFileSync(globalConfigPath, "autocompleteMaxVisible: 3\n");

	const settings = await Settings.init({ cwd: projectDir, agentDir });
	expect(settings.get("autocompleteMaxVisible")).toBe(3);

	// The config becomes invalid YAML on disk (a mid-session edit typo).
	const malformed = "autocompleteMaxVisible: 3\n  : : bad\n";
	fs.writeFileSync(globalConfigPath, malformed);

	// A pure-read reload must reject the invalid YAML — but NOT move it aside.
	await expect(settings.reload()).rejects.toThrow();

	// Pre-fix (`#loadReadOnly` used the quarantining startup readers), reload
	// renamed the file to `config.yml.broken-*`, losing the user's edits.
	expect(fs.existsSync(globalConfigPath)).toBe(true);
	expect(fs.readFileSync(globalConfigPath, "utf8")).toBe(malformed);
	const quarantined = fs.readdirSync(agentDir).filter(name => name.includes(".broken-"));
	expect(quarantined).toEqual([]);
});
