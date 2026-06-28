import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { clearCustomApis } from "@pk-nerdsaver-ai/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "@pk-nerdsaver-ai/pi-ai/stream";
import type { Context } from "@pk-nerdsaver-ai/pi-ai/types";
import {
	getDefault,
	getEnumValues,
	onAppendOnlyModeChanged,
	onStatusLineSessionAccentChanged,
	resetSettingsForTest,
	type SettingPath,
	Settings,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

describe("Settings", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();

		// Use TempDir for Windows-safe cleanup (retries on EBUSY from SQLite
		// file handle release delays).
		tempDir = TempDir.createSync("@pi-settings-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");

		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(async () => {
		clearCustomApis();
		__providerInFlightForTesting.setRoot(undefined);
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});
	describe("defaults", () => {
		it("keeps eight inline images live by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("tui.maxInlineImages")).toBe(8);
		});

		it("keeps native terminal progress disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("terminal.showProgress")).toBe(false);
			expect(getDefault("terminal.showProgress")).toBe(false);
		});

		it("keeps the normal startup splash disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("startup.showSplash")).toBe(false);
			expect(getDefault("startup.showSplash")).toBe(false);
		});

		it("defaults provider in-flight request limits to an empty map", async () => {
			const settings = Settings.isolated();
			expect(settings.get("providers.maxInFlightRequests")).toEqual({});
			expect(getDefault("providers.maxInFlightRequests")).toEqual({});
		});

		it("exposes all tool calling mode options", () => {
			const values = getEnumValues("tools.format");
			expect(values).toEqual([
				"auto",
				"native",
				"glm",
				"hermes",
				"kimi",
				"xml",
				"anthropic",
				"deepseek",
				"harmony",
				"qwen3",
				"gemini",
				"gemma",
				"minimax",
			]);
		});
	});

	describe("get()", () => {
		it("resolves overrides, schema defaults, and falsey values", () => {
			const isolated = Settings.isolated({
				"display.showTokenUsage": false,
				setupVersion: 0,
				shellPath: "",
				enabledModels: [],
			});

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			expect(isolated.get("setupVersion")).toBe(0);
			expect(isolated.get("shellPath")).toBe("");
			expect(isolated.get("enabledModels")).toEqual([]);
			expect(isolated.get("tui.maxInlineImages")).toBe(getDefault("tui.maxInlineImages"));
		});

		it("invalidates cached resolved values after set, override, and clearOverride", () => {
			const isolated = Settings.isolated();

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			isolated.set("display.showTokenUsage", true);
			expect(isolated.get("display.showTokenUsage")).toBe(true);

			isolated.override("display.showTokenUsage", false);
			expect(isolated.get("display.showTokenUsage")).toBe(false);

			isolated.clearOverride("display.showTokenUsage");
			expect(isolated.get("display.showTokenUsage")).toBe(true);
		});

		it("re-resolves path-scoped arrays when cwd changes", async () => {
			const otherDir = path.join(tempDir.toString(), "other-project");
			fs.mkdirSync(otherDir, { recursive: true });

			const settings = await Settings.init({
				cwd: projectDir,
				agentDir,
				inMemory: true,
				overrides: {
					enabledModels: [
						"always-model",
						{ path: projectDir, models: ["project-model"] },
						{ path: otherDir, models: ["other-model"] },
					],
					disabledProviders: [
						"always-provider",
						{ pathPrefix: projectDir, providers: ["project-provider"] },
						{ pathPrefix: otherDir, providers: ["other-provider"] },
					],
				},
			});

			expect(settings.get("enabledModels")).toEqual(["always-model", "project-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "project-provider"]);

			await settings.reloadForCwd(otherDir);

			expect(settings.get("enabledModels")).toEqual(["always-model", "other-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "other-provider"]);
		});

		it("migrates legacy snapcompact system prompt booleans to scoped modes", () => {
			expect(Settings.isolated({ "snapcompact.systemPrompt": true }).get("snapcompact.systemPrompt")).toBe("all");
			const nestedLegacy = { snapcompact: { systemPrompt: false } } as Partial<Record<SettingPath, unknown>>;
			expect(Settings.isolated(nestedLegacy).get("snapcompact.systemPrompt")).toBe("none");
		});

		it("migrates legacy inlineToolDescriptors booleans to the on/off enum", () => {
			expect(Settings.isolated({ inlineToolDescriptors: true }).get("inlineToolDescriptors")).toBe("on");
			expect(Settings.isolated({ inlineToolDescriptors: false }).get("inlineToolDescriptors")).toBe("off");
			expect(Settings.isolated().get("inlineToolDescriptors")).toBe("auto");
		});
	});

	describe("statusLine.sessionAccent hooks", () => {
		it("notifies subscribers only when the effective value changes", () => {
			const isolated = Settings.isolated();
			const values: boolean[] = [];
			const unsubscribe = onStatusLineSessionAccentChanged(() => {
				values.push(isolated.get("statusLine.sessionAccent"));
			});

			try {
				isolated.set("statusLine.sessionAccent", true);
				expect(values).toEqual([]);

				isolated.set("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", true);
				expect(values).toEqual([false, true]);

				isolated.clearOverride("statusLine.sessionAccent");
				expect(values).toEqual([false, true, false]);
			} finally {
				unsubscribe();
			}

			isolated.set("statusLine.sessionAccent", true);
			expect(values).toEqual([false, true, false]);
		});
	});

	describe("provider.appendOnlyContext hooks", () => {
		it("isolates a throwing listener so the rest still receive the value", () => {
			const isolated = Settings.isolated();
			const received: string[] = [];
			const unsubscribeThrower = onAppendOnlyModeChanged(() => {
				throw new Error("boom");
			});
			const unsubscribeOk = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				expect(() => isolated.set("provider.appendOnlyContext", "on")).not.toThrow();
				expect(received).toEqual(["on"]);
			} finally {
				unsubscribeThrower();
				unsubscribeOk();
			}
		});
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("persists native terminal progress only after the user changes it", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(await readSettings()).toEqual({});

			settings.set("terminal.showProgress", true);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.terminal).toEqual({ showProgress: true });
		});

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		});
	});

	describe("getEditVariantForModel", () => {
		it("matches configured model variants case-insensitively", async () => {
			await writeSettings({
				edit: {
					modelVariants: {
						kimi: "hashline",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");
		});
	});

	describe("migrations", () => {
		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});

		it("migrates the legacy mnemosyne memory backend to mnemopi", async () => {
			await writeSettings({
				memory: { backend: "mnemosyne" },
				mnemosyne: { dbPath: "/tmp/old.db", scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("memory.backend")).toBe("mnemopi");
			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/old.db");
			expect(settings.get("mnemopi.scoping")).toBe("global");
		});

		it("does not clobber an explicit mnemopi block when the legacy mnemosyne block is also present", async () => {
			await writeSettings({
				mnemosyne: { dbPath: "/tmp/old.db" },
				mnemopi: { dbPath: "/tmp/new.db" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/new.db");
		});

		it("migrates boolean task.eager/todo.eager true to always", async () => {
			await writeSettings({
				task: { eager: true },
				todo: { eager: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` reproduced the previous "on" behavior, now `always`.
			expect(settings.get("task.eager")).toBe("always");
			expect(settings.get("todo.eager")).toBe("always");
		});

		it("migrates boolean task.eager/todo.eager false to default", async () => {
			await writeSettings({
				task: { eager: false },
				todo: { eager: false },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Load-bearing direction: consumers treat any non-`default` value as enabled
			// (`false !== "default"`), so an un-coerced boolean `false` would read as ON.
			expect(settings.get("task.eager")).toBe("default");
			expect(settings.get("todo.eager")).toBe("default");
		});

		it("moves legacy lastChangelogVersion out of config.yml into the marker file", async () => {
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Marker seeded from the legacy key.
			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.40.0");

			// Key stripped from config.yml on the next save.
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			const onDisk = await readSettings();
			expect("lastChangelogVersion" in onDisk).toBe(false);
			expect((onDisk.display as Record<string, unknown>).showTokenUsage).toBe(true);
		});

		it("never clobbers an existing marker with the legacy config value", async () => {
			fs.writeFileSync(path.join(agentDir, "last-changelog-version"), "0.41.0");
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			await Settings.init({ cwd: projectDir, agentDir });

			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.41.0");
		});

		it("migrates legacy find and search settings to glob and grep", async () => {
			await writeSettings({
				find: { enabled: false },
				search: {
					enabled: false,
					contextBefore: 2,
					contextAfter: 5,
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("migrates flat legacy find and search settings keys to nested glob and grep", async () => {
			await writeSettings({
				"find.enabled": false,
				"search.enabled": false,
				"search.contextBefore": 2,
				"search.contextAfter": 5,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("does not clobber existing glob/grep settings when migrating legacy find/search ones", async () => {
			await writeSettings({
				find: { enabled: false },
				glob: { enabled: true },
				search: { enabled: false },
				grep: { enabled: true },
				"find.enabled": false,
				"glob.enabled": true,
				"search.enabled": false,
				"grep.enabled": true,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(true);
			expect(settings.get("grep.enabled")).toBe(true);
		});

		it("migrates legacy tool names in persisted essential overrides", async () => {
			await writeSettings({
				tools: { essentialOverride: ["read", "find", "search", "grep"] },
				"tools.essentialOverride": ["find", "search", "read"],
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tools.essentialOverride")).toEqual(["read", "glob", "grep"]);
		});

		it("migrates from settings.json containing comments", async () => {
			const jsonPath = path.join(agentDir, "settings.json");
			await fs.promises.writeFile(
				jsonPath,
				`{
					// This is a comment
					"display": {
						/* Multiline comment */
						"showTokenUsage": true
					}
				}`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("display.showTokenUsage")).toBe(true);
			expect(fs.existsSync(jsonPath)).toBe(false);
			expect(fs.existsSync(`${jsonPath}.bak`)).toBe(true);
		});
		it("migrates legacy power booleans with system=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: true,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("migrates legacy power booleans with display=true to display level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: true,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("migrates legacy power booleans with declareUserActive=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: true,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("preserves old idle default when only non-idle keys are set", async () => {
			// Old default was preventIdleSleep=true; user only set display=false.
			// Migration should yield "idle", not "off".
			await writeSettings({
				power: { preventDisplaySleep: false },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("idle");
		});

		it("migrates all-false power booleans to off", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: false,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		it("migrates flat-key power booleans to the enum", async () => {
			await writeSettings({
				"power.preventIdleSleep": true,
				"power.preventDisplaySleep": true,
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("does not overwrite an explicit power.sleepPrevention", async () => {
			await writeSettings({
				power: { sleepPrevention: "off", preventIdleSleep: true },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		describe("provider request limits", () => {
			it("uses the effective merged value when configuring hooks", async () => {
				const settings = Settings.isolated({ "providers.maxInFlightRequests": { openai: 1 } });
				__providerInFlightForTesting.setRoot(tempDir.join("provider-inflight"));
				registerMockApi();
				const firstStarted = Promise.withResolvers<void>();
				const releaseFirst = Promise.withResolvers<void>();
				let active = 0;
				let maxActive = 0;
				let callIndex = 0;
				const mock = createMockModel({
					provider: "openai",
					handler: async () => {
						callIndex++;
						active++;
						maxActive = Math.max(maxActive, active);
						try {
							if (callIndex === 1) {
								firstStarted.resolve();
								await releaseFirst.promise;
							}
							return { content: [`reply ${callIndex}`] };
						} finally {
							active--;
						}
					},
				});

				settings.set("providers.maxInFlightRequests", { openai: 4 });

				const first = streamSimple(mock.model, context());
				const firstResult = first.result();
				await firstStarted.promise;
				const second = streamSimple(mock.model, context());
				await Bun.sleep(20);

				expect(settings.get("providers.maxInFlightRequests")).toEqual({ openai: 1 });
				expect(mock.calls).toHaveLength(1);

				releaseFirst.resolve();
				await Promise.all([firstResult, second.result()]);
				expect(maxActive).toBe(1);
			});

			it("rejects invalid provider limits from config.yml", async () => {
				await writeSettings({ providers: { maxInFlightRequests: { openai: "2" } } });

				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
					"Provider request limits must be positive numbers: openai",
				);
			});

			it("rejects invalid provider limits from project settings", async () => {
				await Bun.write(
					path.join(getProjectAgentDir(projectDir), "settings.json"),
					JSON.stringify({ providers: { maxInFlightRequests: { anthropic: 0 } } }),
				);

				await expect(Settings.init({ cwd: projectDir, agentDir, inMemory: true })).rejects.toThrow(
					"Provider request limits must be positive numbers: anthropic",
				);
			});

			it("rejects invalid provider limits from config overlays", async () => {
				const overlayPath = tempDir.join("overlay.yml");
				await Bun.write(overlayPath, YAML.stringify({ providers: { maxInFlightRequests: { umans: -1 } } }));

				await expect(
					Settings.init({ cwd: projectDir, agentDir, inMemory: true, configFiles: [overlayPath] }),
				).rejects.toThrow("Provider request limits must be positive numbers: umans");
			});
		});
	});
});
