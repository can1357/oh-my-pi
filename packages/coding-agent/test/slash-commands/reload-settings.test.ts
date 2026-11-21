import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgTemperature, cfgTopP } from "@oh-my-pi/pi-coding-agent/session/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("/reload-settings", () => {
	let state: SettingsTestState;
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let settings: Settings;
	let registry: ModelRegistry;
	let stamp = Date.now();
	const output: string[] = [];
	const config = () => dir.join("agent/config.yml");
	const models = () => dir.join("agent/models.yml");
	const writeConfig = (value: Record<string, unknown>) => Bun.write(config(), YAML.stringify(value));
	async function writeModels(baseUrl = "https://first.invalid/v1", includeFallback = true): Promise<void> {
		await Bun.write(
			models(),
			YAML.stringify({
				providers: {
					reload: {
						baseUrl,
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "active" }, ...(includeFallback ? [{ id: "fallback" }] : [])],
					},
				},
			}),
		);
		stamp += 1000;
		await fs.utimes(models(), stamp / 1000, stamp / 1000);
	}
	async function start(extra: Record<string, unknown> = {}): Promise<void> {
		await writeConfig({ temperature: 0.2, ...extra });
		await writeModels();
		settings = await Settings.init({ cwd: dir.path(), agentDir: dir.join("agent"), configFiles: [] });
		registry = new ModelRegistry(auth, models(), { settings });
		const model = registry.find("reload", "active");
		if (!model) throw new Error("Fixture model missing");
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [] } });
		session = new AgentSession({
			agent,
			modelRegistry: registry,
			settings,
			sessionManager: SessionManager.inMemory(),
		});
		// Exercise real catalog rebuilding without depending on external discovery services.
		const refresh = registry.refresh.bind(registry);
		vi.spyOn(registry, "refresh").mockImplementation(() => refresh("offline"));
	}
	async function reload(notifyConfigChanged?: () => void, name = "reload-settings"): Promise<string> {
		output.length = 0;
		const command = lookupBuiltinSlashCommand(name);
		if (!command?.handle) throw new Error("/reload-settings missing");
		const runtime: SlashCommandRuntime = {
			session,
			settings,
			sessionManager: session.sessionManager,
			cwd: dir.path(),
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyConfigChanged,
		};
		await command.handle({ name, args: "", text: name }, runtime);
		return output.join("\n");
	}

	beforeEach(() => {
		state = beginSettingsTest();
		dir = TempDir.createSync("@pi-reload-settings-");
		auth = createInMemoryAuthStorage();
	});
	afterEach(async () => {
		settings?.cancelPendingSaves();
		await session?.dispose();
		vi.restoreAllMocks();
		auth.close();
		AgentStorage.close();
		restoreSettingsTestState(state);
		await dir.remove();
	});

	it("reports and clears an edit already applied by the watcher", async () => {
		await start();
		const applied = Promise.withResolvers<void>();
		const stop = cfgTemperature.listen(settings, () => applied.resolve());
		settings.startWatching();
		try {
			await writeConfig({ temperature: 0.7 });
			await applied.promise;
			expect(session.agent.temperature).toBe(0.7);
			expect(await reload()).toContain("Applied: temperature");
			expect(await reload()).toContain("No settings changed");
		} finally {
			stop();
		}
	});

	it("strictly reloads disk edits without a watcher, including the alias", async () => {
		await start();
		await writeConfig({ temperature: 0.8 });
		expect(await reload(undefined, "reload-config")).toContain("Applied: temperature");
		expect(session.agent.temperature).toBe(0.8);
	});

	it("does not repeat ids after an unchanged reload", async () => {
		await start();
		await writeConfig({ temperature: 0.6 });
		await reload();
		const report = await reload();
		expect(report).toContain("No settings changed");
		expect(report).not.toContain("Applied:");
	});

	it("reports a malformed config.yml and preserves every previous layer", async () => {
		const projectConfig = `${getProjectAgentDir(dir.path())}/config.yml`;
		await Bun.write(projectConfig, "topP: 0.3\n");
		await start();
		await Bun.write(projectConfig, "topP: 0.9\n");
		await Bun.write(config(), "temperature: [broken");
		const notify = vi.fn();
		const report = await reload(notify);
		expect(report).toContain("config.yml");
		expect(report).toMatch(/failed|error/i);
		expect(cfgTemperature.get(settings)).toBe(0.2);
		expect(cfgTopP.get(settings)).toBe(0.3);
		expect(registry.refresh).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("re-adopts refreshed model metadata before notifying the host", async () => {
		await start();
		await writeConfig({ temperature: 0.4 });
		await writeModels("https://updated.invalid/v1");
		const notify = vi.fn(() => {
			expect(session.model?.baseUrl).toBe("https://updated.invalid/v1");
			expect(session.agent.temperature).toBe(0.4);
		});
		expect(await reload(notify)).toContain("Model catalog refreshed");
		expect(session.model?.baseUrl).toBe("https://updated.invalid/v1");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("reports malformed models.yml while retaining custom models and config changes", async () => {
		await start();
		await writeConfig({ temperature: 0.5 });
		await Bun.write(models(), "providers: [broken");
		const report = await reload();
		expect(report).toContain("models.yml");
		expect(report).toMatch(/failed|error/i);
		expect(report).toContain("Applied: temperature");
		expect(registry.getAll().some(model => model.provider === "reload" && model.id === "active")).toBe(true);
		expect(session.model?.baseUrl).toBe("https://first.invalid/v1");
	});

	it("reports removed fallback models and retracts their warnings after repair", async () => {
		await start({ retry: { fallbackChains: { default: ["reload/fallback"] } } });
		await writeModels("https://first.invalid/v1", false);
		const report = await reload();
		expect(report).toContain("role 'default'");
		expect(report).toContain("reload/fallback");
		await writeModels();
		expect(await reload()).not.toContain("unknown model: reload/fallback");
		expect(session.configWarnings).not.toContain(
			"Fallback chain for role 'default' references unknown model: reload/fallback",
		);
	});

	it("reports a missing role model", async () => {
		await start();
		await writeConfig({ temperature: 0.2, modelRoles: { smol: "reload/missing" } });
		const report = await reload();
		expect(report).toContain("smol");
		expect(report).toContain("reload/missing");
	});

	it("serializes with an in-flight watcher reload and reports each id once", async () => {
		await start();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const flush = settings.flush.bind(settings);
		vi.spyOn(settings, "flush").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			await flush();
		});
		settings.startWatching();
		await writeConfig({ temperature: 0.9 });
		await entered.promise;
		let reports = 0;
		const stop = cfgTemperature.listen(settings, () => {
			reports++;
		});
		const pending = reload();
		try {
			// The command cannot report success while a prior watcher read is held.
			await Bun.sleep(20);
			expect(output).toEqual([]);
			await writeConfig({ temperature: 0.95 });
			release.resolve();
			expect(await pending).toContain("Applied: temperature");
			expect(session.agent.temperature).toBe(0.95);
			expect(reports).toBe(1);
			expect(await reload()).toContain("No settings changed");
		} finally {
			release.resolve();
			await pending;
			stop();
		}
	});
});
