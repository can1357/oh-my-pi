import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	getDisabledProviders,
	getEnabledProviders,
	isProviderEnabled,
	setDisabledProviders,
	setEnabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { sameScopedModelCycle, toSessionScopedModels } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings, getDefault, type TtsrSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("/reload-settings slash command", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-reload-settings-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const writeSettings = (settings: Record<string, unknown>) =>
		Bun.write(configPath(), YAML.stringify(settings, null, 2));

	interface CommandCalls {
		output: Mock<(message?: string) => void>;
		notifyConfigChanged: Mock<() => void>;
		refreshModels: Mock<() => Promise<void>>;
		reloadPlugins: Mock<() => Promise<void>>;
		reapplyModelRoles: Mock<() => void>;
		reconcileBashToolSettings: Mock<() => Promise<boolean>>;
		reconcileToolSettings: Mock<() => Promise<boolean>>;
		reconcileSecretObfuscator: Mock<() => Promise<boolean>>;
		reconcileBrowserIdleClose: Mock<() => void>;
		reconcileBrowserEnabled: Mock<() => Promise<void>>;
		reconcileComputerEnabled: Mock<() => Promise<void>>;
		reconcileSharedLsp: Mock<() => void>;
		refreshSkills: Mock<() => Promise<void>>;
		refreshBaseSystemPrompt: Mock<() => Promise<void>>;
		updateTtsrSettings: Mock<(settings: unknown) => boolean>;
		setMaxRunningJobs: Mock<(value: number) => void>;
		setAdvisorEnabled: Mock<(enabled: boolean) => void>;
		setSteeringMode: Mock<(mode: "all" | "one-at-a-time", persist?: boolean) => void>;
		setServiceTierFamily: Mock<(family: "openai" | "anthropic" | "google", tier: unknown) => void>;
		agent: {
			temperature?: number;
			topP?: number;
			topK?: number;
			minP?: number;
			presencePenalty?: number;
			repetitionPenalty?: number;
			hideThinkingSummary?: boolean;
			thinkingBudgets?: Record<string, number>;
		};
	}

	async function runCommand(
		settings: Settings,
		sessionOverrides: Partial<Record<string, unknown>> = {},
		sessionManagerOverrides: Partial<Record<string, unknown>> = {},
	): Promise<CommandCalls> {
		const command = lookupBuiltinSlashCommand("reload-settings");
		expect(command).toBeDefined();
		const output = vi.fn();
		const notifyConfigChanged = vi.fn();
		const reloadPlugins = vi.fn(async () => {});
		const refreshModels = vi.fn(async () => {});
		const refreshScopedModels = vi.fn(async () => {});
		const reapplyModelRoles = vi.fn();
		const setAdvisorEnabled = vi.fn();
		const setSteeringMode = vi.fn();
		const setServiceTierFamily = vi.fn();
		const agentFields = {
			temperature: undefined as number | undefined,
			topP: undefined as number | undefined,
			topK: undefined as number | undefined,
			minP: undefined as number | undefined,
			presencePenalty: undefined as number | undefined,
			repetitionPenalty: undefined as number | undefined,
			hideThinkingSummary: false as boolean | undefined,
		};
		const session = {
			refreshModels,
			refreshScopedModels,
			reapplyModelRoles,
			isAdvisorEnabled: () => true,
			setAdvisorEnabled,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			setSteeringMode,
			setFollowUpMode: vi.fn(),
			setInterruptMode: vi.fn(),
			serviceTierByFamily: {},
			setServiceTierFamily,
			agent: agentFields,
			reconcileBashToolSettings: vi.fn(async () => true),
			reconcileToolSettings: vi.fn(async () => true),
			reconcileSecretObfuscator: vi.fn(async () => true),
			reconcileBrowserIdleClose: vi.fn(),
			reconcileBrowserEnabled: vi.fn(async () => {}),
			reconcileComputerEnabled: vi.fn(async () => {}),
			reconcileSharedLsp: vi.fn(),
			refreshSkills: vi.fn(async () => {}),
			refreshBaseSystemPrompt: vi.fn(async () => {}),
			updateTtsrSettings: vi.fn(() => false),
			ttsrManager: undefined,
			asyncJobManager: { setMaxRunningJobs: vi.fn() },
			...sessionOverrides,
		};
		const runtime = {
			session,
			sessionManager: {
				getAdditionalDirectories: vi.fn(() => []),
				addWorkspaceDirectory: vi.fn(async () => null),
				removeWorkspaceDirectory: vi.fn(async () => null),
				isSessionSuppliedDirectory: vi.fn(() => false),
				...sessionManagerOverrides,
			},
			settings,
			cwd: projectDir,
			output,
			refreshCommands: async () => {},
			reloadPlugins,
			notifyConfigChanged,
		} as unknown as SlashCommandRuntime;
		await command!.handle?.({ name: "reload-settings", args: "", text: "/reload-settings" }, runtime);
		return {
			output,
			notifyConfigChanged,
			reloadPlugins,
			refreshModels: session.refreshModels as unknown as Mock<() => Promise<void>>,
			reapplyModelRoles: session.reapplyModelRoles as unknown as Mock<() => void>,
			setAdvisorEnabled,
			setSteeringMode,
			setServiceTierFamily,
			reconcileBashToolSettings: session.reconcileBashToolSettings as unknown as Mock<() => Promise<boolean>>,
			reconcileToolSettings: session.reconcileToolSettings as unknown as Mock<() => Promise<boolean>>,
			reconcileSecretObfuscator: session.reconcileSecretObfuscator as unknown as Mock<() => Promise<boolean>>,
			reconcileBrowserIdleClose: session.reconcileBrowserIdleClose as unknown as Mock<() => void>,
			reconcileBrowserEnabled: session.reconcileBrowserEnabled as unknown as Mock<() => Promise<void>>,
			reconcileComputerEnabled: session.reconcileComputerEnabled as unknown as Mock<() => Promise<void>>,
			reconcileSharedLsp: session.reconcileSharedLsp as unknown as Mock<() => void>,
			refreshSkills: session.refreshSkills as unknown as Mock<() => Promise<void>>,
			refreshBaseSystemPrompt: session.refreshBaseSystemPrompt as unknown as Mock<() => Promise<void>>,
			updateTtsrSettings: session.updateTtsrSettings as unknown as Mock<(settings: unknown) => boolean>,
			setMaxRunningJobs: session.asyncJobManager.setMaxRunningJobs as unknown as Mock<(value: number) => void>,
			agent: agentFields,
		};
	}

	it("applies an on-disk edit and reports the changed setting", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("advisor.syncBacklog")).toBe("1");

		await writeSettings({ advisor: { syncBacklog: "3" } });
		const { output, notifyConfigChanged } = await runCommand(settings);

		expect(settings.get("advisor.syncBacklog")).toBe("3");
		expect(output).toHaveBeenCalledWith(expect.stringContaining("advisor.syncBacklog"));
		expect(notifyConfigChanged).toHaveBeenCalled();
	});

	it("reports when nothing effectively changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { output } = await runCommand(settings);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("No effective values changed"));
	});

	it("refreshes the model catalog from a live models.yml edit", async () => {
		const modelsPath = path.join(agentDir, "models.yml");
		const writeModels = (withAdded: boolean) =>
			Bun.write(
				modelsPath,
				YAML.stringify({
					providers: {
						liveprov: {
							baseUrl: "https://example.invalid/v1",
							api: "openai-completions",
							apiKey: "sk-test",
							models: [
								{ id: "alpha-base", name: "Alpha Base" },
								...(withAdded ? [{ id: "alpha-added", name: "Alpha Added" }] : []),
							],
						},
					},
				}),
			);
		await writeModels(false);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const idsBefore = registry.getAvailable().map(model => model.id);
			expect(idsBefore).toContain("alpha-base");
			expect(idsBefore).not.toContain("alpha-added");

			// Static reloads are mtime-gated; stamp a distinct mtime instead of
			// sleeping, so the rewrite deterministically passes the gate.
			await writeModels(true);
			const bumped = new Date(Date.now() + 60_000);
			fs.utimesSync(modelsPath, bumped, bumped);
			await registry.refresh("online-if-uncached");

			const idsAfter = registry.getAvailable().map(model => model.id);
			expect(idsAfter).toContain("alpha-base");
			expect(idsAfter).toContain("alpha-added");
		} finally {
			authStorage.close();
		}
	});

	it("tells the session to refresh its model catalog after a config reload", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { refreshModels, output } = await runCommand(settings);
		expect(refreshModels).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("No effective values changed"));
	});

	it("reloads settings before refreshing the catalog so provider discovery sees the new disabled set", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const reloadSpy = vi.spyOn(settings, "reloadFromDisk");

		const { refreshModels } = await runCommand(settings);
		expect(reloadSpy.mock.invocationCallOrder[0]).toBeLessThan(refreshModels.mock.invocationCallOrder[0]);
	});

	it("re-resolves role consumers after the catalog refresh", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { refreshModels, reapplyModelRoles } = await runCommand(settings);
		expect(reapplyModelRoles).toHaveBeenCalled();
		expect(reapplyModelRoles.mock.invocationCallOrder[0]).toBeGreaterThan(refreshModels.mock.invocationCallOrder[0]);
	});

	it("reconciles session-owned advisor and queue-mode settings without promoting them into config", async () => {
		await writeSettings({ advisor: { enabled: false, syncBacklog: "1" }, steeringMode: "one-at-a-time" });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { enabled: true, syncBacklog: "1" }, steeringMode: "all" });
		const setSpy = vi.spyOn(settings, "set");

		const { setAdvisorEnabled, setSteeringMode, output } = await runCommand(settings, {
			isAdvisorEnabled: () => false,
			steeringMode: "one-at-a-time",
		});
		expect(setAdvisorEnabled).toHaveBeenCalledWith(true);
		expect(setSteeringMode).toHaveBeenCalledWith("all", false);
		for (const [key] of setSpy.mock.calls) {
			expect(["steeringMode", "followUpMode", "interruptMode"]).not.toContain(key);
		}
		expect(output).toHaveBeenCalledWith(expect.stringContaining("advisor.enabled"));
	});

	it("reports a malformed models.yml instead of claiming success", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { refreshModels, output } = await runCommand(settings, {
			refreshModels: vi.fn(async () => {
				throw new Error("models.yml failed to load: boom");
			}),
		});
		expect(refreshModels).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("failed to load: boom"));
	});

	it("never installs layers older than a mutation that lands mid-reload", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const reload = settings.reloadFromDisk();
		settings.set("advisor.syncBacklog", "3");
		await reload;

		expect(settings.get("advisor.syncBacklog")).toBe("3");
		const onDisk = YAML.parse(await Bun.file(configPath()).text());
		expect((onDisk as { advisor: { syncBacklog: string } }).advisor.syncBacklog).toBe("3");
	});
	it("reapplies a changed service tier to the live session", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, tier: { openai: "priority" } });

		const { setServiceTierFamily, output } = await runCommand(settings);
		expect(setServiceTierFamily).toHaveBeenCalledWith("openai", "priority");
		expect(output).toHaveBeenCalledWith(expect.stringContaining("tier.openai"));
	});

	it("clears a service tier when its setting becomes empty", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, tier: { openai: "priority" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const setServiceTierFamily = vi.fn();
		await writeSettings({ advisor: { syncBacklog: "1" } });

		const { output } = await runCommand(settings, {
			serviceTierByFamily: { openai: "priority" },
			setServiceTierFamily,
		});
		expect(setServiceTierFamily).toHaveBeenCalledWith("openai", undefined);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("tier.openai"));
	});

	it("preserves a session-only service tier when a different family's tier changes", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, tier: { openai: "flex" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, tier: { openai: "priority" } });

		// Session-only /fast override on anthropic; tier.anthropic is untouched on disk.
		const { setServiceTierFamily } = await runCommand(settings, {
			serviceTierByFamily: { anthropic: "priority" },
		});
		expect(setServiceTierFamily).toHaveBeenCalledWith("openai", "priority");
		expect(setServiceTierFamily.mock.calls.some(([family]) => family === "anthropic")).toBe(false);
	});

	it("reconciles the live bash tool when an async-execution setting changes", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, async: { enabled: false } });

		const { reconcileBashToolSettings, output } = await runCommand(settings);
		expect(reconcileBashToolSettings).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("async.enabled"));
	});

	it("leaves the bash tool alone when no async-execution setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { reconcileBashToolSettings } = await runCommand(settings);
		expect(reconcileBashToolSettings).not.toHaveBeenCalled();
	});

	it("reconciles the live read and write tools when a tool setting changes", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, read: { defaultLimit: 300 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, read: { defaultLimit: 1000 } });

		const { reconcileToolSettings, output } = await runCommand(settings);
		expect(reconcileToolSettings).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("read.defaultLimit"));
	});

	it("leaves the read and write tools alone when no tool setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { reconcileToolSettings } = await runCommand(settings);
		expect(reconcileToolSettings).not.toHaveBeenCalled();
	});

	it("rebuilds the secret obfuscator when secrets.enabled flips on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, secrets: { enabled: true } });

		const { reconcileSecretObfuscator } = await runCommand(settings);
		expect(reconcileSecretObfuscator).toHaveBeenCalledTimes(1);
	});

	it("leaves the secret obfuscator alone when secrets.enabled is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, secrets: { enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, secrets: { enabled: true } });

		const { reconcileSecretObfuscator } = await runCommand(settings);
		expect(reconcileSecretObfuscator).not.toHaveBeenCalled();
	});

	it("installs the reloaded thinking budgets on the live agent", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, thinkingBudgets: { high: 16384 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, thinkingBudgets: { high: 24576 } });

		const { agent } = await runCommand(settings);
		expect(agent.thinkingBudgets?.high).toBe(24576);
	});

	it("re-arms the owned browser idle-close deadline when browser.idleCloseSec changes", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { idleCloseSec: 30 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { idleCloseSec: 0 } });

		const { reconcileBrowserIdleClose } = await runCommand(settings);
		expect(reconcileBrowserIdleClose).toHaveBeenCalledTimes(1);
	});

	it("reconciles the browser MCP filter when browser.enabled flips on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { enabled: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { enabled: true } });

		const { reconcileBrowserEnabled, reconcileComputerEnabled } = await runCommand(settings);
		expect(reconcileBrowserEnabled).toHaveBeenCalledTimes(1);
		expect(reconcileComputerEnabled).not.toHaveBeenCalled();
	});

	it("leaves the browser MCP filter alone when browser.enabled is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { enabled: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, browser: { enabled: false } });

		const { reconcileBrowserEnabled } = await runCommand(settings);
		expect(reconcileBrowserEnabled).not.toHaveBeenCalled();
	});

	it("reconciles the base prompt when computer.enabled flips on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, computer: { enabled: true } });

		const { reconcileComputerEnabled, reconcileBrowserEnabled } = await runCommand(settings);
		expect(reconcileComputerEnabled).toHaveBeenCalledTimes(1);
		expect(reconcileBrowserEnabled).not.toHaveBeenCalled();
	});

	it("leaves the base prompt alone when computer.enabled is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, computer: { enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, computer: { enabled: true } });

		const { reconcileComputerEnabled } = await runCommand(settings);
		expect(reconcileComputerEnabled).not.toHaveBeenCalled();
	});

	it("re-applies the shared LSP flag when lsp.shared flips on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, lsp: { shared: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, lsp: { shared: true } });

		const { reconcileSharedLsp } = await runCommand(settings);
		expect(reconcileSharedLsp).toHaveBeenCalledTimes(1);
	});

	it("leaves the shared LSP flag alone when lsp.shared is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, lsp: { shared: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, lsp: { shared: false } });

		const { reconcileSharedLsp } = await runCommand(settings);
		expect(reconcileSharedLsp).not.toHaveBeenCalled();
	});

	it("refreshes skills when a skills.* setting changes on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, skills: { enableCodexUser: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, skills: { enableCodexUser: true } });

		const { refreshSkills, refreshBaseSystemPrompt, output } = await runCommand(settings);
		expect(refreshSkills).toHaveBeenCalledTimes(1);
		// refreshSkills rebuilds the base prompt as part of its pass; a second
		// direct rebuild in the same reload would be redundant work.
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("skills.enableCodexUser"));
	});

	it("leaves skills alone when no skills.* setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, skills: { enableCodexUser: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// An unrelated effective change still reloads; only skills.* keys may
		// trigger the capability reset and filesystem re-read.
		await writeSettings({ advisor: { syncBacklog: "3" }, skills: { enableCodexUser: false } });

		const { refreshSkills } = await runCommand(settings);
		expect(refreshSkills).not.toHaveBeenCalled();
	});

	it("pushes a reloaded ttsr manager setting into the live manager", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { repeatGap: 10 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { repeatGap: 25 } });

		const { updateTtsrSettings } = await runCommand(settings);
		expect(updateTtsrSettings).toHaveBeenCalledTimes(1);
		expect(updateTtsrSettings).toHaveBeenCalledWith(settings.getGroup("ttsr"));
	});

	it("leaves the ttsr manager alone when only a bucketing-only ttsr key changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { builtinRules: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// builtinRules/disabledRules are re-read by bucketRules on every reload;
		// the manager consumes none of them, so they must not wake it.
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { builtinRules: false } });

		const { updateTtsrSettings } = await runCommand(settings);
		expect(updateTtsrSettings).not.toHaveBeenCalled();
	});

	it("rebuilds the base prompt when prompt-affecting settings change on disk", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			skillful: true,
			personality: "default",
			task: { batch: true },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			skillful: false,
			personality: "pragmatic",
			task: { batch: false },
		});

		const { refreshBaseSystemPrompt, refreshSkills, output } = await runCommand(settings);
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(refreshSkills).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("skillful"));
		expect(output).toHaveBeenCalledWith(expect.stringContaining("task.batch"));
	});

	it("rebuilds the base prompt when only secrets.enabled changes on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, secrets: { enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, secrets: { enabled: false } });

		const { refreshBaseSystemPrompt, reconcileSecretObfuscator, output } = await runCommand(settings);
		// The handler reconciles the obfuscator first, then PROMPT_KEYS routes
		// the flip into the prompt rebuild, so the guidance about opaque tokens
		// tracks the gate without a restart.
		expect(reconcileSecretObfuscator).toHaveBeenCalledTimes(1);
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("secrets.enabled"));
	});

	it("leaves the base prompt alone when no prompt-affecting setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, skillful: true });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "3" }, skillful: true });

		const { refreshBaseSystemPrompt } = await runCommand(settings);
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	it("rebuilds the prompt once when skills and prompt settings change together", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			skillful: true,
			skills: { enableCodexUser: false },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			skillful: false,
			skills: { enableCodexUser: true },
		});

		const { refreshSkills, refreshBaseSystemPrompt } = await runCommand(settings);
		expect(refreshSkills).toHaveBeenCalledTimes(1);
		// The skills path already picks up the prompt-affecting key, so the
		// combined reload must not stack a direct rebuild on top of it.
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	it("re-seeds the capability provider sets when disabledProviders changes", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });

		const disabledBefore = getDisabledProviders();
		const enabledBefore = getEnabledProviders();
		try {
			const { output } = await runCommand(settings);
			expect(output).toHaveBeenCalledWith(expect.stringContaining("disabledProviders"));
			expect(isProviderEnabled("cap-reload-test")).toBe(false);
			expect(getDisabledProviders()).toContain("cap-reload-test");
		} finally {
			// The module sets are process-global; restore whatever this test found.
			setDisabledProviders(disabledBefore);
			setEnabledProviders(enabledBefore);
		}
	});

	it("leaves the capability provider sets alone when neither provider list changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });

		// The harness never seeds the module sets, so an unconditional reconcile
		// here would seed "cap-reload-test" from the reloaded settings.
		const disabledBefore = getDisabledProviders();
		const enabledBefore = getEnabledProviders();
		await runCommand(settings);
		expect(getDisabledProviders()).toEqual(disabledBefore);
		expect(getEnabledProviders()).toEqual(enabledBefore);
	});

	it("pushes a changed async.maxJobs into the live job manager", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, async: { maxJobs: 4 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, async: { maxJobs: 7 } });

		const { setMaxRunningJobs, reconcileBashToolSettings } = await runCommand(settings);
		expect(setMaxRunningJobs).toHaveBeenCalledWith(7);
		expect(reconcileBashToolSettings).not.toHaveBeenCalled();
	});

	it("leaves the job manager alone when async.maxJobs is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, async: { maxJobs: 4 } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { setMaxRunningJobs } = await runCommand(settings);
		expect(setMaxRunningJobs).not.toHaveBeenCalled();
	});

	it("reconciles agent-owned request options without persisting them", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, temperature: -1, omitThinking: false });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, temperature: 0.7, omitThinking: true });
		const setSpy = vi.spyOn(settings, "set");

		const { agent } = await runCommand(settings);
		expect(agent.temperature).toBe(0.7);
		expect(agent.hideThinkingSummary).toBe(true);
		for (const [key] of setSpy.mock.calls) {
			expect(["temperature", "omitThinking"]).not.toContain(key);
		}
	});

	it("runs the full reload through the TUI adapter without aborting", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			autocompleteMaxVisible: 7,
			compaction: { idleThresholdTokens: 120000 },
			recap: { idleSeconds: 45 },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// Only ids this rewrite changes on disk may replay; unchanged ids must
		// leave their live consumers (including session-only overrides) alone.
		await writeSettings({
			advisor: { syncBacklog: "1" },
			autocompleteMaxVisible: 9,
			compaction: { idleThresholdTokens: 180000 },
			recap: { idleSeconds: 75 },
		});
		const editorSetAutocomplete = vi.fn();
		const ctx = {
			session: {
				refreshModels: vi.fn(async () => {}),
				reapplyModelRoles: vi.fn(),
				isAdvisorEnabled: () => true,
				setAdvisorEnabled: vi.fn(),
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				interruptMode: "wait",
				setSteeringMode: vi.fn(),
				setFollowUpMode: vi.fn(),
				setInterruptMode: vi.fn(),
				setThinkingLevel: vi.fn(),
				refreshBaseSystemPrompt: vi.fn(async () => {}),
				applyMemoryBackend: vi.fn(async () => {}),
				setThinkToolEnabled: vi.fn(async () => {}),
				reconcileSecretObfuscator: vi.fn(async () => true),
				reconcileBrowserIdleClose: vi.fn(),
				reconcileBrowserEnabled: vi.fn(async () => {}),
				reconcileComputerEnabled: vi.fn(async () => {}),
				reconcileSharedLsp: vi.fn(),
				refreshSkills: vi.fn(async () => {}),
				updateTtsrSettings: vi.fn(() => false),
				ttsrManager: undefined,
				setAutoCompactionEnabled: vi.fn(),
				serviceTierByFamily: {},
				setServiceTierFamily: vi.fn(),
				agent: {},
			},
			sessionManager: {
				getCwd: () => projectDir,
				getAdditionalDirectories: vi.fn(() => []),
				setAdditionalDirectories: vi.fn(async () => {}),
				isSessionSuppliedDirectory: vi.fn(() => false),
			},
			settings,
			ui: {
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				clearInlineImages: vi.fn(),
				setResizeScrollback: vi.fn(),
				resetDisplay: vi.fn(),
				setMaxInlineImages: vi.fn(),
				setShowHardwareCursor: vi.fn(),
			},
			editor: {
				setText: vi.fn(),
				setAutocompleteMaxVisible: editorSetAutocomplete,
				setImeSafeCursorLayout: vi.fn(),
				setUseTerminalCursor: vi.fn(),
			},
			syncEditorSpelling: vi.fn(),
			syncComposerShape: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			effectiveHideThinkingBlock: false,
			hideToolActivity: false,
			toolOutputExpanded: false,
			showError: vi.fn(),
			statusLine: {
				invalidate: vi.fn(),
				setAutoCompactEnabled: vi.fn(),
				updateSettings: vi.fn(),
			},
			eventController: {
				refreshIdleCompactionTimer: vi.fn(),
				refreshIdleRecapTimer: vi.fn(),
			},
			chatContainer: { children: [], setToolActivityVisible: vi.fn() },
			showStatus: vi.fn(),
			refreshSlashCommandState: vi.fn(),
		};
		const result = await executeBuiltinSlashCommand("/reload-settings", { ctx } as never);
		expect(result).toBe(true);
		expect(editorSetAutocomplete).toHaveBeenCalledWith(9);
		// Idle timers cache their delay and captured threshold, so the reload
		// must re-arm them or a disabled task can still fire.
		expect(ctx.eventController.refreshIdleCompactionTimer).toHaveBeenCalled();
		expect(ctx.eventController.refreshIdleRecapTimer).toHaveBeenCalled();
		// A blanket replay would push the settings default onto the session and
		// reset a session-only Shift+Tab model-control thinking level.
		expect(ctx.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("re-resolves the settings-derived model scope and reports it", async () => {
		await writeSettings({ enabledModels: ["liveprov/alpha-base"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const refreshScopedModels = vi.fn(async () => true);
		const { output } = await runCommand(settings, { refreshScopedModels });

		expect(refreshScopedModels).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Model scope re-resolved."));
	});

	it("reports a scope-refresh failure without losing the reload result", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "3" } });

		const { output } = await runCommand(settings, {
			refreshScopedModels: vi.fn(async () => {
				throw new Error("scope exploded");
			}),
		});

		expect(output).toHaveBeenCalledWith(expect.stringContaining("advisor.syncBacklog"));
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Model scope refresh failed: scope exploded"));
	});

	it("re-resolves the scope only after the reloaded settings take effect", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			enabledModels: ["liveprov/alpha-base"],
		});

		let seenDuringScopeRefresh: unknown;
		await runCommand(settings, {
			refreshScopedModels: vi.fn(async () => {
				seenDuringScopeRefresh = settings.get("enabledModels");
				return false;
			}),
		});

		// A pre-reload resolution would observe the stale empty list.
		expect(seenDuringScopeRefresh).toEqual(["liveprov/alpha-base"]);
	});
	it("rebuilds the base prompt when tools.xdevInlineDevices changes on disk", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			tools: { xdevDocs: "builtins", xdevInlineDevices: ["dev-a"] },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			tools: { xdevDocs: "builtins", xdevInlineDevices: ["dev-a", "dev-b"] },
		});

		const { refreshBaseSystemPrompt, output } = await runCommand(settings);
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("tools.xdevInlineDevices"));
	});

	it("refreshes skills when a capability provider filter changes on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			disabledProviders: ["cap-reload-test", "cap-skill-probe"],
		});

		const disabledBefore = getDisabledProviders();
		const enabledBefore = getEnabledProviders();
		try {
			const { refreshSkills, refreshBaseSystemPrompt, output } = await runCommand(settings);
			// Skills loaded through the old provider sets keep their filtered
			// content until a capability refresh; refreshSkills rebuilds the base
			// prompt in the same pass, so no second direct rebuild may stack on.
			expect(refreshSkills).toHaveBeenCalledTimes(1);
			expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
			expect(output).toHaveBeenCalledWith(expect.stringContaining("disabledProviders"));
		} finally {
			// The module sets are process-global; restore whatever this test found.
			setDisabledProviders(disabledBefore);
			setEnabledProviders(enabledBefore);
		}
	});

	it("leaves skills alone when no capability provider filter changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledProviders: ["cap-reload-test"] });

		const { refreshSkills } = await runCommand(settings);
		expect(refreshSkills).not.toHaveBeenCalled();
	});

	it("reports construction-only settings as restart-required instead of applied", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			providers: { kimiApiFormat: "auto" },
			tools: { format: "auto", abortOnFabricatedResult: false },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "2" },
			providers: { kimiApiFormat: "anthropic" },
			tools: { format: "xml", abortOnFabricatedResult: true },
		});

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// kimiApiFormat/openaiWebsockets/tools.format/abortOnFabricatedResult
		// snapshot into private Agent fields at construction with no live setter:
		// reporting them as applied would be false — they need a restart.
		expect(appliedSection).not.toContain("kimiApiFormat");
		expect(appliedSection).not.toContain("tools.format");
		expect(appliedSection).not.toContain("abortOnFabricatedResult");
		expect(restartSection).toContain("providers.kimiApiFormat");
		expect(restartSection).toContain("tools.format");
		expect(restartSection).toContain("tools.abortOnFabricatedResult");
	});

	it("reports media-tool gates as restart-required instead of applied", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "2" },
			generate_image: { enabled: true },
			speechgen: { enabled: true },
		});

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		// Control: a live-appliable key changed in the same reload still
		// reports as applied.
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// sdk.ts registers generate_image and the TTS tool only while building
		// the initial custom-tools registry; no reload reconciler mounts or
		// unmounts them, so reporting applied would be false until restart.
		expect(appliedSection).not.toContain("generate_image.enabled");
		expect(appliedSection).not.toContain("speechgen.enabled");
		expect(restartSection).toContain("generate_image.enabled");
		expect(restartSection).toContain("speechgen.enabled");
	});
	it("applies a persisted value that appears over a host-default override", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// Mirror the ACP/RPC startup applier: an unconfigured host-defaulted path
		// gets a fabricated runtime override of the schema default, which shadows
		// every layer until an explicit persisted value appears.
		const hostDefault = getDefault("memories.enabled");
		settings.overrideHostDefault("memories.enabled", hostDefault);

		const persisted = !hostDefault;
		await writeSettings({ advisor: { syncBacklog: "2" }, memories: { enabled: persisted } });
		const { output } = await runCommand(settings);

		expect(settings.get("memories.enabled")).toBe(persisted);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("memories.enabled"));
	});

	it("re-buckets ttsr rules when ttsr.enabled flips on during reload", async () => {
		const rulesDir = path.join(projectDir, ".agents", "rules");
		fs.mkdirSync(rulesDir, { recursive: true });
		await Bun.write(
			path.join(rulesDir, "reload-rebucket-fixture.md"),
			[
				"---",
				'description: "Reload rebucket fixture"',
				'condition: "REBUCKET-BOOM-"',
				"---",
				"",
				"Fixture body.",
				"",
			].join("\n"),
		);
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// Session-construction parity: bucketRules ran while the manager was
		// disabled, so the conditional fixture was never registered.
		const manager = new TtsrManager(settings.getGroup("ttsr"));
		expect(manager.getRules().map(rule => rule.name)).not.toContain("reload-rebucket-fixture");
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: true } });

		await runCommand(settings, {
			ttsrManager: manager,
			updateTtsrSettings: (group: unknown) => manager.updateSettings(group as TtsrSettings),
		});

		// Flipping ttsr.enabled on must re-run discovery + bucketRules; updating
		// the manager settings alone leaves the rule map empty.
		expect(manager.getRules().map(rule => rule.name)).toContain("reload-rebucket-fixture");
	});

	it("drops a ttsr rule disabled by ttsr.disabledRules during reload", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const manager = new TtsrManager(settings.getGroup("ttsr"));
		const seeded = {
			name: "reload-rebucket-seeded",
			path: "/fixture/reload-rebucket-seeded.md",
			content: "seeded",
			condition: ["REBUCKET-SEEDED-"],
			_source: createSourceMeta("fixture", "/fixture/reload-rebucket-seeded.md", "project"),
		} as Rule;
		expect(manager.addRule(seeded)).toBe(true);
		await writeSettings({
			advisor: { syncBacklog: "1" },
			ttsr: { enabled: true, disabledRules: ["reload-rebucket-seeded"] },
		});

		await runCommand(settings, {
			ttsrManager: manager,
			updateTtsrSettings: (group: unknown) => manager.updateSettings(group as TtsrSettings),
		});

		// The reload replaces the active rule set, so the seeded registration
		// must not survive a disabledRules entry naming it.
		expect(manager.getRules().map(rule => rule.name)).not.toContain("reload-rebucket-seeded");
	});

	it("runs the plugin reload pipeline when an extensions setting changes on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledExtensions: ["extension-module:legacy"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledExtensions: [] });

		const { reloadPlugins } = await runCommand(settings);
		expect(reloadPlugins).toHaveBeenCalledTimes(1);
	});

	it("leaves the plugin pipeline alone when no extensions setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, disabledExtensions: ["extension-module:legacy"] });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { reloadPlugins } = await runCommand(settings);
		expect(reloadPlugins).not.toHaveBeenCalled();
	});

	it("runs the plugin reload pipeline when only mcp.enableProjectConfig changes on disk", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, mcp: { enableProjectConfig: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, mcp: { enableProjectConfig: false } });

		const { output, reloadPlugins } = await runCommand(settings);
		// Initial MCP discovery snapshots the flag into the manager; the reload
		// pipeline's MCP re-discovery is what re-reads it live, so the flip must
		// route through reloadPlugins instead of being reported applied with no
		// rediscovery.
		expect(reloadPlugins).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Applied: mcp.enableProjectConfig"));
	});

	it("reports construction-only tool enablement as restart-required instead of applied", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			bash: { enabled: true },
			grep: { enabled: true },
			todo: { enabled: true },
			autolearn: { enabled: true },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "2" },
			bash: { enabled: false },
			grep: { enabled: false },
			todo: { enabled: false },
			autolearn: { enabled: false },
		});

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		// Control: a live-appliable key changed in the same reload still
		// reports as applied.
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// isToolAllowed filters these once in createTools() and no live
		// registry rebuild exists, so claiming them applied would be false.
		for (const key of ["bash.enabled", "grep.enabled", "todo.enabled", "autolearn.enabled"]) {
			expect(appliedSection).not.toContain(key);
			expect(restartSection).toContain(key);
		}
	});

	it("reports includeWorkspaceTree as restart-required instead of applied", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, includeWorkspaceTree: false });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "2" }, includeWorkspaceTree: true });

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		// Control: a live-appliable key changed in the same reload still
		// reports as applied.
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// sdk.ts builds workspaceTreePromise from the startup flag and the
		// prompt closure keeps a construction-time copy; no live rebuild exists.
		expect(appliedSection).not.toContain("includeWorkspaceTree");
		expect(restartSection).toContain("includeWorkspaceTree");
	});

	it("reports snapcompact inline settings as restart-required instead of applied", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			snapcompact: { systemPrompt: "none", toolResults: false, shape: "auto" },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "2" },
			snapcompact: { systemPrompt: "all", toolResults: true, shape: "8x8r-bw" },
		});

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// SnapcompactInlineTransformer is constructed once from the startup
		// group; its render modes and shape never re-read settings.
		for (const key of ["snapcompact.systemPrompt", "snapcompact.toolResults", "snapcompact.shape"]) {
			expect(appliedSection).not.toContain(key);
			expect(restartSection).toContain(key);
		}
	});

	it("reports captured prompt controls as restart-required instead of applied", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			inlineToolDescriptors: "auto",
			tools: { intentTracing: true },
			task: { eager: "default" },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "2" },
			inlineToolDescriptors: "off",
			tools: { intentTracing: false },
			task: { eager: "always" },
		});

		const { output } = await runCommand(settings);
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		expect(appliedSection).toContain("Applied: advisor.syncBacklog");
		// The prompt rebuild reads the captured closure constants, not the live
		// settings, and the first two also snapshot into private Agent fields.
		for (const key of ["inlineToolDescriptors", "tools.intentTracing", "task.eager"]) {
			expect(appliedSection).not.toContain(key);
			expect(restartSection).toContain(key);
		}
	});

	it("reports ttsr bucketing keys as restart-required while the rebucket still applies", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const manager = new TtsrManager(settings.getGroup("ttsr"));
		const seeded = {
			name: "reload-restart-required",
			path: "/fixture/reload-restart-required.md",
			content: "seeded",
			condition: ["RESTART-REQUIRED-"],
			_source: createSourceMeta("fixture", "/fixture/reload-restart-required.md", "project"),
		} as Rule;
		expect(manager.addRule(seeded)).toBe(true);
		await writeSettings({
			advisor: { syncBacklog: "1" },
			ttsr: { enabled: true, disabledRules: ["reload-restart-required"] },
		});

		const { output } = await runCommand(settings, {
			ttsrManager: manager,
			updateTtsrSettings: (group: unknown) => manager.updateSettings(group as TtsrSettings),
		});

		// Stream matching still sees the re-bucket: the disabled rule must be
		// gone from the live manager even though the report defers the prompt
		// half to a restart.
		expect(manager.getRules().map(rule => rule.name)).not.toContain("reload-restart-required");
		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		expect(appliedSection).not.toContain("ttsr.disabledRules");
		expect(restartSection).toContain("ttsr.disabledRules");
	});

	it("reports ttsr.enabled as restart-required because its gate shifts the prompt buckets", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: false } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, ttsr: { enabled: true } });

		const { output } = await runCommand(settings);

		const messages = output.mock.calls.map(call => String(call[0]));
		const message = messages.find(text => text.includes("Applied:") || text.includes("Restart required:"));
		if (!message) throw new Error("Expected a reload result message");
		const [appliedSection, restartSection] = message.split(" Restart required:");
		expect(appliedSection).not.toContain("ttsr.enabled");
		expect(restartSection).toContain("ttsr.enabled");
	});

	it("awaits async setting replays before reporting the reload applied", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, personality: "default" });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" }, personality: "pragmatic" });

		let release!: () => void;
		const gated = new Promise<void>(resolve => {
			release = resolve;
		});
		const replayStarted = Promise.withResolvers<void>();
		let promptRefreshFinished = false;
		let appliedSeen = false;
		const ctx = {
			session: {
				refreshModels: vi.fn(async () => {}),
				reapplyModelRoles: vi.fn(),
				isAdvisorEnabled: () => true,
				setAdvisorEnabled: vi.fn(),
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				interruptMode: "wait",
				setSteeringMode: vi.fn(),
				setFollowUpMode: vi.fn(),
				setInterruptMode: vi.fn(),
				setThinkingLevel: vi.fn(),
				refreshBaseSystemPrompt: vi.fn(async () => {
					replayStarted.resolve();
					await gated;
					promptRefreshFinished = true;
				}),
				applyMemoryBackend: vi.fn(async () => {}),
				setThinkToolEnabled: vi.fn(async () => {}),
				reconcileSecretObfuscator: vi.fn(async () => true),
				reconcileBrowserIdleClose: vi.fn(),
				reconcileBrowserEnabled: vi.fn(async () => {}),
				reconcileComputerEnabled: vi.fn(async () => {}),
				reconcileSharedLsp: vi.fn(),
				refreshSkills: vi.fn(async () => {}),
				updateTtsrSettings: vi.fn(() => false),
				ttsrManager: undefined,
				setAutoCompactionEnabled: vi.fn(),
				serviceTierByFamily: {},
				setServiceTierFamily: vi.fn(),
				agent: {},
			},
			sessionManager: {
				getCwd: () => projectDir,
				getAdditionalDirectories: vi.fn(() => []),
				setAdditionalDirectories: vi.fn(async () => {}),
				isSessionSuppliedDirectory: vi.fn(() => false),
			},
			settings,
			ui: {
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				clearInlineImages: vi.fn(),
				setResizeScrollback: vi.fn(),
				resetDisplay: vi.fn(),
				setMaxInlineImages: vi.fn(),
				setShowHardwareCursor: vi.fn(),
			},
			editor: {
				setText: vi.fn(),
				setAutocompleteMaxVisible: vi.fn(),
				setImeSafeCursorLayout: vi.fn(),
				setUseTerminalCursor: vi.fn(),
			},
			syncEditorSpelling: vi.fn(),
			syncComposerShape: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			effectiveHideThinkingBlock: false,
			hideToolActivity: false,
			toolOutputExpanded: false,
			showError: vi.fn(),
			statusLine: {
				invalidate: vi.fn(),
				setAutoCompactEnabled: vi.fn(),
				updateSettings: vi.fn(),
			},
			eventController: {
				refreshIdleCompactionTimer: vi.fn(),
				refreshIdleRecapTimer: vi.fn(),
			},
			chatContainer: { children: [], setToolActivityVisible: vi.fn() },
			showStatus: vi.fn((text: string) => {
				if (text.includes("Applied:")) appliedSeen = true;
			}),
			refreshSlashCommandState: vi.fn(),
		};

		const done = executeBuiltinSlashCommand("/reload-settings", { ctx } as never);
		// Deterministic drain (event-loop boundaries, no wall-clock): a
		// fire-and-forget replay lets the command run to its output here, while
		// the fixed path stays parked on the gated prompt rebuild.
		await replayStarted.promise;
		for (let hop = 0; hop < 20; hop++) await new Promise<void>(resolve => setImmediate(resolve));
		const appliedWhileGated = appliedSeen;
		release();
		await done;

		expect(promptRefreshFinished).toBe(true);
		expect(appliedWhileGated).toBe(false);
		expect(appliedSeen).toBe(true);
	});
	it("adds only the settings workspace delta and keeps session-added roots", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only"] },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only", "/settings/added"] },
		});

		const addWorkspaceDirectory = vi.fn(async () => "/settings/added");
		const removeWorkspaceDirectory = vi.fn(async () => null);
		const { refreshBaseSystemPrompt } = await runCommand(
			settings,
			{},
			{
				// The live merged list also carries a session-added --add-dir root.
				getAdditionalDirectories: vi.fn(() => ["/settings/only", "/session/added"]),
				addWorkspaceDirectory,
				removeWorkspaceDirectory,
			},
		);

		expect(addWorkspaceDirectory).toHaveBeenCalledTimes(1);
		expect(addWorkspaceDirectory).toHaveBeenCalledWith("/settings/added", "settings");
		// A wholesale replace would drop the session-added root; the delta
		// application never removes anything here.
		expect(removeWorkspaceDirectory).not.toHaveBeenCalled();
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	it("removes a settings workspace root that disappeared from disk", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only", "/settings/gone"] },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only"] },
		});

		const addWorkspaceDirectory = vi.fn(async () => null);
		const removeWorkspaceDirectory = vi.fn(async () => "/settings/gone");
		await runCommand(
			settings,
			{},
			{
				getAdditionalDirectories: vi.fn(() => ["/settings/only", "/settings/gone"]),
				addWorkspaceDirectory,
				removeWorkspaceDirectory,
			},
		);

		expect(addWorkspaceDirectory).not.toHaveBeenCalled();
		expect(removeWorkspaceDirectory).toHaveBeenCalledWith("/settings/gone");
	});

	it("keeps a root another source still supplies when settings withdraw it", async () => {
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only", "/settings/gone", "/dually/supplied"] },
		});
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({
			advisor: { syncBacklog: "1" },
			workspace: { additionalDirectories: ["/settings/only"] },
		});

		const removeWorkspaceDirectory = vi.fn(async () => "/settings/gone");
		await runCommand(
			settings,
			{},
			{
				getAdditionalDirectories: vi.fn(() => ["/settings/only", "/settings/gone", "/dually/supplied"]),
				// /dually/supplied is also claimed by --add-dir, a resumed session
				// header, or a later /add-dir, so the manager reports it session-supplied.
				isSessionSuppliedDirectory: vi.fn((directory: string) => directory === "/dually/supplied"),
				addWorkspaceDirectory: vi.fn(async () => null),
				removeWorkspaceDirectory,
			},
		);

		// The dually-supplied root survives; the settings-only root is still withdrawn.
		expect(removeWorkspaceDirectory).toHaveBeenCalledTimes(1);
		expect(removeWorkspaceDirectory).toHaveBeenCalledWith("/settings/gone");
	});

	it("preserves a session /advisor override when advisor.enabled is unchanged", async () => {
		await writeSettings({ advisor: { syncBacklog: "1", enabled: true } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1", enabled: true } });

		// The session ran /advisor off; the unchanged setting must not flip it
		// back on during a reload.
		const { setAdvisorEnabled } = await runCommand(settings, { isAdvisorEnabled: () => false });
		expect(setAdvisorEnabled).not.toHaveBeenCalled();
	});

	it("preserves session-only service tiers when no tier setting changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await writeSettings({ advisor: { syncBacklog: "1" } });

		// The live map carries a session-only /fast override; a no-op reload
		// must not reset it to the settings default.
		const { setServiceTierFamily } = await runCommand(settings, {
			serviceTierByFamily: { openai: "priority" },
		});
		expect(setServiceTierFamily).not.toHaveBeenCalled();
	});

	it("pushes the config update after the model catalog refresh", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { notifyConfigChanged, refreshModels } = await runCommand(settings);
		// notifyConfigChanged advertises the model list to hosts; a pre-refresh
		// push would advertise the stale catalog on a models.yml-only change.
		expect(refreshModels).toHaveBeenCalled();
		expect(notifyConfigChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
			refreshModels.mock.invocationCallOrder[0],
		);
	});
});

