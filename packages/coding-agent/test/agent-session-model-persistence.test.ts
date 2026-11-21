import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Context, Effort, type ImageContent, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
	TEMPORARY_MODEL_CHANGE_ROLE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { AUTO_THINKING, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage and the model registry are immutable across these tests: runtime
	// keys are configured once and only the bundled model list is read.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedAuthStorage.keys.setRuntime("zai", "test-key");
		sharedAuthStorage.keys.setRuntime("openrouter", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-persistence-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	function routedModel(upstream: string): Model<Api> {
		const selector = `openrouter/z-ai/glm-4.7@${upstream}`;
		const model = parseModelPattern(selector, sharedModelRegistry.getAvailable()).model;
		if (!model) throw new Error(`Expected routed model ${selector} to exist`);
		expect(formatModelStringWithRouting(model)).toBe(selector);
		return model;
	}

	async function writeRoleModelSession(
		defaultRoleValue: string,
		smolRoleValue: string,
		lastRole = "smol",
	): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: defaultRoleValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: smolRoleValue,
					role: lastRole,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}
	async function createSession(options?: {
		initialModel?: Model<Api>;
		selectInitialModel?: (availableModels: Model<Api>[]) => Model<Api>;
		modelRoles?: Record<string, string>;
		persist?: boolean;
	}): Promise<{ modelRegistry: ModelRegistry; settings: Settings; session: AgentSession }> {
		const modelRegistry = sharedModelRegistry;
		const model =
			options?.initialModel ??
			options?.selectInitialModel?.(modelRegistry.getAvailable()) ??
			getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModelRole(role, modelRoleValue);
				}
			}
		}
		session = new AgentSession({
			agent,
			sessionManager: options?.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
				: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		return result;
	}
	it("switches the active model without persisting by default", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
		});
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(nextModel);

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(modelChangedCount).toBe(1);

		await created.session.setModel(nextModel);
		expect(modelChangedCount).toBe(1);
	});

	it("publishes an ordinary route-only selection and journals its exact selector", async () => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const created = await createSession({ initialModel: routeA });
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(routeB);

		expect(formatModelStringWithRouting(created.session.model!)).toBe(formatModelStringWithRouting(routeB));
		expect(modelChangedCount).toBe(1);
		expect(created.session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toEqual([
			expect.objectContaining({ model: formatModelStringWithRouting(routeB), role: "default" }),
		]);

		await created.session.setModel(routeB);
		expect(modelChangedCount).toBe(1);
	});

	it("publishes a model change when a literal ID displays like a pinned route", async () => {
		const routed = routedModel("cerebras");
		const literal = { ...routed, id: `${routed.id}@cerebras`, compat: undefined };
		expect(formatModelStringWithRouting(literal)).toBe(formatModelStringWithRouting(routed));
		const created = await createSession({ initialModel: literal });
		const changedModels: Array<Model<Api> | undefined> = [];
		created.session.subscribe(event => {
			if (event.type === "model_changed") changedModels.push(created.session.model);
		});

		await created.session.setModel(routed);

		expect(created.session.model?.id).toBe(routed.id);
		expect(changedModels).toEqual([routed]);
	});

	it.each([
		[TEMPORARY_MODEL_CHANGE_ROLE, undefined],
		[EPHEMERAL_MODEL_CHANGE_ROLE, { ephemeral: true }],
	] as const)("journals the exact route of a %s selection", async (role, options) => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const created = await createSession({
			initialModel: routeA,
			modelRoles: { default: formatModelStringWithRouting(routeA) },
		});

		await created.session.setModelTemporary(routeB, undefined, options);

		expect(formatModelStringWithRouting(created.session.model!)).toBe(formatModelStringWithRouting(routeB));
		expect(created.session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toEqual([
			expect.objectContaining({ model: formatModelStringWithRouting(routeB), role }),
		]);
		expect(created.settings.getModelRole("default")).toBe(formatModelStringWithRouting(routeA));
	});

	it("persists the default role when explicitly requested", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		await created.session.setModel(nextModel, "default", { persist: true });

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("switches the active model even when the live context is over the target window", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		const targetWindow = nextModel.contextWindow ?? 0;
		expect(targetWindow).toBeGreaterThan(0);

		const result = await created.session.setModel(nextModel, "default", { persist: true });

		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("cycles role models without rewriting configured roles", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = `${modelValue(slowModel)}:high`;

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const result = await created.session.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(created.session.model?.id).toBe(slowModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles role models backward from the current role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = modelValue(slowModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const forward = await created.session.cycleRoleModels(["default", "slow"], "forward");
		const backward = await created.session.cycleRoleModels(["default", "slow"], "backward");

		expect(forward?.role).toBe("slow");
		expect(backward?.role).toBe("default");
		expect(created.session.model?.id).toBe(defaultModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles available models without persisting the default role", async () => {
		const created = await createSession({
			selectInitialModel: availableModels => {
				if (availableModels.length <= 1 || !availableModels[0]) {
					throw new Error("Expected at least two available models");
				}
				return availableModels[0];
			},
		});
		const initialModel = created.session.model;
		if (!initialModel) throw new Error("Expected initial model to be set");
		const defaultRoleValue = modelValue(initialModel);
		created.settings.setModelRole("default", defaultRoleValue);

		const result = await created.session.cycleModel();

		if (!result) throw new Error("Expected cycleModel to return a new model");
		expect(modelValue(result.model)).not.toBe(defaultRoleValue);
		const activeModel = created.session.model;
		if (!activeModel) throw new Error("Expected active model after cycleModel");
		expect(modelValue(activeModel)).toBe(modelValue(result.model));
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
	});

	it("cycles from a pinned free model using its unpinned scope slot", async () => {
		const paid = getBundledModel("openrouter", "qwen/qwen3-coder");
		const free = getBundledModel("openrouter", "qwen/qwen3-coder:free");
		if (!paid || !free) throw new Error("Expected paid and free OpenRouter models");
		const selector = `${modelValue(free)}@cerebras`;
		const pinned = parseModelPattern(selector, [free]).model;
		if (!pinned) throw new Error(`Expected routed model ${selector} to exist`);
		expect(formatModelStringWithRouting(pinned)).toBe(selector);
		const created = await createSession({ initialModel: pinned });
		created.session.setScopedModels([{ model: paid }, { model: free }]);

		await created.session.cycleModel();

		expect(created.session.model?.id).toBe(paid.id);
	});

	it("cycles scoped routes of the same model in both directions", async () => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const created = await createSession({ initialModel: routeA });
		created.session.setScopedModels([{ model: routeA }, { model: routeB }]);

		for (const [direction, expected] of [
			["forward", routeB],
			["forward", routeA],
			["backward", routeB],
		] as const) {
			const result = await created.session.cycleModel(direction);
			expect(result?.isScoped).toBe(true);
			expect(result?.model && formatModelStringWithRouting(result.model)).toBe(
				formatModelStringWithRouting(expected),
			);
			expect(formatModelStringWithRouting(created.session.model!)).toBe(formatModelStringWithRouting(expected));
			expect(
				created.session.sessionManager
					.getEntries()
					.filter(entry => entry.type === "model_change")
					.at(-1),
			).toMatchObject({ model: formatModelStringWithRouting(expected) });
		}
	});

	it("cycles role routes of the same model without rewriting the configured selectors", async () => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const defaultSelector = formatModelStringWithRouting(routeA);
		const smolSelector = formatModelStringWithRouting(routeB);
		const created = await createSession({
			initialModel: routeA,
			modelRoles: { default: defaultSelector, smol: smolSelector },
		});

		const forward = await created.session.cycleRoleModels(["default", "smol"]);
		expect(forward?.role).toBe("smol");
		expect(formatModelStringWithRouting(created.session.model!)).toBe(smolSelector);
		const backward = await created.session.cycleRoleModels(["default", "smol"], "backward");
		expect(backward?.role).toBe("default");
		expect(formatModelStringWithRouting(created.session.model!)).toBe(defaultSelector);
		expect(created.settings.getModelRole("default")).toBe(defaultSelector);
		expect(created.settings.getModelRole("smol")).toBe(smolSelector);
		expect(created.session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toEqual([
			expect.objectContaining({ model: smolSelector, role: "smol" }),
			expect.objectContaining({ model: defaultSelector, role: "default" }),
		]);
	});

	it.each([["slow"], [undefined]] as const)("cycles from the active pin with recorded role %s", async recordedRole => {
		const routed = routedModel("cerebras");
		const literal = { ...routed, id: `${routed.id}@cerebras`, compat: undefined };
		const selector = formatModelStringWithRouting(routed);
		expect(formatModelStringWithRouting(literal)).toBe(selector);
		const created = await createSession({ initialModel: routed, modelRoles: { slow: selector } });
		const available = created.modelRegistry.getAvailable();
		const getAvailable = spyOn(created.modelRegistry, "getAvailable").mockReturnValue([...available, literal]);
		try {
			if (recordedRole) created.session.sessionManager.appendModelChange(selector, recordedRole);
			expect(created.session.sessionManager.getLastModelChangeRole()).toBe(recordedRole);
			const order = ["slow", "default"];
			const cycle = created.session.getRoleModelCycle(order);
			expect(cycle?.models[0]?.model.id).toBe(literal.id);
			expect(cycle?.models[1]?.model.id).toBe(routed.id);
			expect(formatModelStringWithRouting(cycle!.models[1].model)).toBe(selector);

			const result = await created.session.cycleRoleModels(order);
			expect(result?.role).toBe("slow");
			expect(created.session.model?.id).toBe(literal.id);
		} finally {
			getAvailable.mockRestore();
		}
	});

	it("cycles from an implicit default pinned to a variant using refreshed model metadata", async () => {
		const base = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!base || base.contextWindow === null) throw new Error("Expected a context window for the OpenRouter base model");
		const selector = "openrouter/z-ai/glm-4.7:nitro@cerebras";
		const initialModel = parseModelPattern(selector, [base]).model;
		if (!initialModel) throw new Error(`Expected ${selector} to resolve from the base model`);
		const created = await createSession({ initialModel, modelRoles: { slow: modelValue(base) } });
		const refreshedBase = { ...base, contextWindow: Math.floor(base.contextWindow / 2) };
		const getAvailable = spyOn(created.modelRegistry, "getAvailable").mockReturnValue([refreshedBase]);
		try {
			const order = ["slow", "default"];
			const cycle = created.session.getRoleModelCycle(order);
			expect(cycle?.models.map(entry => [entry.role, formatModelStringWithRouting(entry.model)])).toEqual([
				["slow", modelValue(base)],
				["default", selector],
			]);
			expect(cycle?.models[1]?.model.contextWindow).toBe(refreshedBase.contextWindow);
			const result = await created.session.cycleRoleModels(order);
			expect(result?.role).toBe("slow");
			expect(formatModelStringWithRouting(created.session.model!)).toBe(modelValue(base));
		} finally {
			getAvailable.mockRestore();
		}
	});

	it("keeps the implicit default role when the active model ID becomes an alias", async () => {
		const logical = buildModel({
			id: "kimi-k2",
			name: "Kimi K2",
			provider: "venice",
			api: "openai-completions",
			baseUrl: "https://api.venice.ai/api/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1024,
			reasoning: true,
		});
		const created = await createSession({ initialModel: { ...logical, id: "kimi-k2-thinking" } });
		const getAvailable = spyOn(created.modelRegistry, "getAvailable").mockReturnValue([logical]);
		try {
			const cycle = created.session.getRoleModelCycle(["default"]);
			expect(cycle?.models.map(entry => [entry.role, entry.model.id])).toEqual([["default", "kimi-k2"]]);
		} finally {
			getAvailable.mockRestore();
		}
	});

	it("omits the implicit default role when the active provider is no longer available", async () => {
		const created = await createSession({ modelRoles: { slow: "openrouter/z-ai/glm-4.7" } });
		const active = created.session.model!;
		const available = created.modelRegistry.getAvailable().filter(model => model.provider !== active.provider);
		const getAvailable = spyOn(created.modelRegistry, "getAvailable").mockReturnValue(available);
		try {
			const cycle = created.session.getRoleModelCycle(["default", "slow"]);
			expect(cycle?.models.map(entry => entry.role)).toEqual(["slow"]);
		} finally {
			getAvailable.mockRestore();
		}
	});

	describe.each(["startup resume", "switch session"] as const)("%s route journal replay", restorePath => {
		it.each([
			[TEMPORARY_MODEL_CHANGE_ROLE, "openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@sambanova"],
			[PREWALK_MODEL_CHANGE_ROLE, "openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@sambanova"],
			[EPHEMERAL_MODEL_CHANGE_ROLE, "openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@sambanova"],
			[TEMPORARY_MODEL_CHANGE_ROLE, "openrouter/z-ai/glm-4.7", "openrouter/z-ai/glm-4.7"],
		] as const)("restores %s from %s then %s", async (role, defaultSelector, lastSelector) => {
			const targetSessionFile = await writeRoleModelSession(defaultSelector, lastSelector, role);
			const expectedSelector = role === EPHEMERAL_MODEL_CHANGE_ROLE ? defaultSelector : lastSelector;
			if (restorePath === "startup resume") {
				await createStartupResumeSession(targetSessionFile);
			} else {
				const created = await createSession({ initialModel: routedModel("cerebras"), persist: true });
				await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
			}

			expect(session?.model && formatModelStringWithRouting(session.model)).toBe(expectedSelector);
		});
	});

	it("journals an explicit route-only switch override and restores it on the next switch", async () => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const selectorA = formatModelStringWithRouting(routeA);
		const selectorB = formatModelStringWithRouting(routeB);
		const targetSessionFile = await writeRoleModelSession(selectorA, selectorA, "default");
		const created = await createSession({ initialModel: routeA, persist: true });

		await expect(created.session.switchSession(targetSessionFile, { model: routeB })).resolves.toBe(true);
		expect(formatModelStringWithRouting(created.session.model!)).toBe(selectorB);
		expect(
			created.session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "model_change")
				.at(-1),
		).toMatchObject({ model: selectorB });

		await created.session.newSession();
		await created.session.setModel(routeA);
		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(formatModelStringWithRouting(created.session.model!)).toBe(selectorB);
	});

	it("announces the restored route after a late switch failure", async () => {
		const routeA = routedModel("cerebras");
		const routeB = routedModel("sambanova");
		const selectorA = formatModelStringWithRouting(routeA);
		const selectorB = formatModelStringWithRouting(routeB);
		const targetSessionFile = await writeRoleModelSession(selectorB, selectorB, "default");
		const created = await createSession({ initialModel: routeA, persist: true });
		const changes: string[] = [];
		created.session.subscribe(event => {
			if (event.type === "model_changed") {
				changes.push(formatModelStringWithRouting(created.session.model!));
			}
		});
		const reconnect = spyOn(created.session.agent, "subscribe").mockImplementationOnce(() => {
			throw new Error("late switch failure");
		});
		try {
			await expect(created.session.switchSession(targetSessionFile)).rejects.toThrow("late switch failure");
		} finally {
			reconnect.mockRestore();
		}

		expect(changes).toEqual([selectorB, selectorA]);
		expect(formatModelStringWithRouting(created.session.model!)).toBe(selectorA);
	});

	it("restores the last active role model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);

		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue, smol: smolRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(smolModel.id);
	});

	it("restores the last active role model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const result = await createStartupResumeSession(targetSessionFile);

		expect(result.session.model?.id).toBe(smolModel.id);
	});

	it("falls back to the saved default model when switch-session role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");

		const created = await createSession({
			initialModel: previousModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when switch-session last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);

		const created = await createSession({
			initialModel: fallbackModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("falls back to the saved default model when startup role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settingsFallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(settingsFallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when startup last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(fallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores a temporary model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(temporaryModel.id);
	});

	it("restores a temporary model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");
		const settings = Settings.isolated();
		settings.setModelRole("default", defaultRoleValue);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(temporaryModel.id);
	});

	it("activates auto thinking on startup resume when modelRoles.default carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(
			modelValue(defaultModel),
			modelValue(defaultModel),
			"default",
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", `${modelValue(defaultModel)}:auto`);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("keeps DEFAULT-role auto thinking on a fresh session when the model declares defaultLevel (#16370)", async () => {
		const model = getBundledModel("zai", "glm-5.3");
		if (!model) throw new Error("Expected zai/glm-5.3 to exist");
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		// The /model hub stores DEFAULT-role `auto` as a bare role plus `defaultThinkingLevel: auto`.
		const settings = Settings.isolated({ defaultThinkingLevel: AUTO_THINKING });
		settings.setModelRole("default", modelValue(model));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "fresh-auto")),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;

		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(result.session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(result.session.thinkingLevel).not.toBe(Effort.Max);
	});

	it("marks an incomplete process-exit transcript aborted during SDK resume without dropping history", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted"));
		const interruptedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "state.txt" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendMessage(interruptedAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "preserved partial result" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected interrupted session file");

		const result = await createStartupResumeSession(sessionFile);
		const messages = result.session.sessionManager.buildSessionContext({ transcript: true }).messages;
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Previous OMP process exited before completing the turn.",
		});
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(part => part.type === "text" && part.text === "preserved partial result"),
			),
		).toBe(true);
		expect(messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(
			1,
		);
	});

	it("marks a first user-message process-exit tail aborted with the selected model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted-user"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(
			result.session.sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
				stopReason: "aborted",
			},
		});
	});

	/** A valid 800x500 RGB PNG of noise deflate cannot shrink: ~1.6 MB of base64, decodable by the send path's image checks. */
	function framePng(seed: number): string {
		const pixels = new Uint32Array((800 * 500 * 3) / 4);
		let state = seed;
		for (let i = 0; i < pixels.length; i++) {
			// xorshift32, so every run encodes the same bytes.
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			pixels[i] = state;
		}
		return encodeRawPng(new Uint8Array(pixels.buffer), 800, 500, 3).toString("base64");
	}

	/** Appends a 4.8 MB three-frame archive: over the 3 MB default, inside half of Anthropic's 120 MB inline-image budget. */
	function appendFrameArchive(sessionManager: SessionManager, firstKeptEntryId: string): void {
		const frame = (seed: number) => ({
			data: framePng(seed),
			mimeType: "image/png",
			cols: 8,
			rows: 8,
			chars: 8,
		});
		sessionManager.appendCompaction("Archived history.", "archive", firstKeptEntryId, 150_000, {
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [frame(0x40), frame(0x80), frame(0xc0)],
					totalChars: 24,
					truncatedChars: 0,
				},
			},
		});
	}

	function archiveImages(messages: readonly AgentMessage[]): number {
		const summary = messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected a restored compaction summary");
		return summary.blocks?.filter(block => block.type === "image").length ?? 0;
	}

	/** Resumes a session whose archive was compacted on the official Anthropic API. */
	async function resumeArchivedSession(
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
	): Promise<CreateAgentSessionResult> {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "archived"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		});
		appendFrameArchive(sessionManager, firstKeptEntryId);
		return createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
	}

	it("restores a snapcompact archive at the resumed model's frame payload budget", async () => {
		const result = await resumeArchivedSession(sharedAuthStorage, sharedModelRegistry);
		session = result.session;

		expect(archiveImages(result.session.messages)).toBe(3);
	});

	/** Switches a session archived on the official Anthropic API to `target`, then returns the archive frames of its next request. */
	async function archiveFramesAfterSwitch(
		target: Model<Api>,
		switchModel: (session: AgentSession, target: Model<Api>) => Promise<unknown>,
	): Promise<ImageContent[]> {
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			for (const provider of ["anthropic", "openrouter", "amazon-bedrock"]) {
				authStorage.keys.setRuntime(provider, "test-key");
			}
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const result = await resumeArchivedSession(authStorage, modelRegistry);
			session = result.session;
			const summary = session.messages.find(message => message.role === "compactionSummary");

			await switchModel(session, target);
			let request: Context | undefined;
			session.agent.streamFn = (_model, context) => {
				request = context;
				const stream = new AssistantMessageEventStream();
				const message = createAssistantMessage("done");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await session.agent.continue();

			// The agent keeps the archive it was built with; only the request is capped.
			expect(session.messages.find(message => message.role === "compactionSummary")).toBe(summary);
			const requestSummary = request?.messages.find(
				message => message.role === "user" && message.historyRewriteAt !== undefined,
			);
			if (requestSummary?.role !== "user" || !Array.isArray(requestSummary.content)) {
				throw new Error("Expected the archive summary in the request");
			}
			return requestSummary.content.filter((block): block is ImageContent => block.type === "image");
		} finally {
			await session?.dispose();
			session = undefined;
			authStorage.close();
		}
	}

	it.each([
		["setModel", getBundledModel("openrouter", "anthropic/claude-sonnet-4.5")],
		["setModelTemporary", getBundledModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")],
	] as const)(
		"after %s from the official Anthropic API to a host without a byte budget, the next request carries only the newest archive frame",
		async (switchPath, target) => {
			const frames = await archiveFramesAfterSwitch(target, (active, model) =>
				switchPath === "setModel"
					? active.setModel(model)
					: active.setModelTemporary(model, undefined, { ephemeral: true }),
			);

			expect(frames).toHaveLength(1);
			expect(frames.reduce((bytes, frame) => bytes + frame.data.length, 0)).toBeLessThanOrEqual(
				snapcompact.DEFAULT_FRAME_DATA_BYTES_BUDGET,
			);
		},
	);

	it("keeps every archive frame in the next request after a switch between official Anthropic models", async () => {
		const frames = await archiveFramesAfterSwitch(
			getAnthropicModelOrThrow("claude-sonnet-4-5-20250929"),
			(active, model) => active.setModel(model),
		);

		expect(frames).toHaveLength(3);
	});

	it.each([
		["a proxy to the official Anthropic API", "anthropic-proxy", "anthropic", 3],
		["the official Anthropic API to a proxy", "anthropic", "anthropic-proxy", 1],
	] as const)(
		"switching sessions from %s installs the archive at the resumed model's frame payload budget",
		async (_, fromProvider, toProvider, frames) => {
			const modelsPath = path.join(tempDir.path(), "models.yml");
			await Bun.write(
				modelsPath,
				`providers:
  anthropic-proxy:
    api: anthropic-messages
    baseUrl: https://anthropic-proxy.example.com
    apiKey: test-key
    models:
      - id: claude-sonnet-4-5
        input: [text, image]
        contextWindow: 200000
        maxTokens: 64000
`,
			);
			const modelRegistry = new ModelRegistry(sharedAuthStorage, modelsPath);
			const findModel = (provider: string): Model<Api> => {
				const model = modelRegistry.find(provider, "claude-sonnet-4-5");
				if (!model) throw new Error(`Expected ${provider}/claude-sonnet-4-5`);
				return model;
			};
			const targetModel = findModel(toProvider);
			const target = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "target"));
			target.appendModelChange(modelValue(targetModel));
			const firstKeptEntryId = target.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
			target.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: targetModel.api,
				provider: targetModel.provider,
				model: targetModel.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			appendFrameArchive(target, firstKeptEntryId);
			await target.flush();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected target session file");
			session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: findModel(fromProvider),
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.Medium,
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active")),
				settings: Settings.isolated(),
				modelRegistry,
			});

			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			expect(session.model?.provider).toBe(toProvider);
			expect(archiveImages(session.messages)).toBe(frames);
		},
	);

	it("marks an interrupted first turn aborted when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const created = await createSession({ initialModel: defaultModel, persist: true });
		const targetFile = path.join(tempDir.path(), "switch-interrupted-user.jsonl");
		const timestamp = "2026-07-11T02:20:08.800Z";
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "switch-target", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: modelValue(defaultModel),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "inspect state", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "exit",
					parentId: "user",
					timestamp,
					customType: "session_exit",
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(created.session.switchSession(targetFile)).resolves.toBe(true);

		expect(created.session.sessionManager.buildSessionContext({ transcript: true }).messages.at(-1)).toMatchObject({
			role: "assistant",
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
			stopReason: "aborted",
		});
	});

	it("lists restorable temporary model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					temporary: "anthropic/claude-sonnet-4-6",
				},
				"temporary",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});

	it("lists only the default model for ephemeral fallback restores", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					[EPHEMERAL_MODEL_CHANGE_ROLE]: "anthropic/claude-sonnet-4-6",
				},
				EPHEMERAL_MODEL_CHANGE_ROLE,
			),
		).toEqual(["anthropic/claude-sonnet-4-5"]);
	});
});
