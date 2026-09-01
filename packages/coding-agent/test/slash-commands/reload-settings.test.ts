import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { sameScopedModelCycle, toSessionScopedModels } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { REPLAYED_SETTING_IDS } from "@oh-my-pi/pi-coding-agent/modes/controllers/setting-side-effects";
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
		reapplyModelRoles: Mock<() => void>;
		reconcileBashToolSettings: Mock<() => Promise<boolean>>;
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
		};
	}

	async function runCommand(
		settings: Settings,
		sessionOverrides: Partial<Record<string, unknown>> = {},
	): Promise<CommandCalls> {
		const command = lookupBuiltinSlashCommand("reload-settings");
		expect(command).toBeDefined();
		const output = vi.fn();
		const notifyConfigChanged = vi.fn();
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
			asyncJobManager: { setMaxRunningJobs: vi.fn() },
			...sessionOverrides,
		};
		const runtime = {
			session,
			sessionManager: {
				getAdditionalDirectories: vi.fn(() => []),
				setAdditionalDirectories: vi.fn(async () => {}),
			},
			settings,
			cwd: projectDir,
			output,
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
			notifyConfigChanged,
		} as unknown as SlashCommandRuntime;
		await command!.handle?.({ name: "reload-settings", args: "", text: "/reload-settings" }, runtime);
		return {
			output,
			notifyConfigChanged,
			refreshModels: session.refreshModels as unknown as Mock<() => Promise<void>>,
			reapplyModelRoles: session.reapplyModelRoles as unknown as Mock<() => void>,
			setAdvisorEnabled,
			setSteeringMode,
			setServiceTierFamily,
			reconcileBashToolSettings: session.reconcileBashToolSettings as unknown as Mock<() => Promise<boolean>>,
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

	it("replays only ids that are valid setting paths", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		for (const id of REPLAYED_SETTING_IDS) {
			expect(() => settings.get(id as SettingPath)).not.toThrow();
		}
	});

	it("runs the full reload through the TUI adapter without aborting", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" }, autocompleteMaxVisible: 7 });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

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
				setAutoCompactionEnabled: vi.fn(),
				serviceTierByFamily: {},
				setServiceTierFamily: vi.fn(),
				agent: {},
			},
			sessionManager: {
				getCwd: () => projectDir,
				getAdditionalDirectories: vi.fn(() => []),
				setAdditionalDirectories: vi.fn(async () => {}),
			},
			settings,
			ui: {
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				clearInlineImages: vi.fn(),
				setResizeScrollback: vi.fn(),
				resetDisplay: vi.fn(),
				setMaxInlineImages: vi.fn(),
			},
			editor: {
				setText: vi.fn(),
				setAutocompleteMaxVisible: editorSetAutocomplete,
				setImeSafeCursorLayout: vi.fn(),
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
			chatContainer: { children: [], setToolActivityVisible: vi.fn() },
			showStatus: vi.fn(),
			refreshSlashCommandState: vi.fn(),
		};
		const result = await executeBuiltinSlashCommand("/reload-settings", { ctx } as never);
		expect(result).toBe(true);
		expect(editorSetAutocomplete).toHaveBeenCalledWith(7);
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
