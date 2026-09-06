import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	resolveProvisionalAutoLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-role-thinking-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
		runtimeApiKeys?: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const runtimeApiKeys = options.runtimeApiKeys ?? {};
		for (const provider in runtimeApiKeys) {
			authStorage.setRuntimeApiKey(provider, runtimeApiKeys[provider]);
		}

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("activates auto thinking when cycling into a role whose value carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:auto`,
			},
		});

		const toSmol = await session.cycleRoleModels(["default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.model.id).toBe(smolModel.id);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		// `medium` is supported on both ladders (4-6 dropped `minimal`), so the
		// selection survives the role switch unclamped.
		session.setThinkingLevel(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("applies slow role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowPlanModel.provider}/${slowPlanModel.id}:high`,
				plan: `${slowPlanModel.provider}/${slowPlanModel.id}:off`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowPlanModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(slowModel, "default", { persist: true });

		expect(sessionSettings.getModelRole("default")).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("clamps max selections down to the ladder ceiling on models without a max tier", async () => {
		// Budget-mode sonnet-4-5 tops out at xhigh; a max request must clamp down.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getAvailableThinkingLevels()).not.toContain("max");
	});

	it("cycles through off and auto before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(agent.state.disableReasoning).toBe(true);
		expect(session.cycleThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(agent.state.disableReasoning).toBe(false);
		const autoReceipt = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change")
			.at(-1);
		expect(autoReceipt).toMatchObject({
			thinkingLevel: resolveProvisionalAutoLevel(model),
			configured: AUTO_THINKING,
		});
		const autoReceiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		session.setThinkingLevel(AUTO_THINKING);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			autoReceiptCount,
		);
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("cycles through max as the final tier on a max-capable model", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		const available = session.getAvailableThinkingLevels();
		expect(available.at(-1)).toBe(Effort.Max);

		session.setThinkingLevel(Effort.XHigh);
		expect(session.cycleThinkingLevel()).toBe(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.Max);
		// max is the last tier: the wheel wraps back to off.
		expect(session.cycleThinkingLevel()).toBe("off");
	});

	it("keeps auto configured while applying the classifier result as the effective level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		await session.prompt("Implement a focused parser fix");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("classifies a user-invoked /skill turn under auto (resolves concrete effort)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		// A /skill:<name> invocation reaches the session as a user-attributed
		// custom message, not a `user` role. It is still a real user turn.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Expanded SKILL.md body: implement the focused parser fix",
			display: true,
			details: { name: "implement", path: "/skills/implement/SKILL.md", args: "the parser" },
			attribution: "user",
		});

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(classifierSpy.mock.calls[0]?.[0]).toContain("implement the focused parser fix");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("does not classify an agent-originated skill custom message under auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);

		// Autoloaded / agent-originated skill injections must stay excluded.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Autoloaded skill body",
			display: false,
			details: { name: "autoload", path: "/skills/autoload/SKILL.md" },
			attribution: "agent",
		});

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps auto active on resume (pending until the next turn reclassifies)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		await session.prompt("Implement a focused parser fix");

		expect(session.isAutoThinking).toBe(true);
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		// Resumes in auto and pending — not frozen to the last resolved level, and
		// not pre-seeded; the next user turn reclassifies.
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps a manual concrete pin (not auto) on resume even when the global default is auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// User pins a concrete level mid-session; it must survive resume as-is and
		// must not be reinterpreted as `auto` just because the global default is auto.
		session.setThinkingLevel(Effort.Low);
		expect(session.isAutoThinking).toBe(false);
		await session.prompt("Pinned concrete turn");
		expect(classifierSpy).not.toHaveBeenCalled();
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("persists a concrete pin that matches the auto-resolved effort so resume stays concrete", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// Auto resolves to medium.
		await session.prompt("Implement a focused parser fix");
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);

		// User then pins the *same* effort: selector changes auto -> medium even though
		// the effort is unchanged, so it must persist as a concrete pin (entry +
		// defaultThinkingLevel), not silently stay `configured: "auto"`.
		session.setThinkingLevel(Effort.Medium, true);
		expect(session.isAutoThinking).toBe(false);
		expect(sessionSettings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("falls back to a concrete auto level when classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		const fallback = resolveProvisionalAutoLevel(model);
		await session.prompt("Investigate a regression");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(fallback);
		expect(session.autoResolvedThinkingLevel()).toBe(fallback);
		expect(session.agent.state.thinkingLevel).toBe(fallback);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			1,
		);
	});

	it("preserves the resolved auto level when a later classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockResolvedValueOnce(Effort.Low)
			.mockRejectedValueOnce(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("Handle a straightforward update");
		const receiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		await session.prompt("Investigate another update");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			receiptCount,
		);
	});

	it("skips classification for synthetic turns", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		session.setThinkingLevel(AUTO_THINKING);
		const provisional = resolveProvisionalAutoLevel(model);
		await session.prompt("Synthetic maintenance turn", { synthetic: true });

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("maps ultrathink prompts to the model's highest supported level, clamped below max", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		// sonnet-4-5 has no max tier, so the ultrathink jump clamps to xhigh.
		const expected = clampAutoThinkingEffort(model, Effort.Max);
		expect(expected).toBe(Effort.XHigh);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(expected);
		expect(session.autoResolvedThinkingLevel()).toBe(expected);
	});

	it("resolves ultrathink to max on max-capable models", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(Effort.Max);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Max);
	});

	it("keeps auto effectively off for non-reasoning models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		expect(session.isAutoThinking).toBe(true);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();

		await session.prompt("Implement a tiny change");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("applies matching role thinking to temporary model picks", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getBundledModel("google-antigravity", "gemini-3.5-flash");
		if (!temporaryModel) throw new Error("Expected google-antigravity model gemini-3.5-flash to exist");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				smol: `${temporaryModel.provider}/${temporaryModel.id}:high`,
			},
			runtimeApiKeys: {
				[temporaryModel.provider]: "test-key",
			},
		});

		const roleResolved = session.resolveRoleModelWithThinking("smol");
		expect(roleResolved.model?.id).toBe(temporaryModel.id);
		expect(roleResolved.thinkingLevel).toBe(Effort.High);

		const roleThinkingLevel = session.resolveTemporaryModelThinkingLevel(temporaryModel);
		await session.setModelTemporary(temporaryModel, roleThinkingLevel);

		expect(session.model?.provider).toBe(temporaryModel.provider);
		expect(session.model?.id).toBe(temporaryModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("ignores a stale recorded role and cycles from the active model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}`,
			},
		});

		// Record a model_change for the "slow" role WITHOUT switching the
		// active model — the session still runs the default model. This is the
		// stale state left behind when the model is changed through another
		// surface (alt+m, temporary model, /model) after a role cycle.
		session.sessionManager.appendModelChange(`${slowModel.provider}/${slowModel.id}`, "slow");
		expect(session.sessionManager.getLastModelChangeRole()).toBe("slow");
		expect(session.model?.id).toBe(defaultModel.id);

		// The recorded role's resolved model (4-6) no longer equals the active
		// model (4-5), so the cycle position must fall back to model equality
		// and point at "default" — not trust the stale "slow" slot.
		const cycle = session.getRoleModelCycle(["default", "slow"]);
		if (!cycle) throw new Error("Expected a resolved role model cycle");
		expect(cycle.models.map(entry => entry.role)).toEqual(["default", "slow"]);
		expect(cycle.currentIndex).toBe(0);
		expect(cycle.models[cycle.currentIndex]?.role).toBe("default");

		// Cycling advances from the ACTIVE model's position: default → slow.
		// With the stale slot trusted, the cycle would compute slow → default
		// and "switch" right back onto the model already running.
		const result = await session.cycleRoleModels(["default", "slow"]);
		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(session.model?.id).toBe(slowModel.id);
	});
});
