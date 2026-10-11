import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	type Settings as SettingsCapabilityItem,
	settingsCapability,
} from "@oh-my-pi/pi-coding-agent/capability/settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { cfgPersonality } from "@oh-my-pi/pi-coding-agent/session/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("Codex config.toml settings", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-settings-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	test("loads user and project config.toml as settings items without validation warnings", async () => {
		const userConfig = path.join(home, ".codex", "config.toml");
		const projectConfig = path.join(project, ".codex", "config.toml");
		await fs.mkdir(path.dirname(userConfig), { recursive: true });
		await fs.mkdir(path.dirname(projectConfig), { recursive: true });
		await fs.writeFile(userConfig, 'model = "user-model"\n\n[tui]\nnotifications = true\n');
		await fs.writeFile(projectConfig, 'approval_policy = "on-request"\n');

		const result = await loadCapability<SettingsCapabilityItem>(settingsCapability.id, {
			cwd: project,
			providers: ["codex"],
		});

		expect(result.warnings ?? []).toEqual([]);
		expect(result.items.map(item => ({ path: item.path, level: item.level, data: item.data }))).toEqual([
			{ path: userConfig, level: "user", data: { model: "user-model", tui: { notifications: true } } },
			{ path: projectConfig, level: "project", data: { approval_policy: "on-request" } },
		]);
	});

	test("applies matching omp settings from project config.toml", async () => {
		const agentDir = path.join(root, "agent");
		const projectConfig = path.join(project, ".codex", "config.toml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.dirname(projectConfig), { recursive: true });
		await fs.writeFile(projectConfig, 'approval_policy = "on-request"\npersonality = "friendly"\n');

		const settings = await Settings.init({ cwd: project, agentDir });

		expect(cfgPersonality.get(settings)).toBe("friendly");
	});
});
