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
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
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
		// `Settings.init` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
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

	test("ignores project config.toml when the codex provider is disabled globally", async () => {
		const agentDir = path.join(root, "agent");
		const projectConfig = path.join(project, ".codex", "config.toml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.dirname(projectConfig), { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "disabledProviders:\n  - codex\n");
		await fs.writeFile(projectConfig, 'personality = "friendly"\n');

		const settings = await Settings.init({ cwd: project, agentDir });

		expect(cfgPersonality.get(settings)).toBe("default");
	});

	test("drops project config.toml on reload once the codex provider is disabled", async () => {
		const agentDir = path.join(root, "agent");
		const projectConfig = path.join(project, ".codex", "config.toml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.dirname(projectConfig), { recursive: true });
		await fs.writeFile(projectConfig, 'personality = "friendly"\n');
		const settings = await Settings.init({ cwd: project, agentDir });
		expect(cfgPersonality.get(settings)).toBe("friendly");

		await fs.writeFile(path.join(agentDir, "config.yml"), "disabledProviders:\n  - codex\n");
		await settings.reloadFromDisk();

		expect(cfgPersonality.get(settings)).toBe("default");
	});

	test("ignores a disabled provider's project config.toml after moving to that project", async () => {
		const agentDir = path.join(root, "agent");
		const elsewhere = path.join(root, "elsewhere");
		const projectConfig = path.join(project, ".codex", "config.toml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.join(elsewhere, ".git"), { recursive: true });
		await fs.mkdir(path.dirname(projectConfig), { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "disabledProviders:\n  - codex\n");
		await fs.writeFile(projectConfig, 'personality = "friendly"\n');
		const settings = await Settings.init({ cwd: elsewhere, agentDir });

		const cloned = await settings.cloneForCwd(project);
		await settings.reloadForCwd(project);

		expect(cfgPersonality.get(cloned)).toBe("default");
		expect(cfgPersonality.get(settings)).toBe("default");
	});

	test("ignores project config.toml when the project's own .omp/config.yml disables codex", async () => {
		const agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(project, ".codex", "config.toml"), 'personality = "friendly"\n');
		await Bun.write(path.join(project, ".omp", "config.yml"), "disabledProviders:\n  - codex\n");

		const settings = await Settings.init({ cwd: project, agentDir });

		expect(cfgPersonality.get(settings)).toBe("default");
	});

	test("honors a path-scoped disabledProviders entry only inside its path", async () => {
		const agentDir = path.join(root, "agent");
		const other = path.join(root, "other");
		await fs.mkdir(path.join(other, ".git"), { recursive: true });
		await Bun.write(path.join(project, ".codex", "config.toml"), 'personality = "friendly"\n');
		await Bun.write(path.join(other, ".codex", "config.toml"), 'personality = "friendly"\n');
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`disabledProviders:\n  - path: ${JSON.stringify(project)}\n    providers:\n      - codex\n`,
		);

		expect(cfgPersonality.get(await Settings.init({ cwd: project, agentDir }))).toBe("default");
		resetSettingsForTest();
		expect(cfgPersonality.get(await Settings.init({ cwd: other, agentDir }))).toBe("friendly");
	});
});
