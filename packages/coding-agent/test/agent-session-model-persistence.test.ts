import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Context, Effort, type ImageContent, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { AUTO_THINKING, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same anthropic/zai runtime keys and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
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
		scopedModels?: Array<{ model: Model<Api> }>;
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
			scopedModels: options?.scopedModels,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
		modelRegistry: ModelRegistry = sharedModelRegistry,
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
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

	it.each(["options.model", "deferred pattern"] as const)(
		"startup resume preserves the initial SDK upstream selected by %s without a later model change",
		async selection => {
			const selector = "openrouter/anthropic/claude-sonnet-4.5@anthropic";
			const model = parseModelPattern(selector, sharedModelRegistry.getAvailable()).model;
			if (!model) throw new Error("Expected routed OpenRouter model");
			const role = "subagent:initial-route";
			const result = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage: sharedAuthStorage,
				modelRegistry: sharedModelRegistry,
				sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "initial-sdk")),
				settings: Settings.isolated(),
				...(selection === "options.model"
					? { model }
					: { modelPattern: selector, modelPatternFallbackRole: role, modelPatternDefaultFallbackChain: [] }),
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
			expect(formatModelStringWithRouting(session.model!)).toBe(selector);
			const manager = session.sessionManager;
			manager.appendMessage({ role: "user", content: "preserve the initial route", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await session.dispose();
			session = undefined;

			const resumed = await createStartupResumeSession(sessionFile);

			expect(formatModelStringWithRouting(resumed.session.model!)).toBe(selector);
			const models = resumed.session.sessionManager.buildSessionContext().models;
			expect(models.default).toBe(selector);
			if (selection === "deferred pattern") expect(models[role]).toBe(selector);
		},
	);

	it("startup resume preserves an explicit routed switchSession selection", async () => {
		const selector = "openrouter/anthropic/claude-sonnet-4.5";
		const target = parseModelPattern(`${selector}@anthropic`, sharedModelRegistry.getAvailable()).model;
		if (!target) throw new Error("Expected routed OpenRouter model");
		const targetSessionFile = await writeRoleModelSession(`${selector}@google`, `${selector}@google`);
		const created = await createSession({ persist: true });

		await expect(created.session.switchSession(targetSessionFile, { model: target })).resolves.toBe(true);
		expect(formatModelStringWithRouting(created.session.model!)).toBe(`${selector}@anthropic`);
		created.session.sessionManager.appendMessage({
			role: "user",
			content: "preserve the explicit restore route",
			timestamp: Date.now(),
		});
		created.session.sessionManager.appendMessage(createAssistantMessage("ready"));
		await created.session.dispose();
		session = undefined;

		const resumed = await createStartupResumeSession(targetSessionFile);

		expect(formatModelStringWithRouting(resumed.session.model!)).toBe(`${selector}@anthropic`);
	});

	it.each(["setModel", "setModelTemporary", "scoped cycle", "available cycle"] as const)(
		"startup resume preserves the upstream selected by a route-only %s publication",
		async publication => {
			const selector = "openrouter/anthropic/claude-sonnet-4.5";
			const available = sharedModelRegistry.getAvailable();
			const source = parseModelPattern(`${selector}@google`, available).model;
			const target = parseModelPattern(`${selector}@anthropic`, available).model;
			if (!source || !target) throw new Error("Expected routed OpenRouter models");
			const created = await createSession({
				initialModel: source,
				modelRoles: { default: `${selector}@google` },
				persist: true,
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: target }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendMessage({ role: "user", content: "preserve this route", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			if (publication === "setModel") {
				await created.session.setModel(target);
			} else if (publication === "setModelTemporary") {
				await created.session.setModelTemporary(target);
			} else {
				const availableModels =
					publication === "available cycle"
						? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, target])
						: undefined;
				try {
					await created.session.cycleModel();
				} finally {
					availableModels?.mockRestore();
				}
			}
			expect(formatModelStringWithRouting(created.session.model!)).toBe(`${selector}@anthropic`);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;

			const resumed = await createStartupResumeSession(sessionFile);

			expect(formatModelStringWithRouting(resumed.session.model!)).toBe(`${selector}@anthropic`);
		},
	);

	it.each(["setModel", "setModelTemporary", "scoped cycle", "available cycle"] as const)(
		"a late %s receipt cannot replace the newer routed model on resume",
		async publication => {
			const selector = "openrouter/anthropic/claude-sonnet-4.5";
			const available = sharedModelRegistry.getAvailable();
			const source = parseModelPattern(selector, available).model;
			const older = parseModelPattern(`${selector}@google`, available).model;
			const newer = parseModelPattern(`${selector}@anthropic`, available).model;
			if (!source || !older || !newer) throw new Error("Expected routed OpenRouter models");
			const created = await createSession({
				initialModel: source,
				persist: true,
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: older }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendMessage({ role: "user", content: "keep the latest model", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (
						!held &&
						created.session.model &&
						formatModelStringWithRouting(created.session.model) === `${selector}@google`
					) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, older])
					: undefined;
			const pending =
				publication === "setModel"
					? created.session.setModel(older)
					: publication === "setModelTemporary"
						? created.session.setModelTemporary(older)
						: created.session.cycleModel();
			try {
				await entered.promise;
				await created.session.setModelTemporary(newer);
			} finally {
				release.resolve();
				await pending;
				reconciliation.mockRestore();
				availableModels?.mockRestore();
			}

			const receipts = manager.getBranch().filter(entry => entry.type === "model_change");
			expect(receipts.at(-1)?.model).toBe(`${selector}@anthropic`);
			expect(receipts.some(entry => entry.model === `${selector}@google`)).toBe(false);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;

			const resumed = await createStartupResumeSession(sessionFile);
			expect(formatModelStringWithRouting(resumed.session.model!)).toBe(`${selector}@anthropic`);
		},
	);

	it.each([
		"setModel",
		"setModelTemporary",
		"scoped cycle",
		"available cycle",
		"prewalk",
		"prewalk with ephemeral",
	] as const)("a late durable %s receipt survives later ephemeral publications on SDK resume", async publication => {
		const selector = "openrouter/anthropic/claude-sonnet-4.5";
		const available = sharedModelRegistry.getAvailable();
		const source = parseModelPattern(selector, available).model;
		const durable = parseModelPattern(`${selector}@google`, available).model;
		const fallback = parseModelPattern(`${selector}@anthropic`, available).model;
		if (!source || !durable || !fallback) throw new Error("Expected routed OpenRouter models");
		const created = await createSession({
			initialModel: source,
			persist: true,
			scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
		});
		const manager = created.session.sessionManager;
		manager.appendMessage({ role: "user", content: "keep the durable route", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reconcile = SessionTools.prototype.reconcileThinkTool;
		let held = false;
		const reconciliation = vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			if (
				!held &&
				created.session.model &&
				formatModelStringWithRouting(created.session.model) === `${selector}@google`
			) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return reconcile.apply(this, args);
		});
		const availableModels =
			publication === "available cycle"
				? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
				: undefined;
		const options = {
			prewalk: publication === "prewalk" || publication === "prewalk with ephemeral",
			ephemeral: publication === "prewalk with ephemeral",
		};
		const pending =
			publication === "setModel"
				? created.session.setModel(durable)
				: publication === "scoped cycle" || publication === "available cycle"
					? created.session.cycleModel()
					: created.session.setModelTemporary(durable, undefined, options);
		try {
			await entered.promise;
			await created.session.setModelTemporary(source, undefined, { ephemeral: true });
			await created.session.setModelTemporary(fallback, undefined, { ephemeral: true });
		} finally {
			release.resolve();
			await pending;
			reconciliation.mockRestore();
			availableModels?.mockRestore();
		}

		const liveModel = created.session.model;
		if (!liveModel) throw new Error("Expected a live model");
		expect(formatModelStringWithRouting(liveModel)).toBe(`${selector}@anthropic`);
		expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
			model: `${selector}@google`,
			role: options.prewalk
				? "prewalk"
				: publication === "setModelTemporary"
					? "temporary"
					: publication === "setModel"
						? "default"
						: undefined,
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await created.session.dispose();
		session = undefined;

		const resumed = await createStartupResumeSession(sessionFile);
		const resumedModel = resumed.session.model;
		if (!resumedModel) throw new Error("Expected a resumed model");
		expect(formatModelStringWithRouting(resumedModel)).toBe(`${selector}@google`);
	});

	const receiptPublications = ["setModel", "setModelTemporary", "scoped cycle", "available cycle"] as const;
	type ReceiptPublication = (typeof receiptPublications)[number];

	function publishReceipt(target: AgentSession, publication: ReceiptPublication, model: Model<Api>) {
		if (publication === "setModel") return target.setModel(model);
		if (publication === "setModelTemporary") return target.setModelTemporary(model);
		return target.cycleModel();
	}

	it.each([...receiptPublications])(
		"a published routed %s receipt survives newSession and a successful turn on SDK resume",
		async publication => {
			const selector = "openrouter/anthropic/claude-sonnet-4.5";
			const available = sharedModelRegistry.getAvailable();
			const source = parseModelPattern(`${selector}@anthropic`, available).model;
			const durable = parseModelPattern(`${selector}@google`, available).model;
			if (!source || !durable) throw new Error("Expected routed OpenRouter models");
			const created = await createSession({
				initialModel: source,
				persist: true,
				modelRoles: { default: `${selector}@anthropic` },
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (!held && formatModelStringWithRouting(created.session.model!) === `${selector}@google`) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
					: undefined;
			const pending = publishReceipt(created.session, publication, durable);
			let result: unknown;
			try {
				await entered.promise;
				expect(await created.session.newSession()).toBe(true);
			} finally {
				release.resolve();
				result = await pending;
				reconciliation.mockRestore();
				availableModels?.mockRestore();
			}
			if (publication === "setModel") expect(result).toEqual({ switched: true });
			if (publication === "scoped cycle" || publication === "available cycle") {
				expect(result).toMatchObject({ model: { id: durable.id }, isScoped: publication === "scoped cycle" });
			}
			expect(formatModelStringWithRouting(created.session.model!)).toBe(`${selector}@google`);
			expect(
				created.session.sessionManager.getBranch().findLast(entry => entry.type === "model_change"),
			).toMatchObject({
				model: `${selector}@google`,
			});
			created.session.agent.streamFn = model => {
				expect(formatModelStringWithRouting(model)).toBe(`${selector}@google`);
				const stream = new AssistantMessageEventStream();
				const message = {
					...createAssistantMessage("done"),
					provider: model.provider,
					model: model.id,
					api: model.api,
				};
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await created.session.agent.prompt("successful inherited selection turn");
			expect(created.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
				stopReason: "stop",
			});
			const sessionFile = created.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;
			const resumed = await createStartupResumeSession(sessionFile);
			expect(formatModelStringWithRouting(resumed.session.model!)).toBe(`${selector}@google`);
		},
	);

	it.each([...receiptPublications])(
		"an unpublished %s preparation cannot select a model after newSession",
		async publication => {
			const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const target = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const created = await createSession({
				initialModel: source,
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: target }] : undefined,
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, target])
					: undefined;
			const hold = async () => {
				entered.resolve();
				await release.promise;
			};
			const preparation =
				publication === "scoped cycle"
					? vi.spyOn(sharedModelRegistry, "getApiKeyForProvider").mockImplementation(async () => {
							await hold();
							return "test-key";
						})
					: publication === "available cycle"
						? vi.spyOn(sharedModelRegistry, "getApiKey").mockImplementation(async () => {
								await hold();
								return "test-key";
							})
						: vi.spyOn(sharedModelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
								await hold();
								return model;
							});
			const pending = publishReceipt(created.session, publication, target);
			let result: unknown;
			try {
				await entered.promise;
				expect(await created.session.newSession()).toBe(true);
			} finally {
				release.resolve();
				result = await pending;
				preparation.mockRestore();
				availableModels?.mockRestore();
			}
			expect(created.session.model?.id).toBe(source.id);
			if (publication === "setModel") expect(result).toEqual({ switched: false });
			if (publication === "scoped cycle" || publication === "available cycle") expect(result).toBeUndefined();
			expect(
				created.session.sessionManager
					.getBranch()
					.some(entry => entry.type === "model_change" && entry.model === modelValue(target)),
			).toBe(false);
		},
	);

	it("an unpublished role cycle preparation cannot select its model or effort after newSession", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const target = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({
			initialModel: source,
			modelRoles: { default: modelValue(source), slow: `${modelValue(target)}:high` },
		});
		const thinkingLevel = created.session.configuredThinkingLevel();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const preparation = vi
			.spyOn(sharedModelRegistry, "refreshSelectedModelMetadata")
			.mockImplementation(async model => {
				entered.resolve();
				await release.promise;
				return model;
			});
		const pending = created.session.cycleRoleModels(["default", "slow"]);
		let result: unknown;
		try {
			await entered.promise;
			expect(await created.session.newSession()).toBe(true);
		} finally {
			release.resolve();
			result = await pending;
			preparation.mockRestore();
		}
		expect(result).toBeUndefined();
		expect(created.session.model?.id).toBe(source.id);
		expect(created.session.configuredThinkingLevel()).toBe(thinkingLevel);
	});

	it("a newer durable selection after newSession supersedes an inherited pending receipt", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const inherited = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const newer = getAnthropicModelOrThrow("claude-haiku-4-5");
		const created = await createSession({ initialModel: source, persist: true });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reconcile = SessionTools.prototype.reconcileThinkTool;
		let held = false;
		const reconciliation = vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			if (!held && created.session.model?.id === inherited.id) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return reconcile.apply(this, args);
		});
		const pending = created.session.setModel(inherited, "default", { persist: true });
		try {
			await entered.promise;
			expect(await created.session.newSession()).toBe(true);
			expect(await created.session.setModel(newer, "default", { persist: true })).toEqual({ switched: true });
		} finally {
			release.resolve();
			await pending;
			reconciliation.mockRestore();
		}
		expect(created.session.model?.id).toBe(newer.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(newer));
		expect(created.session.sessionManager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject(
			{
				model: modelValue(newer),
			},
		);
	});

	it.each([...receiptPublications])(
		"a published %s receipt survives clearing context on SDK resume",
		async publication => {
			const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const created = await createSession({
				initialModel: source,
				persist: true,
				modelRoles: { default: modelValue(source) },
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendModelChange(modelValue(source), "default");
			manager.appendMessage({ role: "user", content: "clear keeps the selected model", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (!held && created.session.model?.id === durable.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
					: undefined;
			const pending =
				publication === "setModel"
					? created.session.setModel(durable, "default", { persist: true })
					: publishReceipt(created.session, publication, durable);
			let result: unknown;
			try {
				await entered.promise;
				expect(await created.session.resetSessionContext()).toBeDefined();
			} finally {
				release.resolve();
				result = await pending;
				reconciliation.mockRestore();
				availableModels?.mockRestore();
			}
			expect(created.session.model?.id).toBe(durable.id);
			if (publication === "setModel") {
				expect(result).toEqual({ switched: true });
				expect(created.settings.getModelRole("default")).toBe(modelValue(durable));
			}
			if (publication === "scoped cycle" || publication === "available cycle") {
				expect(result).toMatchObject({ model: { id: durable.id }, isScoped: publication === "scoped cycle" });
			}
			expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
				model: modelValue(durable),
			});
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;
			const resumed = await createStartupResumeSession(sessionFile);
			expect(resumed.session.model?.id).toBe(durable.id);
		},
	);

	it.each([...receiptPublications])(
		"a rejected cwd hook publication preserves the pending %s receipt on SDK resume",
		async publication => {
			const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const rejected = getAnthropicModelOrThrow("claude-haiku-4-5");
			const created = await createSession({
				initialModel: source,
				persist: true,
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendModelChange(modelValue(source), "default");
			manager.appendMessage({ role: "user", content: "rollback keeps the selected model", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const targetDir = TempDir.createSync("@pi-receipt-cwd-target-");
			const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
			targetManager.appendMessage({ role: "user", content: "rejected transcript", timestamp: Date.now() });
			await targetManager.ensureOnDisk();
			const targetFile = targetManager.getSessionFile();
			await targetManager.close();
			if (!targetFile) throw new Error("Expected a target session");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (!held && created.session.model?.id === durable.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
					: undefined;
			const pending = publishReceipt(created.session, publication, durable);
			let result: unknown;
			try {
				await entered.promise;
				expect(
					await created.session.switchSession(targetFile, {
						onCwdChange: async () => {
							expect(await created.session.setModel(rejected)).toEqual({ switched: true });
							expect(created.session.model?.id).toBe(rejected.id);
							return false;
						},
					}),
				).toBe(false);
				expect(created.session.model?.id).toBe(durable.id);
			} finally {
				release.resolve();
				result = await pending;
				reconciliation.mockRestore();
				availableModels?.mockRestore();
				targetDir.removeSync();
			}
			if (publication === "setModel") expect(result).toEqual({ switched: true });
			if (publication === "scoped cycle" || publication === "available cycle") {
				expect(result).toMatchObject({ model: { id: durable.id }, isScoped: publication === "scoped cycle" });
			}
			expect(created.session.model?.id).toBe(durable.id);
			expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
				model: modelValue(durable),
			});
			expect(
				manager.getBranch().some(entry => entry.type === "model_change" && entry.model === modelValue(rejected)),
			).toBe(false);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;
			const resumed = await createStartupResumeSession(sessionFile);
			expect(resumed.session.model?.id).toBe(durable.id);
		},
	);

	it("a newer durable selection after cwd rollback supersedes the restored pending receipt", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const pendingModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const newer = getAnthropicModelOrThrow("claude-haiku-4-5");
		const created = await createSession({ initialModel: source, persist: true });
		const manager = created.session.sessionManager;
		manager.appendModelChange(modelValue(source), "default");
		manager.appendMessage({ role: "user", content: "new selection after rollback", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		const targetDir = TempDir.createSync("@pi-receipt-newer-cwd-target-");
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "rejected transcript", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		await targetManager.close();
		if (!targetFile) throw new Error("Expected a target session");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reconcile = SessionTools.prototype.reconcileThinkTool;
		let held = false;
		const reconciliation = vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			if (!held && created.session.model?.id === pendingModel.id) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return reconcile.apply(this, args);
		});
		const pending = created.session.setModel(pendingModel);
		try {
			await entered.promise;
			expect(
				await created.session.switchSession(targetFile, {
					onCwdChange: async () => {
						await created.session.setModel(newer);
						return false;
					},
				}),
			).toBe(false);
			expect(created.session.model?.id).toBe(pendingModel.id);
			expect(await created.session.setModel(newer)).toEqual({ switched: true });
		} finally {
			release.resolve();
			await pending;
			reconciliation.mockRestore();
			targetDir.removeSync();
		}
		expect(created.session.model?.id).toBe(newer.id);
		expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
			model: modelValue(newer),
		});
		expect(
			manager.getBranch().some(entry => entry.type === "model_change" && entry.model === modelValue(pendingModel)),
		).toBe(false);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await created.session.dispose();
		session = undefined;
		const resumed = await createStartupResumeSession(sessionFile);
		expect(resumed.session.model?.id).toBe(newer.id);
	});

	it.each([
		["keeps its requested effort when a rejected cwd hook rolls the switch back", "hook", undefined, Effort.Low],
		["keeps its requested effort when a late failure rolls the switch back", "late", undefined, Effort.Low],
		["yields to an effort selected after the rollback", "hook", Effort.High, Effort.High],
	] as const)("a pending setModelTemporary %s", async (_name, failure, later, expected) => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const pendingModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({ initialModel: source, persist: true });
		const manager = created.session.sessionManager;
		manager.appendMessage({ role: "user", content: "rollback keeps the requested effort", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		const targetDir = TempDir.createSync("@pi-effort-rollback-target-");
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "rolled back transcript", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		await targetManager.close();
		if (!targetFile) throw new Error("Expected a target session");
		expect(created.session.configuredThinkingLevel()).not.toBe(Effort.Low);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reconcile = SessionTools.prototype.reconcileThinkTool;
		let held = false;
		const reconciliation = vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			if (!held && created.session.model?.id === pendingModel.id) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return reconcile.apply(this, args);
		});
		const targetReset =
			failure === "late"
				? vi
						.spyOn(SessionMemory.prototype, "resetContextForNewTranscript")
						.mockRejectedValueOnce(new Error("target reset failed"))
				: undefined;
		const pending = created.session.setModelTemporary(pendingModel, Effort.Low);
		try {
			await entered.promise;
			if (failure === "hook") {
				expect(await created.session.switchSession(targetFile, { onCwdChange: async () => false })).toBe(false);
			} else {
				await expect(created.session.switchSession(targetFile, { preserveLocalCwd: true })).rejects.toThrow(
					"target reset failed",
				);
			}
			expect(created.session.model?.id).toBe(pendingModel.id);
			if (later) created.session.setThinkingLevel(later);
		} finally {
			release.resolve();
			await pending;
			reconciliation.mockRestore();
			targetReset?.mockRestore();
			targetDir.removeSync();
		}
		expect(created.session.configuredThinkingLevel()).toBe(expected);
	});

	it.each([...receiptPublications])(
		"a failed %s assignment does not steal an earlier durable SDK resume receipt",
		async publication => {
			const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const rejected = getAnthropicModelOrThrow("claude-haiku-4-5");
			const created = await createSession({
				initialModel: source,
				persist: true,
				scopedModels: publication === "scoped cycle" ? [{ model: durable }, { model: rejected }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendMessage({ role: "user", content: "keep the successful assignment", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (!held && created.session.model?.id === durable.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const pending = created.session.setModelTemporary(durable);
			let failure: unknown;
			let availableModels: { mockRestore(): void } | undefined;
			try {
				await entered.promise;
				created.session.agent.setModelResolver(model => {
					if (model.id === rejected.id) throw new Error("rejected model assignment");
					return model;
				});
				if (publication === "available cycle") {
					availableModels = vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([durable, rejected]);
				}
				try {
					await publishReceipt(created.session, publication, rejected);
				} catch (error) {
					failure = error;
				}
			} finally {
				release.resolve();
				await pending;
				created.session.agent.setModelResolver(undefined);
				reconciliation.mockRestore();
				availableModels?.mockRestore();
			}
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toContain("rejected model assignment");
			expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
				model: modelValue(durable),
			});
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;
			const resumed = await createStartupResumeSession(sessionFile);
			expect(resumed.session.model?.id).toBe(durable.id);
		},
	);

	it.each([...receiptPublications])(
		"an outgoing %s receipt cannot cross a committed switch, reload, or round trip",
		async publication => {
			for (const transition of ["switch", "reload", "round trip"] as const) {
				const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
				const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
				const created = await createSession({
					initialModel: source,
					persist: true,
					scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
				});
				const manager = created.session.sessionManager;
				manager.appendModelChange(modelValue(source), "default");
				manager.appendMessage({ role: "user", content: "origin transcript", timestamp: Date.now() });
				manager.appendMessage(createAssistantMessage("ready"));
				await manager.flush();
				const originFile = manager.getSessionFile();
				if (!originFile) throw new Error("Expected an origin session");
				const targetFile = await writeRoleModelSession(modelValue(source), modelValue(source));
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const reconcile = SessionTools.prototype.reconcileThinkTool;
				let held = false;
				const reconciliation = vi
					.spyOn(SessionTools.prototype, "reconcileThinkTool")
					.mockImplementation(async function (this: SessionTools, ...args) {
						if (!held && created.session.model?.id === durable.id) {
							held = true;
							entered.resolve();
							await release.promise;
						}
						return reconcile.apply(this, args);
					});
				const availableModels =
					publication === "available cycle"
						? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
						: undefined;
				const pending = publishReceipt(created.session, publication, durable);
				let result: unknown;
				try {
					await entered.promise;
					await created.session.setModelTemporary(source, undefined, { ephemeral: true });
					await created.session.switchSession(transition === "reload" ? originFile : targetFile);
					if (transition === "round trip") await created.session.switchSession(originFile);
				} finally {
					release.resolve();
					result = await pending;
					reconciliation.mockRestore();
					availableModels?.mockRestore();
				}
				expect(
					manager.getBranch().some(entry => entry.type === "model_change" && entry.model === modelValue(durable)),
				).toBe(false);
				expect(created.session.model?.id).toBe(source.id);
				if (publication === "setModel") expect(result).toEqual({ switched: false });
				else expect(result).toBeUndefined();
				const activeFile = manager.getSessionFile();
				if (!activeFile) throw new Error("Expected an active session");
				await created.session.dispose();
				session = undefined;
				const resumed = await createStartupResumeSession(activeFile);
				expect(resumed.session.model?.id).toBe(source.id);
				await resumed.session.dispose();
				session = undefined;
			}
		},
	);

	it.each([...receiptPublications])(
		"a preparation-pending %s belongs to its origin generation, including switch rollback",
		async publication => {
			for (const rollback of [false, true]) {
				const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
				const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
				const created = await createSession({
					initialModel: source,
					persist: true,
					scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: durable }] : undefined,
				});
				const manager = created.session.sessionManager;
				manager.appendModelChange(modelValue(source), "default");
				manager.appendMessage({ role: "user", content: "metadata origin", timestamp: Date.now() });
				manager.appendMessage(createAssistantMessage("ready"));
				const targetFile = await writeRoleModelSession(modelValue(source), modelValue(source));
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const refresh = sharedModelRegistry.refreshSelectedModelMetadata.bind(sharedModelRegistry);
				const metadata = vi
					.spyOn(sharedModelRegistry, "refreshSelectedModelMetadata")
					.mockImplementation(async model => {
						if (model.id === durable.id) {
							entered.resolve();
							await release.promise;
						}
						return refresh(model);
					});
				const getApiKey = sharedModelRegistry.getApiKey.bind(sharedModelRegistry);
				const apiKey = vi.spyOn(sharedModelRegistry, "getApiKey").mockImplementation(async (...args) => {
					if (publication === "available cycle") {
						entered.resolve();
						await release.promise;
					}
					return getApiKey(...args);
				});
				const getProviderKey = sharedModelRegistry.getApiKeyForProvider.bind(sharedModelRegistry);
				const providerKey = vi
					.spyOn(sharedModelRegistry, "getApiKeyForProvider")
					.mockImplementation(async (...args) => {
						if (publication === "scoped cycle") {
							entered.resolve();
							await release.promise;
						}
						return getProviderKey(...args);
					});
				const availableModels =
					publication === "available cycle"
						? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, durable])
						: undefined;
				const switchEntered = Promise.withResolvers<void>();
				const releaseSwitch = Promise.withResolvers<void>();
				const setSessionFile = manager.setSessionFile.bind(manager);
				const switching = vi.spyOn(manager, "setSessionFile").mockImplementation(async file => {
					if (rollback) {
						switchEntered.resolve();
						await releaseSwitch.promise;
						throw new Error("receipt switch rollback");
					}
					return setSessionFile(file);
				});
				const pending = publishReceipt(created.session, publication, durable);
				let transition: Promise<unknown> | undefined;
				let failure: unknown;
				try {
					await entered.promise;
					transition = created.session.switchSession(targetFile).catch(error => {
						failure = error;
					});
					if (rollback) {
						await switchEntered.promise;
						release.resolve();
					} else {
						await transition;
					}
				} finally {
					release.resolve();
					releaseSwitch.resolve();
					await transition;
					await pending;
					metadata.mockRestore();
					apiKey.mockRestore();
					providerKey.mockRestore();
					switching.mockRestore();
					availableModels?.mockRestore();
				}
				if (rollback) expect(String(failure)).toContain("receipt switch rollback");
				expect(created.session.model?.id).toBe(rollback ? durable.id : source.id);
				expect(
					manager.getBranch().some(entry => entry.type === "model_change" && entry.model === modelValue(durable)),
				).toBe(rollback);
				const activeFile = manager.getSessionFile();
				if (!activeFile) throw new Error("Expected an active session");
				await created.session.dispose();
				session = undefined;
				const resumed = await createStartupResumeSession(activeFile);
				expect(resumed.session.model?.id).toBe(rollback ? durable.id : source.id);
				await resumed.session.dispose();
				session = undefined;
			}
		},
	);

	it("waits for a pending switch rollback before recording an eligible durable receipt", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({ initialModel: source, persist: true });
		const manager = created.session.sessionManager;
		manager.appendMessage({ role: "user", content: "receipt rollback origin", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		const targetFile = await writeRoleModelSession(modelValue(source), modelValue(source));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reconcile = SessionTools.prototype.reconcileThinkTool;
		let held = false;
		const reconciliation = vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			if (!held && created.session.model?.id === durable.id) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return reconcile.apply(this, args);
		});
		const switchEntered = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		const switching = vi.spyOn(manager, "setSessionFile").mockImplementation(async () => {
			switchEntered.resolve();
			await releaseSwitch.promise;
			throw new Error("receipt rollback");
		});
		let published = false;
		const pending = created.session.setModelTemporary(durable).then(result => {
			published = true;
			return result;
		});
		let transition: Promise<unknown> | undefined;
		let failure: unknown;
		try {
			await entered.promise;
			await created.session.setModelTemporary(source, undefined, { ephemeral: true });
			transition = created.session.switchSession(targetFile).catch(error => {
				failure = error;
			});
			await switchEntered.promise;
			release.resolve();
			await setImmediate();
			expect(published).toBe(false);
			expect(
				manager.getBranch().some(entry => entry.type === "model_change" && entry.model === modelValue(durable)),
			).toBe(false);
		} finally {
			release.resolve();
			releaseSwitch.resolve();
			await transition;
			await pending;
			reconciliation.mockRestore();
			switching.mockRestore();
		}
		expect(String(failure)).toContain("receipt rollback");
		expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
			model: modelValue(durable),
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await created.session.dispose();
		session = undefined;
		const resumed = await createStartupResumeSession(sessionFile);
		expect(resumed.session.model?.id).toBe(durable.id);
	});

	it("retains a successful model result when final tool sync crosses a rejected switch", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({ initialModel: source, persist: true });
		const manager = created.session.sessionManager;
		manager.appendMessage({ role: "user", content: "final sync origin", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		const targetDir = TempDir.createSync("@pi-final-sync-target-");
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "other transcript", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		await targetManager.close();
		if (!targetFile) throw new Error("Expected a target session");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const sync = SessionTools.prototype.syncAfterModelChange;
		let held = false;
		const syncing = vi.spyOn(SessionTools.prototype, "syncAfterModelChange").mockImplementation(async function (
			this: SessionTools,
			...args
		) {
			await sync.apply(this, args);
			if (!held && created.session.model?.id === durable.id) {
				held = true;
				entered.resolve();
				await release.promise;
			}
		});
		const switchEntered = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		const pending = created.session.setModel(durable);
		let transition: Promise<boolean> | undefined;
		let result: { switched: boolean } | undefined;
		let switched: boolean | undefined;
		try {
			await entered.promise;
			transition = created.session.switchSession(targetFile, {
				onCwdChange: async () => {
					switchEntered.resolve();
					await releaseSwitch.promise;
					return false;
				},
			});
			await switchEntered.promise;
			release.resolve();
			await setImmediate();
		} finally {
			release.resolve();
			releaseSwitch.resolve();
			switched = await transition;
			result = await pending;
			syncing.mockRestore();
			targetDir.removeSync();
		}
		expect(switched).toBe(false);
		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(durable.id);
		expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
			model: modelValue(durable),
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await created.session.dispose();
		session = undefined;
		const resumed = await createStartupResumeSession(sessionFile);
		expect(resumed.session.model?.id).toBe(durable.id);
	});

	it("keeps live subscriber publications distinct from durable SDK resume ownership", async () => {
		const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const durable = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const created = await createSession({ initialModel: source, persist: true });
		const manager = created.session.sessionManager;
		manager.appendMessage({ role: "user", content: "subscriber handoff", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("ready"));
		let ephemeral: Promise<void> | undefined;
		const unsubscribe = created.session.subscribe(event => {
			if (event.type === "model_changed" && created.session.model?.id === durable.id) {
				ephemeral = created.session.setModelTemporary(source, undefined, { ephemeral: true });
			}
		});
		try {
			await created.session.setModel(durable);
			await ephemeral;
		} finally {
			unsubscribe();
		}
		expect(ephemeral).toBeDefined();
		expect(created.session.model?.id).toBe(source.id);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "model_change" && entry.role !== EPHEMERAL_MODEL_CHANGE_ROLE)
				.at(-1),
		).toMatchObject({
			model: modelValue(durable),
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await created.session.dispose();
		session = undefined;
		const resumed = await createStartupResumeSession(sessionFile);
		expect(resumed.session.model?.id).toBe(durable.id);
	});

	it.each(["setModel", "setModelTemporary", "scoped cycle", "available cycle"] as const)(
		"an effort-only selection still journals the current %s model for resume",
		async publication => {
			const source = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const target = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const created = await createSession({
				initialModel: source,
				persist: true,
				scopedModels: publication === "scoped cycle" ? [{ model: source }, { model: target }] : undefined,
			});
			const manager = created.session.sessionManager;
			manager.appendMessage({ role: "user", content: "keep the selected model", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("ready"));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			let held = false;
			const reconciliation = vi
				.spyOn(SessionTools.prototype, "reconcileThinkTool")
				.mockImplementation(async function (this: SessionTools, ...args) {
					if (!held && created.session.model?.id === target.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			const availableModels =
				publication === "available cycle"
					? vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([source, target])
					: undefined;
			const pending =
				publication === "setModel"
					? created.session.setModel(target)
					: publication === "setModelTemporary"
						? created.session.setModelTemporary(target)
						: created.session.cycleModel();
			try {
				await entered.promise;
				created.session.setThinkingLevel(Effort.Low);
			} finally {
				release.resolve();
				await pending;
				reconciliation.mockRestore();
				availableModels?.mockRestore();
			}

			expect(manager.getBranch().findLast(entry => entry.type === "model_change")).toMatchObject({
				model: modelValue(target),
			});
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await created.session.dispose();
			session = undefined;

			const resumed = await createStartupResumeSession(sessionFile);
			expect(resumed.session.model?.id).toBe(target.id);
		},
	);

	it("startup resume preserves configured routing fields for an already pinned upstream", async () => {
		const selector = "openrouter/anthropic/claude-sonnet-4.5";
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					openrouter: {
						modelOverrides: {
							"anthropic/claude-sonnet-4.5": {
								compat: { openRouterRouting: { only: ["anthropic"], order: ["anthropic", "google"] } },
							},
						},
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(sharedAuthStorage, modelsPath);
		const configured = modelRegistry.find("openrouter", "anthropic/claude-sonnet-4.5");
		if (!configured) throw new Error("Expected configured OpenRouter model");
		expect(configured.compat).toMatchObject({
			openRouterRouting: { only: ["anthropic"], order: ["anthropic", "google"] },
		});
		const sessionFile = await writeRoleModelSession(`${selector}@anthropic`, `${selector}@anthropic`, "temporary");

		const resumed = await createStartupResumeSession(sessionFile, Settings.isolated(), modelRegistry);

		expect(formatModelStringWithRouting(resumed.session.model!)).toBe(`${selector}@anthropic`);
		expect(resumed.session.model?.compat).toMatchObject({
			openRouterRouting: { only: ["anthropic"], order: ["anthropic", "google"] },
		});
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
