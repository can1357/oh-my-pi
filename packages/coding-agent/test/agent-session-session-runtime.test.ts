import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isSearchProviderExcluded, setExcludedSearchProviders } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("AgentSession adopted session-runtime changes", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let otherSession: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-session-runtime-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		if (otherSession) await otherSession.dispose();
		session = undefined;
		otherSession = undefined;
		authStorage?.close();
		authStorage = undefined;
		setExcludedSearchProviders([]);
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("keeps a temporary thinking level when adopting an unrelated sibling runtime edit", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ defaultThinkingLevel: Effort.Low, autocompleteMaxVisible: 10 }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{ defaultThinkingLevel: Effort.Low, autocompleteMaxVisible: 7, ask: { enabled: true } },
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("autocompleteMaxVisible")).toBe(7);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("reapplies adopted sampling settings onto the live agent", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ temperature: 0.2, topP: 0.9, defaultThinkingLevel: Effort.Low }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
				temperature: 0.2,
				topP: 0.9,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.agent.temperature).toBe(0.2);
		expect(session.agent.topP).toBe(0.9);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{
					temperature: 0.7,
					topP: 0.5,
					defaultThinkingLevel: Effort.Low,
					ask: { enabled: true },
				},
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("temperature")).toBe(0.7);
		expect(settings.get("topP")).toBe(0.5);
		expect(session.agent.temperature).toBe(0.7);
		expect(session.agent.topP).toBe(0.5);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("reapplies adopted omitThinking onto the live agent", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ omitThinking: false, defaultThinkingLevel: Effort.Low }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
				hideThinkingSummary: false,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.agent.hideThinkingSummary).toBe(false);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{
					omitThinking: true,
					defaultThinkingLevel: Effort.Low,
					ask: { enabled: true },
				},
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("omitThinking")).toBe(true);
		expect(session.agent.hideThinkingSummary).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("reapplies adopted compaction.enabled onto live auto-compaction", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ compaction: { enabled: true }, defaultThinkingLevel: Effort.Low }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.autoCompactionEnabled).toBe(true);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{
					compaction: { enabled: false },
					defaultThinkingLevel: Effort.Low,
					ask: { enabled: true },
				},
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("compaction.enabled")).toBe(false);
		expect(session.autoCompactionEnabled).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("reapplies adopted compaction.methodOrder onto live auto-compaction", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{ compaction: { enabled: true, methodOrder: ["soft"] }, defaultThinkingLevel: Effort.Low },
				null,
				2,
			),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(session.autoCompactionEnabled).toBe(true);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{
					compaction: { enabled: true, methodOrder: [] },
					defaultThinkingLevel: Effort.Low,
					ask: { enabled: true },
				},
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("compaction.methodOrder")).toEqual([]);
		expect(session.autoCompactionEnabled).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("reapplies adopted providers.webSearchExclude onto live search eligibility", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ providers: { webSearchExclude: [] }, defaultThinkingLevel: Effort.Low }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setThinkingLevel(Effort.High);
		expect(isSearchProviderExcluded("exa")).toBe(false);

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{
					providers: { webSearchExclude: ["exa"] },
					defaultThinkingLevel: Effort.Low,
					ask: { enabled: true },
				},
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("providers.webSearchExclude")).toEqual(["exa"]);
		expect(isSearchProviderExcluded("exa")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("ignores session-runtime events from a different Settings clone", async () => {
		const projectDir = tempDir.join("project");
		const otherDir = tempDir.join("other-project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		fs.mkdirSync(getProjectAgentDir(otherDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(projectConfigPath, YAML.stringify({ defaultThinkingLevel: Effort.Low }, null, 2));
		await Bun.write(
			path.join(otherDir, ".omp", "config.yml"),
			YAML.stringify({ defaultThinkingLevel: Effort.Low }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const otherSettings = await settings.cloneForCwd(otherDir);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const createSession = (sessionSettings: Settings) =>
			new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.Low,
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings: sessionSettings,
				modelRegistry: new ModelRegistry(authStorage!),
			});
		session = createSession(settings);
		otherSession = createSession(otherSettings);

		session.setThinkingLevel(Effort.High);
		otherSession.setThinkingLevel(Effort.High);

		settings.set("defaultThinkingLevel", Effort.Medium, "project");
		await Bun.write(projectConfigPath, YAML.stringify({ defaultThinkingLevel: Effort.Minimal }, null, 2));
		await settings.flush();

		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
		expect(otherSession.thinkingLevel).toBe(Effort.High);
	});

	it("ignores conversation-flow events from a different Settings clone", async () => {
		const projectDir = tempDir.join("project");
		const otherDir = tempDir.join("other-project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		fs.mkdirSync(getProjectAgentDir(otherDir), { recursive: true });
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			YAML.stringify({ steeringMode: "one-at-a-time" }, null, 2),
		);
		await Bun.write(
			path.join(otherDir, ".omp", "config.yml"),
			YAML.stringify({ steeringMode: "one-at-a-time" }, null, 2),
		);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const otherSettings = await settings.cloneForCwd(otherDir);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const createSession = (sessionSettings: Settings, steeringMode: "all" | "one-at-a-time") =>
			new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.Low,
					},
					steeringMode,
				}),
				sessionManager: SessionManager.inMemory(),
				settings: sessionSettings,
				modelRegistry: new ModelRegistry(authStorage!),
			});
		session = createSession(settings, "all");
		otherSession = createSession(otherSettings, "one-at-a-time");

		expect(session.steeringMode).toBe("all");
		expect(otherSession.steeringMode).toBe("one-at-a-time");

		otherSettings.set("steeringMode", "all", "project");

		expect(otherSettings.get("steeringMode")).toBe("all");
		expect(otherSession.steeringMode).toBe("all");
		expect(settings.get("steeringMode")).toBe("one-at-a-time");
		expect(session.steeringMode).toBe("all");
	});

	it("keeps an rpc queue-mode change when a project override shadows the global write", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(projectConfigPath, YAML.stringify({ steeringMode: "one-at-a-time" }, null, 2));

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
				steeringMode: "one-at-a-time",
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		expect(session.steeringMode).toBe("one-at-a-time");
		session.setSteeringMode("all");
		expect(settings.get("steeringMode")).toBe("one-at-a-time");
		expect(session.steeringMode).toBe("all");
		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({
			steeringMode: "all",
		});
		expect(session.steeringMode).toBe("all");
	});

	it("keeps a live-only follow-up mode when a persisted steering-mode change reapplies", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true } }, null, 2));

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic claude-sonnet-4-5");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		session.setFollowUpMode("all", false);
		expect(session.followUpMode).toBe("all");
		expect(settings.get("followUpMode")).toBe("one-at-a-time");
		session.setSteeringMode("all");
		expect(session.steeringMode).toBe("all");
		expect(settings.get("steeringMode")).toBe("all");
		expect(session.followUpMode).toBe("all");
		expect(settings.get("followUpMode")).toBe("one-at-a-time");
	});
});
