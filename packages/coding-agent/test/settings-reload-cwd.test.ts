import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { getProjectAgentDir, removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("Settings.reloadForCwd", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("re-resolves path-scoped settings against the new directory in place", async () => {
		const projectA = path.resolve("/tmp", `reload-a-${Snowflake.next()}`);
		const projectB = path.resolve("/tmp", `reload-b-${Snowflake.next()}`);
		const settings = Settings.isolated({
			enabledModels: [
				{ paths: [projectA], models: ["model-a"] },
				{ paths: [projectB], models: ["model-b"] },
			],
			// A plain (non-scoped) override must survive re-scoping.
			"compaction.enabled": false,
		});

		await settings.reloadForCwd(projectA);
		expect(settings.getCwd()).toBe(path.normalize(projectA));
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
		expect(settings.get("compaction.enabled")).toBe(false);

		await settings.reloadForCwd(projectB);
		expect(settings.getCwd()).toBe(path.normalize(projectB));
		expect(settings.get("enabledModels")).toEqual(["model-b"]);
		// Non-scoped override is preserved across the switch.
		expect(settings.get("compaction.enabled")).toBe(false);
	});

	it("is a no-op when the target directory is already the active scope", async () => {
		const projectA = path.resolve("/tmp", `reload-noop-${Snowflake.next()}`);
		const settings = Settings.isolated({
			enabledModels: [{ paths: [projectA], models: ["model-a"] }],
		});

		await settings.reloadForCwd(projectA);
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
		await settings.reloadForCwd(projectA);
		expect(settings.getCwd()).toBe(path.normalize(projectA));
		expect(settings.get("enabledModels")).toEqual(["model-a"]);
	});

	it("loads extra config overlays after project settings", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay", Snowflake.next());
		const projectDir = path.join(testDir, "project");
		const overlayPath = path.join(testDir, "overlay.yml");
		try {
			resetSettingsForTest();
			fs.mkdirSync(projectDir, { recursive: true });
			fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
			fs.writeFileSync(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ compaction: { enabled: true } }),
			);
			fs.writeFileSync(overlayPath, "compaction:\n  enabled: false\n");

			const settings = await Settings.init({ cwd: projectDir, inMemory: true, configFiles: [overlayPath] });
			expect(settings.get("compaction.enabled")).toBe(false);

			settings.override("compaction.enabled", true);
			expect(settings.get("compaction.enabled")).toBe(true);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("rejects a missing --config overlay instead of silently ignoring it", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay-missing", Snowflake.next());
		try {
			resetSettingsForTest();
			fs.mkdirSync(testDir, { recursive: true });

			const missingPath = path.join(testDir, "nope.yml");
			await expect(Settings.init({ cwd: testDir, inMemory: true, configFiles: [missingPath] })).rejects.toThrow(
				`Config overlay not found: ${missingPath}`,
			);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("rejects a malformed --config overlay", async () => {
		const testDir = path.join(os.tmpdir(), "test-config-overlay-bad", Snowflake.next());
		const overlayPath = path.join(testDir, "bad.yml");
		try {
			resetSettingsForTest();
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(overlayPath, "compaction: [unclosed\n");

			await expect(Settings.init({ cwd: testDir, inMemory: true, configFiles: [overlayPath] })).rejects.toThrow(
				"Failed to parse config overlay",
			);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	describe("project layer (on disk)", () => {
		let testDir: string;
		let agentDir: string;
		let startDir: string;
		let scopedProject: string;
		let bareProject: string;

		beforeEach(() => {
			resetSettingsForTest();
			testDir = path.join(os.tmpdir(), "test-reload-cwd", Snowflake.next());
			agentDir = path.join(testDir, "agent");
			startDir = path.join(testDir, "start");
			scopedProject = path.join(testDir, "scoped");
			bareProject = path.join(testDir, "bare");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(startDir, { recursive: true });
			fs.mkdirSync(bareProject, { recursive: true });
			// Only the scoped project ships a project-level settings file.
			fs.mkdirSync(getProjectAgentDir(scopedProject), { recursive: true });
			fs.writeFileSync(
				path.join(getProjectAgentDir(scopedProject), "settings.json"),
				JSON.stringify({ compaction: { enabled: false } }),
			);
		});

		afterEach(() => {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) {
				removeSyncWithRetries(testDir);
			}
		});

		it("loads and drops project settings as the working directory changes", async () => {
			const settings = await Settings.init({ cwd: startDir, agentDir });
			// No project file under startDir → schema default.
			expect(settings.get("compaction.enabled")).toBe(true);

			await settings.reloadForCwd(scopedProject);
			expect(settings.getCwd()).toBe(path.normalize(scopedProject));
			expect(settings.get("compaction.enabled")).toBe(false);

			// Moving to a project without settings drops the previous project's config.
			await settings.reloadForCwd(bareProject);
			expect(settings.getCwd()).toBe(path.normalize(bareProject));
			expect(settings.get("compaction.enabled")).toBe(true);
		});
	});
});
