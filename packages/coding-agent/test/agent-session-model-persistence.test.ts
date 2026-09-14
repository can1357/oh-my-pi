import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { installCodeModelSession, type CodeModelSessionController } from "../src/code-model/session-mode";
import { runExtensionSetModel } from "../src/extensibility/extensions/compact-handler";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same anthropic runtime key and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
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
		codeModelBeforeNavigationHandler?: AgentSessionConfig["codeModelBeforeNavigationHandler"];
		codeModelAfterNavigationHandler?: AgentSessionConfig["codeModelAfterNavigationHandler"];
		persist?: boolean;
		onSessionSwitch?: (ctx: ExtensionContext) => void;
		onSessionBeforeSwitch?: () => { cancel: true };
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
		const sessionManager = options?.persist
			? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
			: SessionManager.inMemory();
		let extensionRunner: ExtensionRunner | undefined;
		if (
			options?.onSessionSwitch ||
			options?.onSessionBeforeSwitch ||
			options?.codeModelBeforeNavigationHandler ||
			options?.codeModelAfterNavigationHandler
		) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					if (options.onSessionSwitch) {
						pi.on("session_switch", (_event, ctx) => options.onSessionSwitch?.(ctx));
					}
					if (options.onSessionBeforeSwitch) {
						pi.on("session_before_switch", () => options.onSessionBeforeSwitch?.());
					}
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"model-persistence-session-switch",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			codeModelBeforeNavigationHandler: options?.codeModelBeforeNavigationHandler,
			codeModelAfterNavigationHandler: options?.codeModelAfterNavigationHandler,
			extensionRunner,
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
	it("awaits the internal navigation gate beyond the extension timeout", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let cancelNavigation = false;
		const created = await createSession({
			codeModelBeforeNavigationHandler: async () => {
				entered.resolve();
				await release.promise;
				return cancelNavigation ? { cancel: true } : undefined;
			},
			persist: true,
		});
		const beforeSessionId = created.session.sessionManager.getSessionId();
		testSetExtensionHandlerTimeoutMs(5);
		let settled = false;
		const navigation = created.session.newSession().then(result => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			await Bun.sleep(20);
			expect(settled).toBe(false);
			release.resolve();
			expect(await navigation).toBe(true);
			expect(created.session.sessionManager.getSessionId()).not.toBe(beforeSessionId);

			cancelNavigation = true;
			const destinationSessionId = created.session.sessionManager.getSessionId();
			const userEntryId = created.session.sessionManager.appendMessage({
				role: "user",
				content: "navigation target",
				timestamp: Date.now(),
			});
			expect((await created.session.branch(userEntryId)).cancelled).toBe(true);
			expect((await created.session.navigateTree(userEntryId)).cancelled).toBe(true);
			expect(await created.session.fork()).toBe(false);
			const sessionFile = created.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session path");
			expect(await created.session.switchSession(sessionFile)).toBe(false);
			expect(created.session.sessionManager.getSessionId()).toBe(destinationSessionId);
		} finally {
			release.resolve();
			await navigation;
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

	it("preserves the outgoing phase when a public navigation handler cancels", async () => {
		let outgoingRestorations = 0;
		const created = await createSession({
			codeModelBeforeNavigationHandler: async () => {
				outgoingRestorations++;
				return undefined;
			},
			onSessionBeforeSwitch: () => ({ cancel: true }),
		});
		const beforeSessionId = created.session.sessionManager.getSessionId();
		expect(await created.session.newSession()).toBe(false);
		expect(outgoingRestorations).toBe(0);
		expect(created.session.sessionManager.getSessionId()).toBe(beforeSessionId);
	});

	it("awaits destination recovery beyond the extension timeout", async () => {
		const targetModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetModelValue = modelValue(targetModel);
		const targetSessionFile = await writeRoleModelSession(targetModelValue, targetModelValue, "default");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const created = await createSession({
			initialModel: previousModel,
			codeModelAfterNavigationHandler: async () => {
				entered.resolve();
				await release.promise;
			},
			persist: true,
		});
		testSetExtensionHandlerTimeoutMs(5);
		let settled = false;
		const navigation = created.session.switchSession(targetSessionFile).then(result => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			await Bun.sleep(20);
			expect(settled).toBe(false);
			release.resolve();
			expect(await navigation).toBe(true);
			expect(created.session.sessionManager.getSessionFile()).toBe(targetSessionFile);
		} finally {
			release.resolve();
			await navigation;
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

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

	it("records routed model identity in session history", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!openRouterModel) throw new Error("Expected the routed OpenRouter fixture to exist");
		const routed = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routed) throw new Error("Expected the routed OpenRouter fixture to resolve");
		sharedAuthStorage.setRuntimeApiKey("openrouter", "test-key");
		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		await created.session.setModel(routed);

		expect(created.session.sessionManager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject(
			{
				type: "model_change",
				model: "openrouter/z-ai/glm-4.7@cerebras",
			},
		);
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

	it("preserves named-role fallback through the extension phase switch and resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel), code: modelValue(defaultModel) },
			persist: true,
		});
		await created.session.setModel(defaultModel, "default");
		await created.session.setModel(slowModel, "slow");
		const runtime = new ExtensionRuntime();
		Object.assign(runtime, {
			setModel: (model: Model, options?: { role?: string; ephemeral?: boolean }) =>
				runExtensionSetModel(created.session, model, options),
			appendEntry: (type: string, data: unknown) => created.session.sessionManager.appendCustomEntry(type, data),
			getThinkingLevel: () => created.session.thinkingLevel,
			getConfiguredThinkingLevel: () => created.session.configuredThinkingLevel(),
			setThinkingLevel: (level: Parameters<AgentSession["setThinkingLevel"]>[0]) =>
				created.session.setThinkingLevel(level),
		});
		let controller: CodeModelSessionController | undefined;
		await loadExtensionFromFactory(
			pi => {
				controller = installCodeModelSession(pi, created.settings);
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"role-preservation-phase",
		);
		const ctx = {
			sessionManager: created.session.sessionManager,
			models: {
				current: () => created.session.model,
				list: () => created.modelRegistry.getAvailable(),
				resolve: (selector: string) => parseModelPattern(selector, created.modelRegistry.getAvailable()).model,
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		if (!controller) throw new Error("Expected the phase controller");
		await controller.run("start", ctx);
		expect(created.session.sessionManager.getLastModelChangeRole()).toBe(EPHEMERAL_MODEL_CHANGE_ROLE);
		await controller.run("finish", ctx);
		expect(created.session.model?.id).toBe(slowModel.id);
		expect(created.session.sessionManager.getLastModelChangeRole()).toBe("slow");
		const models = created.session.sessionManager.buildSessionContext().models;
		expect(models.default).toBe(modelValue(defaultModel));
		expect(models.slow).toBe(modelValue(slowModel));
		await created.session.sessionManager.ensureOnDisk();
		const target = created.session.sessionManager.getSessionFile();
		if (!target) throw new Error("Expected a persisted session");
		const originalAvailable = created.modelRegistry.getAvailable.bind(created.modelRegistry);
		created.modelRegistry.getAvailable = () => originalAvailable().filter(model => model.id !== slowModel.id);
		try {
			await expect(created.session.switchSession(target)).resolves.toBe(true);
			expect(created.session.model?.id).toBe(defaultModel.id);
		} finally {
			created.modelRegistry.getAvailable = originalAvailable;
		}
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

	it("restores a routed temporary model before publishing session switch", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!openRouterModel) throw new Error("Expected the routed OpenRouter fixture to exist");
		const routed = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routed) throw new Error("Expected the routed OpenRouter fixture to resolve");
		sharedAuthStorage.setRuntimeApiKey("openrouter", "test-key");
		const selector = formatModelStringWithRouting(routed);
		const targetSessionFile = await writeRoleModelSession(modelValue(defaultModel), selector, "temporary");
		let observedSelector: string | undefined;
		const observedSession: { current?: AgentSession } = {};
		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
			persist: true,
			onSessionSwitch: () => {
				const current = observedSession.current?.model;
				observedSelector = current ? formatModelStringWithRouting(current) : undefined;
			},
		});
		observedSession.current = created.session;

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model && formatModelStringWithRouting(created.session.model)).toBe(selector);
		expect(observedSelector).toBe(selector);
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

	it("restores a routed temporary model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!openRouterModel) throw new Error("Expected the routed OpenRouter fixture to exist");
		const routed = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routed) throw new Error("Expected the routed OpenRouter fixture to resolve");
		sharedAuthStorage.setRuntimeApiKey("openrouter", "test-key");
		const selector = formatModelStringWithRouting(routed);
		const targetSessionFile = await writeRoleModelSession(modelValue(defaultModel), selector, "temporary");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model && formatModelStringWithRouting(result.session.model)).toBe(selector);
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

	it("restores the saved default when a similar model remains during session switch", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const removedSelector = "anthropic/sonnet-4-6";
		expect(parseModelPattern(removedSelector, sharedModelRegistry.getAvailable()).model?.id).toBe(previousModel.id);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, removedSelector);

		const created = await createSession({
			initialModel: previousModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default when a similar model remains during startup", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settingsFallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const removedSelector = "anthropic/sonnet-4-6";
		expect(parseModelPattern(removedSelector, sharedModelRegistry.getAvailable()).model?.id).toBe(
			settingsFallbackModel.id,
		);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, removedSelector);
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(settingsFallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
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

	it("lists a named role model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					smol: "anthropic/claude-sonnet-4-6",
				},
				"smol",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});
});
