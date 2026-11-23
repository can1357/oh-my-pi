import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveGlobalCompactionTarget } from "@oh-my-pi/pi-coding-agent/session/role-models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Regression: when the user sets `modelRoles.default` to a model on a different
 * provider than the current chat, compaction must still pick the active chat's
 * model first. Otherwise an Anthropic chat would route compaction through the
 * OpenAI remote-compaction endpoint (gated by `shouldUseOpenAiRemoteCompaction`),
 * even though the live conversation never used OpenAI.
 */
describe("compaction prefers the current session model over modelRoles.default", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compact-current-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	it("uses the active Anthropic chat model when modelRoles.default points at an OpenAI model", async () => {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const defaultRoleModel = getBundledModel("openai", "gpt-5");
		if (!currentModel || !defaultRoleModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["soft"] });
		settings.setModelRole("default", `${defaultRoleModel.provider}/${defaultRoleModel.id}`);

		const promptCacheKey = "inherited-parent-cache";
		const agent = new Agent({
			promptCacheKey,
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// Both providers have credentials so an "auth failure" wouldn't be the
		// reason a candidate is skipped — order alone must drive the choice.
		authStorage.keys.setRuntime(currentModel.provider, "anthropic-token");
		authStorage.keys.setRuntime(defaultRoleModel.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
		expect(compactSpy.mock.calls[0]?.[5]?.promptCacheKey).toBe(promptCacheKey);
	});

	it("falls back when the authenticated Bedrock candidate cannot resolve AWS credentials", async () => {
		const currentModel = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["soft"] });
		settings.setModelRole("smol", `${fallbackModel.provider}/${fallbackModel.id}`);

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "bedrock-credentials");
		authStorage.keys.setRuntime(fallbackModel.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new AIError.AwsCredentialsError("opaque provider setup failure", "resolution");
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("keeps offline compaction fallbacks on the active provider", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const sameProvider = getBundledModel("anthropic", "claude-opus-4-6");
		const otherProvider = getBundledModel("openai", "gpt-5");
		if (!baseModel || !sameProvider || !otherProvider) throw new Error("Expected bundled test models");
		const currentModel = buildModel({
			...baseModel,
			compactionModel: `${otherProvider.provider}/${otherProvider.id}`,
			compat: baseModel.compatConfig,
		});
		const settings = Settings.isolated({
			"models.offline": true,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
		});
		settings.setModelRole("smol", `${sameProvider.provider}/${sameProvider.id}`);
		settings.setModelRole("default", `${otherProvider.provider}/${otherProvider.id}`);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "anthropic-token");
		authStorage.keys.setRuntime(otherProvider.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.id === currentModel.id) {
				throw new AIError.AwsCredentialsError("credential failure", "resolution");
			}
			return {
				summary: "fallback",
				shortSummary: "fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: { provider: model.provider },
			};
		});

		expect((await session.compact()).summary).toBe("fallback");
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProvider.provider}/${sameProvider.id}`,
		]);
	});

	it("uses compactionModel only for the summary call and leaves the active model unchanged", async () => {
		const baseCurrentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const compactionModel = getBundledModel("openai", "gpt-5");
		if (!baseCurrentModel || !compactionModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: `${compactionModel.provider}/${compactionModel.id}`,
			compat: baseCurrentModel.compatConfig,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "anthropic-token");
		authStorage.keys.setRuntime(compactionModel.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["soft"] }),
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(
			`${compactionModel.provider}/${compactionModel.id}`,
		);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
	});

	it("/compact remote skips a non-remote-capable compactionModel and uses the active remote-capable model", async () => {
		// Active model is OpenAI (provider-native remote-capable per
		// shouldUseOpenAiRemoteCompaction). compactionModel points at an
		// Anthropic model that is NOT remote-capable, so the default candidate
		// chain would try Anthropic first and run a local summary — exactly the
		// silent-fallback the reviewer flagged for `/compact remote`. The fix
		// filters non-remote candidates in this mode, so the spy must observe
		// the OpenAI model as the first invocation.
		const baseCurrentModel = getBundledModel("openai", "gpt-5");
		const nonRemoteCompactionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseCurrentModel || !nonRemoteCompactionModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: `${nonRemoteCompactionModel.provider}/${nonRemoteCompactionModel.id}`,
			compat: baseCurrentModel.compatConfig,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "openai-token");
		authStorage.keys.setRuntime(nonRemoteCompactionModel.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact(undefined, { mode: "remote" });

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
	});

	function modelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	async function compactModelCalls(
		currentModel: Model,
		settings: Settings,
		authenticated: readonly Model[],
		options?: {
			mode?: "remote";
			onModel?: (model: Model, preparation: CompactionPreparation) => CompactionResult | Promise<CompactionResult>;
		},
	): Promise<{ calls: string[]; summary: string }> {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const model of authenticated) authStorage.keys.setRuntime(model.provider, "test-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (options?.onModel) return options.onModel(model, preparation);
			return {
				summary: "ok",
				shortSummary: "ok short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: { provider: model.provider },
			};
		});
		const result = options?.mode ? await session.compact(undefined, { mode: options.mode }) : await session.compact();
		return { calls: compactSpy.mock.calls.map(([, model]) => modelKey(model)), summary: result.summary };
	}

	describe("compaction.model", () => {
		it("uses the configured global model ahead of the active model", async () => {
			const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			const compactionModel = getBundledModel("openai", "gpt-5");
			if (!currentModel || !compactionModel) throw new Error("Expected bundled test models to exist");

			const { calls } = await compactModelCalls(
				currentModel,
				Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"compaction.methodOrder": ["soft"],
					"compaction.model": modelKey(compactionModel),
				}),
				[currentModel, compactionModel],
			);

			expect(calls[0]).toBe(modelKey(compactionModel));
			expect(modelKey(session.model!)).toBe(modelKey(currentModel));
		});

		it("keeps a model's own compactionModel ahead of compaction.model", async () => {
			const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			const perModelTarget = getBundledModel("openai", "gpt-5");
			const globalTarget = getBundledModel("google", "gemini-2.5-flash");
			if (!baseModel || !perModelTarget || !globalTarget) throw new Error("Expected bundled test models to exist");
			const currentModel = buildModel({
				...baseModel,
				compactionModel: modelKey(perModelTarget),
				compat: baseModel.compatConfig,
			});

			const { calls } = await compactModelCalls(
				currentModel,
				Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"compaction.methodOrder": ["soft"],
					"compaction.model": modelKey(globalTarget),
				}),
				[currentModel, perModelTarget, globalTarget],
			);

			expect(calls[0]).toBe(modelKey(perModelTarget));
		});

		it("resolves a @role alias to its configured model", async () => {
			const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			const compactionModel = getBundledModel("google", "gemini-2.5-flash");
			if (!currentModel || !compactionModel) throw new Error("Expected bundled test models to exist");
			const settings = Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				"compaction.model": "@smol",
			});
			settings.setModelRole("smol", modelKey(compactionModel));

			const { calls } = await compactModelCalls(currentModel, settings, [currentModel, compactionModel]);

			expect(calls[0]).toBe(modelKey(compactionModel));
		});

		it("ignores a project-layer compaction.model and resolves from operator layers", async () => {
			const globalModel = getBundledModel("openai", "gpt-5");
			const projectModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!globalModel || !projectModel) throw new Error("Expected bundled test models to exist");
			const cwd = path.join(tempDir.path(), "project");
			const agentDir = path.join(tempDir.path(), "agent");
			await Bun.write(path.join(agentDir, "config.yml"), `compaction:\n  model: ${modelKey(globalModel)}\n`);
			await Bun.write(path.join(cwd, ".omp/config.yml"), `compaction:\n  model: ${modelKey(projectModel)}\n`);

			const settings = await Settings.loadIsolated({ cwd, agentDir });
			const target = resolveGlobalCompactionTarget(settings, [globalModel, projectModel]);

			expect(target && modelKey(target)).toBe(modelKey(globalModel));
		});

		it("rejects bare and unresolved selectors instead of fuzzy matching", () => {
			const base = getBundledModel("openai", "gpt-5");
			if (!base) throw new Error("Expected bundled test models to exist");
			const fuzzyProvider = buildModel({
				...base,
				provider: "openrouter",
				id: "openai/gpt-3.5-turbo-0613",
				compat: base.compatConfig,
			});
			const fuzzyPath = buildModel({
				...base,
				provider: "openrouter",
				id: "only-in-office/deep-chat",
				compat: base.compatConfig,
			});
			const fuzzyRole = buildModel({ ...base, id: "ghost@nonexistent", compat: base.compatConfig });

			expect(
				resolveGlobalCompactionTarget(Settings.isolated({ "compaction.model": "openai" }), [fuzzyProvider]),
			).toBeUndefined();
			expect(
				resolveGlobalCompactionTarget(Settings.isolated({ "compaction.model": "only-in-office/deep-chat" }), [
					fuzzyPath,
				]),
			).toBeUndefined();
			expect(
				resolveGlobalCompactionTarget(Settings.isolated({ "compaction.model": "@nonexistent" }), [fuzzyRole]),
			).toBeUndefined();
		});

		it("falls back to the active model when the configured model returns 404", async () => {
			const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			const configuredModel = getBundledModel("openai", "gpt-5");
			if (!currentModel || !configuredModel) throw new Error("Expected bundled test models to exist");

			const { calls, summary } = await compactModelCalls(
				currentModel,
				Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"compaction.methodOrder": ["soft"],
					"compaction.model": modelKey(configuredModel),
				}),
				[currentModel, configuredModel],
				{
					onModel: (model, preparation) => {
						if (model.provider === configuredModel.provider) {
							throw Object.assign(new Error("model_not_found"), { status: 404 });
						}
						return {
							summary: "fallback",
							shortSummary: "fallback",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: 1,
							details: { provider: model.provider },
						};
					},
				},
			);

			expect(calls).toEqual([modelKey(configuredModel), modelKey(currentModel)]);
			expect(summary).toBe("fallback");
		});

		it("keeps a cross-provider global target out of offline mode", async () => {
			const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			const configuredModel = getBundledModel("openai", "gpt-5");
			if (!currentModel || !configuredModel) throw new Error("Expected bundled test models to exist");

			const { calls } = await compactModelCalls(
				currentModel,
				Settings.isolated({
					"models.offline": true,
					"compaction.keepRecentTokens": 1,
					"compaction.methodOrder": ["soft"],
					"compaction.model": modelKey(configuredModel),
				}),
				[currentModel, configuredModel],
			);

			expect(calls[0]).toBe(modelKey(currentModel));
		});

		it("/compact remote skips a native writer the active model cannot replay when an endpoint is configured", async () => {
			const currentModel = getBundledModel("openai", "gpt-5");
			const configuredModel = getBundledModel("anthropic", "claude-opus-4-6");
			if (!currentModel || !configuredModel) throw new Error("Expected bundled test models to exist");

			const { calls } = await compactModelCalls(
				currentModel,
				Settings.isolated({
					"compaction.keepRecentTokens": 1,
					"compaction.remoteEndpoint": "https://compactor.invalid/summarize",
					"compaction.model": modelKey(configuredModel),
				}),
				[currentModel, configuredModel],
				{ mode: "remote" },
			);

			expect(calls[0]).toBe(modelKey(currentModel));
		});
	});
});
