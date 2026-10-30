import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgThemeDark } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// A write that leaves the persisted value unchanged must not rewrite config.yml: each rewrite is a
// read, fsync, and rename that also wakes every other process watching the file.
describe("Settings no-op saves", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-noop-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");

	/** Backdates config.yml so any rewrite is visible in its mtime; returns the bytes and mtime. */
	function snapshotConfig(): { text: string; mtimeMs: number } {
		const past = new Date(Date.now() - 3_600_000);
		fs.utimesSync(configPath(), past, past);
		return { text: fs.readFileSync(configPath(), "utf8"), mtimeMs: fs.statSync(configPath()).mtimeMs };
	}

	it("re-setting persisted values, entries, and model roles leaves config.yml untouched", async () => {
		await Bun.write(
			configPath(),
			YAML.stringify({
				theme: { dark: "titanium" },
				retry: { fallbackChains: { slow: ["user/slow"] } },
				modelRoles: { default: "openai/gpt-5" },
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		const before = snapshotConfig();

		cfgThemeDark.set(settings, "titanium");
		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow"]);
		settings.setModelRole("default", "openai/gpt-5");
		settings.setModelRole("absent-role", undefined);
		await settings.flush();

		expect({ text: fs.readFileSync(configPath(), "utf8"), mtimeMs: fs.statSync(configPath()).mtimeMs }).toEqual(
			before,
		);
	});

	it("skips a save whose merged YAML matches the file, while a real change still writes", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		cfgThemeDark.set(settings, "anthracite");
		await settings.flush();
		const before = snapshotConfig();

		// Changed and reverted before the debounced save runs: the merge reproduces the file.
		cfgThemeDark.set(settings, "titanium");
		cfgThemeDark.set(settings, "anthracite");
		await settings.flush();
		expect(fs.statSync(configPath()).mtimeMs).toBe(before.mtimeMs);
		expect(fs.readFileSync(configPath(), "utf8")).toBe(before.text);

		cfgThemeDark.set(settings, "titanium");
		await settings.flush();
		expect(fs.statSync(configPath()).mtimeMs).toBeGreaterThan(before.mtimeMs);
		expect(YAML.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ theme: { dark: "titanium" } });
	});
});