describe("session scope helpers", () => {
	const fakeModel = (provider: string, id: string): Model => ({ provider, id }) as unknown as Model;

	it("maps resolver scope to cycle entries, filling non-explicit levels with the configured default", () => {
		const mapped = toSessionScopedModels(
			[
				{ model: fakeModel("prov", "one"), thinkingLevel: "low" as ThinkingLevel, explicitThinkingLevel: true },
				{ model: fakeModel("prov", "two"), thinkingLevel: undefined, explicitThinkingLevel: false },
			],
			Settings.isolated({ defaultThinkingLevel: "high" }),
		);
		expect(mapped.map(entry => entry.thinkingLevel).join(",")).toBe("low,high");
		expect(toSessionScopedModels([], Settings.isolated())).toEqual([]);
	});

	it("is element-wise ordered, level-, and record-sensitive for the cycle guard", () => {
		const a = [
			{ model: fakeModel("p", "x"), thinkingLevel: "low" as ThinkingLevel },
			{ model: fakeModel("q", "y"), thinkingLevel: "high" as ThinkingLevel },
		];
		expect(sameScopedModelCycle(a, [...a])).toBe(true);
		// Same set, reordered: a reorder carries user intent in the scope cycle.
		expect(sameScopedModelCycle(a, [a[1], a[0]])).toBe(false);
		// Same order and set, thinking level changed: must reinstall the rebuilt scope.
		expect(
			sameScopedModelCycle(a, [{ model: fakeModel("p", "x"), thinkingLevel: "high" as ThinkingLevel }, a[1]]),
		).toBe(false);
		// Same order, level, different model id.
		expect(
			sameScopedModelCycle(a, [{ model: fakeModel("p", "z"), thinkingLevel: "low" as ThinkingLevel }, a[1]]),
		).toBe(false);
		// Same order, level, and provider/id but a NEW model record (catalog
		// metadata change): refresh swapped in a fresh object, so the cycle must
		// reinstall rather than keep the stale record.
		expect(
			sameScopedModelCycle(a, [{ model: fakeModel("p", "x"), thinkingLevel: "low" as ThinkingLevel }, a[1]]),
		).toBe(false);
	});
});

