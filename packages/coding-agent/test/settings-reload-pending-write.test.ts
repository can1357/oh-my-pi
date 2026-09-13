import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// A `set()` queues a debounced save. If an in-session `reload()` runs before
// the debounce fires, the pending change must survive: routing the reload
// through the hardened `reloadFromDisk` primitive FLUSHES the queued write
// first, so the user's value lands on disk before the layers are re-read.
// Pre-fix, `reload()` used the raw `#loadReadOnly` re-read, which replaced the
// in-memory layers with the stale disk values while the path stayed marked
// modified — the later debounced save then wrote the OLD value back, silently
// discarding the user's pending change.
let settingsState: SettingsTestState | undefined;
let tempDir: TempDir | undefined;
let agentDir = "";
let projectDir = "";

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@test-settings-pending-write-");
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

it("keeps a pending debounced write when reload runs before the debounce fires", async () => {
	const globalConfigPath = path.join(agentDir, "config.yml");
	fs.writeFileSync(globalConfigPath, "autocompleteMaxVisible: 3\n");

	const settings = await Settings.init({ cwd: projectDir, agentDir });
	expect(settings.get("autocompleteMaxVisible")).toBe(3);

	// User change queues a debounced save; the disk still holds the old value.
	settings.set("autocompleteMaxVisible", 7);
	expect(settings.get("autocompleteMaxVisible")).toBe(7);

	// A reload lands before the debounce timer fires (the `/refresh settings`
	// race). The pending change must not be lost.
	await settings.reload();
	// Drain any still-queued save so the on-disk state is settled.
	await settings.flush();

	// Pre-fix, the reload re-read the stale disk value into the live layer and
	// the debounced save then persisted 3 — the user's edit vanished.
	expect(settings.get("autocompleteMaxVisible")).toBe(7);
	const onDisk = fs.readFileSync(globalConfigPath, "utf8");
	expect(onDisk).toContain("autocompleteMaxVisible: 7");
	expect(onDisk).not.toContain("autocompleteMaxVisible: 3");
});
