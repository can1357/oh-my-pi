import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

describe("issue #986 compaction auth fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: { fallbackModelRole?: string; configureFallbackAuth?: boolean }) {
		const currentModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote", "soft"],
		});
		if (options?.fallbackModelRole) {
			settings.setModelRole(options.fallbackModelRole, `${fallbackModel.provider}/${fallbackModel.id}`);
		}

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "codex-token");
		if (options?.configureFallbackAuth !== false) {
			authStorage.setRuntimeApiKey(fallbackModel.provider, "anthropic-token");
		}
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
		return { currentModel, fallbackModel };
	}

	async function createAutoNativeFallbackSession(options?: {
		sameProviderNativeEnabled?: boolean;
		includeSoftFallback?: boolean;
	}) {
		const currentModel = getBundledModel("openai", "gpt-5");
		const sameProviderBase = getBundledModel("openai", "gpt-5-mini");
		const sameProviderModel =
			sameProviderBase && options?.sameProviderNativeEnabled === false
				? { ...sameProviderBase, remoteCompaction: { ...sameProviderBase.remoteCompaction, enabled: false } }
				: sameProviderBase;
		const crossProviderModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !sameProviderModel || !crossProviderModel) {
			throw new Error("Expected bundled native fallback test models");
		}

		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": options?.includeSoftFallback ? ["remote", "soft"] : ["remote"],
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("smol", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		settings.setModelRole("slow", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "openai-token");
		authStorage.setRuntimeApiKey(crossProviderModel.provider, "anthropic-token");
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
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, sameProviderModel, crossProviderModel]);
		const apiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const triggerAutoCompaction = async (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") resolve();
			});
			const contextWindow = currentModel.contextWindow;
			if (!contextWindow) throw new Error("Expected current model context window");
			const assistant = {
				...assistantMsg("threshold reached"),
				api: currentModel.api,
				provider: currentModel.provider,
				model: currentModel.id,
				usage: {
					input: contextWindow,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: contextWindow + 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await promise;
			await session.waitForIdle();
		};

		return { apiKeySpy, crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction };
	}

	it("continues same-provider native candidates but stops before crossing providers on non-auth failure", async () => {
		const { crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction } =
			await createAutoNativeFallbackSession();
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(new Error("native compaction transport failed"));
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "cross-provider summary",
				shortSummary: "cross-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
	});

	it("preserves a native transport failure when a later same-provider candidate fails authentication", async () => {
		const { apiKeySpy, crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction } =
			await createAutoNativeFallbackSession();
		apiKeySpy.mockImplementation(async model =>
			model.provider === crossProviderModel.provider ? undefined : "test-key",
		);
		const attemptedModels: string[] = [];
		let errorMessage: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") errorMessage = event.errorMessage;
		});
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				throw new compactionModule.NativeCompactionError(
					Object.assign(new Error("native compaction authentication failed"), { status: 401 }),
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(errorMessage).toContain("native compaction transport failed");
	});

	it("skips unauthenticated cross-provider candidates before enforcing the native boundary", async () => {
		const { apiKeySpy, crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction } =
			await createAutoNativeFallbackSession();
		session.settings.setModelRole("smol", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		session.settings.setModelRole("slow", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		apiKeySpy.mockImplementation(async model =>
			model.provider === crossProviderModel.provider ? undefined : "test-key",
		);
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "authenticated same-provider summary",
					shortSummary: "authenticated same-provider",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 42,
				};
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
	});

	it("retries a transient native compaction failure on the same candidate", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeFallbackSession();
		session.settings.set("retry.enabled", true);
		session.settings.set("retry.baseDelayMs", 1);
		session.settings.set("retry.maxRetries", 1);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider !== currentModel.provider || model.id !== currentModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			if (attemptedModels.length === 1) {
				throw new compactionModule.NativeCompactionError(
					new AIError.ProviderHttpError("native compaction temporarily unavailable", 503),
				);
			}
			return {
				summary: "native retry summary",
				shortSummary: "native retry",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
		]);
		expect(waitSpy).toHaveBeenCalledTimes(1);
	});

	it("preserves native timeout failures before crossing providers", async () => {
		const { crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction } =
			await createAutoNativeFallbackSession();
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(new Error("provider stream stall timeout"));
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "cross-provider summary",
				shortSummary: "cross-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
	});

	it("stops auto-compaction before a same-provider candidate with native compaction disabled", async () => {
		const { currentModel, sameProviderModel, triggerAutoCompaction } = await createAutoNativeFallbackSession({
			sameProviderNativeEnabled: false,
		});
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("native compaction transport failed"));
			}
			return {
				summary: "generic same-provider summary",
				shortSummary: "generic same-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([`${currentModel.provider}/${currentModel.id}`]);
		expect(sameProviderModel.remoteCompaction?.enabled).toBe(false);
	});

	it("falls through to cross-provider soft compaction after native authentication failures", async () => {
		const { crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction } =
			await createAutoNativeFallbackSession({ includeSoftFallback: true });
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (preparation.settings.remoteEnabled === true) {
				if (model.provider === currentModel.provider || model.provider === sameProviderModel.provider) {
					throw new compactionModule.NativeCompactionError(
						Object.assign(new Error("native compaction authentication failed"), { status: 401 }),
					);
				}
				throw new Error(`Unexpected remote compaction model ${model.provider}/${model.id}`);
			}
			if (model.provider === currentModel.provider || model.provider === sameProviderModel.provider) {
				throw new AIError.ProviderHttpError("local compaction authentication failed", 401);
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected soft compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "authenticated fallback summary",
				shortSummary: "authenticated fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
			`${crossProviderModel.provider}/${crossProviderModel.id}`,
		]);
	});

	it("tries same-provider native candidates during manual compaction before crossing providers", async () => {
		const { crossProviderModel, currentModel, sameProviderModel } = await createAutoNativeFallbackSession();
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("native manual compaction failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "same-provider manual summary",
					shortSummary: "same-provider manual",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 42,
				};
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});

		const result = await session.compact();

		expect(result.summary).toBe("same-provider manual summary");
		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(attemptedModels).not.toContain(`${crossProviderModel.provider}/${crossProviderModel.id}`);
	});

	it("falls back across providers when server compaction receives auth_unavailable", async () => {
		const { currentModel, fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const originalCompact = compactionModule.compact;
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ error: { type: "auth_unavailable", message: "no auth available for codex" } },
				{ status: 503, statusText: "Service Unavailable" },
			),
		);
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, model, apiKey, customInstructions, signal, options) => {
				if (model.provider === currentModel.provider && model.id === currentModel.id) {
					if (preparation.settings.remoteEnabled === true) {
						return originalCompact(
							{
								...preparation,
								settings: { ...preparation.settings, remoteStreamingV2Enabled: false },
							},
							model,
							apiKey,
							customInstructions,
							signal,
							{ ...options, fetch: fetchMock },
						);
					}
					throw new AIError.ProviderHttpError("local compaction authentication failed", 401);
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
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("fails fast with a clear provider-specific error when no authenticated fallback exists", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
	});

	it("falls back when the current provider returns a real HTTP 401 from the compaction call", async () => {
		// Companion to the auth_unavailable test above: that case exercises the
		// pi-native gateway synthetic ("no credential configured"), this one
		// exercises a configured-but-rejected credential (rotated/revoked
		// Anthropic key, expired OAuth token, wrong workspace). Before the
		// status-aware detector landed, only the synthetic was caught — a real
		// 401 from the provider bypassed the fallback and dumped the raw HTTP
		// body into the UI as "Compaction failed: 401 {...}".
		const { currentModel, fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw Object.assign(
					new Error(
						'Turn prefix summarization failed: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
					),
					{ status: 401 },
				);
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
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "stale-codex-token";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(3);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("fails fast with the configured-credentials hint when a 401 has no authenticated fallback", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw Object.assign(
					new Error(
						'Summarization failed: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
					),
					{ status: 401 },
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "stale-codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		// The raw provider envelope must not leak into the actionable error.
		expect((error as Error).message).not.toContain("authentication_error");
		expect((error as Error).message).not.toMatch(/\b401\b/);
	});
});