describe("TtsrManager.updateSettings", () => {
	// settings.getGroup("ttsr") always fills every manager-level key, so the
	// fixture mirrors the complete shape the handler passes through.
	const ttsrGroup = (overrides: Partial<TtsrSettings> = {}): TtsrSettings => ({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	});

	it("re-merges defaults, adopts reloaded manager settings, and reports the change", () => {
		const manager = new TtsrManager();
		expect(manager.updateSettings(ttsrGroup({ enabled: false, repeatGap: 30 }))).toBe(true);
		expect(manager.getSettings().enabled).toBe(false);
		expect(manager.getSettings().repeatGap).toBe(30);
		// Keys absent from the reloaded group keep their constructor defaults.
		expect(manager.getSettings().contextMode).toBe("discard");
		expect(manager.getSettings().repeatMode).toBe("once");
	});

	it("reports no change for a group that matches the current manager settings", () => {
		const manager = new TtsrManager(ttsrGroup({ repeatGap: 20 }));
		expect(manager.updateSettings(ttsrGroup({ repeatGap: 20 }))).toBe(false);
		expect(manager.getSettings().repeatGap).toBe(20);
	});

	it("reports no change when only bucketing-only keys differ", () => {
		const manager = new TtsrManager();
		expect(manager.updateSettings({ ...ttsrGroup(), builtinRules: false, disabledRules: ["legacy"] })).toBe(false);
	});
});
