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
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { initializeWithSettings, isProviderEnabled, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { cfgPersonality } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

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
		const release = initializeWithSettings(settings);
		try {
			expect(isProviderEnabled("codex")).toBe(false);
			await Bun.write(path.join(agentDir, "config.yml"), "{}\n");
			await settings.reloadFromDisk();
			expect(isProviderEnabled("codex")).toBe(true);
			expect(cfgPersonality.get(settings)).toBe("friendly");
		} finally {
			release();
		}
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

	test("keeps a self-disabling project provider disabled through reload and enables it after removal", async () => {
		const agentDir = path.join(root, "agent");
		const codexConfig = path.join(project, ".codex", "config.toml");
		await Bun.write(codexConfig, 'personality = "friendly"\ndisabledProviders = ["codex"]\n');
		const settings = await Settings.init({ cwd: project, agentDir });
		const release = initializeWithSettings(settings);
		try {
			expect(cfgDisabledProviders.get(settings)).toEqual(["codex"]);
			expect(isProviderEnabled("codex")).toBe(false);
			expect(cfgPersonality.get(settings)).toBe("default");

			await settings.reloadFromDisk();
			expect(cfgDisabledProviders.get(settings)).toEqual(["codex"]);
			expect(isProviderEnabled("codex")).toBe(false);
			expect(cfgPersonality.get(settings)).toBe("default");

			await Bun.write(codexConfig, 'personality = "friendly"\n');
			await settings.reloadFromDisk();
			expect(cfgDisabledProviders.get(settings)).toEqual([]);
			expect(isProviderEnabled("codex")).toBe(true);
			expect(cfgPersonality.get(settings)).toBe("friendly");

			await Bun.write(codexConfig, 'personality = "friendly"\ndisabledProviders = ["codex"]\n');
			await settings.reloadFromDisk();
			expect(cfgDisabledProviders.get(settings)).toEqual(["codex"]);
			expect(isProviderEnabled("codex")).toBe(false);
			expect(cfgPersonality.get(settings)).toBe("default");
		} finally {
			release();
		}
	});

	test.each(["global", "overlay"] as const)(
		"keeps codex project settings when an invalid %s switch is rejected by a live reload",
		async layer => {
			const agentDir = path.join(root, "agent");
			const overlay = path.join(root, "overlay.yml");
			const codexConfig = path.join(project, ".codex", "config.toml");
			await Bun.write(codexConfig, 'personality = "friendly"\n');
			if (layer === "overlay") await Bun.write(overlay, "{}\n");
			const settings = await Settings.init({
				cwd: project,
				agentDir,
				configFiles: layer === "overlay" ? [overlay] : [],
			});
			expect(cfgPersonality.get(settings)).toBe("friendly");
			const warnings = vi.spyOn(logger, "warn");
			const reloaded = Promise.withResolvers<void>();
			const stop = settings.onLayersChange(() => {
				if (warnings.mock.calls.some(([message]) => message.includes("keeping last good config"))) {
					reloaded.resolve();
				}
			});
			try {
				settings.startWatching();
				const invalid = "disabledProviders:\n  - codex\nproviders:\n  maxInFlightRequests:\n    openai: 0\n";
				const config = layer === "global" ? path.join(agentDir, "config.yml") : overlay;
				await Bun.write(config, invalid);
				await reloaded.promise;

				expect(cfgDisabledProviders.get(settings)).toEqual([]);
				expect(cfgPersonality.get(settings)).toBe("friendly");
				expect(await Bun.file(config).text()).toBe(invalid);
			} finally {
				stop();
				settings.stopWatching();
			}
		},
	);
});
