import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const originalSchedulerWait = scheduler.wait.bind(scheduler);

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		// ModelRegistry eagerly loads the immutable bundled model catalog in its
		// constructor (~100ms). The catalog and auth fixture never change between
		// tests here (tests only read models and add benign extra runtime keys),
		// so build them once instead of paying ~950ms across the 9 cases.
		//
		// The bundled catalog no longer ships a codex model whose configured
		// promotion target has a strictly larger window (gpt-5.5's bundled target
		// gpt-5.4 is a same-window no-op the runtime rejects), so pin
		// gpt-5.5 (272k) -> gpt-5.6-sol (372k) via modelOverrides — the same
		// mechanism users configure promotion pairs with. gpt-5.4-mini is pinned
		// text-only so the snapcompact-fallback case has a codex model on which
		// snapcompact (vision-based) cannot run.
		tempDir = TempDir.createSync("@pi-context-promotion-");
		const modelsConfigPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-5.5": { contextPromotionTarget: "openai-codex/gpt-5.6-sol" },
							"gpt-5.4-mini": { input: ["text"] },
						},
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		// Promotion retries deliberately settle for 100ms in production. These
		// tests assert the continuation and state transition, not elapsed time.
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createIncompleteMessage(model: Model): AssistantMessage {
		// Mirrors what the codex/responses provider produces for `response.incomplete`:
		// stopReason "length", reasoning-only content, no actionable deliverable.
		return {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};
	}

	// Deterministically drain the fire-and-forget `agent_end` handler that
	// `emitExternalEvent` dispatches. The handler's terminal maintenance work
	// (`#checkCompaction`) is microtask-based on the no-promotion paths, so a
	// single macrotask turn fully flushes it; `waitForIdle` then settles any
	// tracked continuation. Used by the negative tests, which assert that *no*
	// promotion happened and therefore need the handler to have actually run.
	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
		await session.waitForIdle();
	}
	it("clears codex provider session state on manual setModel switch away from codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.4");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(nonCodexModel);

		expect(session.model?.provider).toBe(nonCodexModel.provider);
		expect(session.model?.id).toBe(nonCodexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state on manual temporary switch into codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.4");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: nonCodexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModelTemporary(codexModel);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when branching rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.4");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when tree navigation rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.4");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote when promotion is disabled", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!smallModel) {
			throw new Error("Expected small codex model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(smallModel.provider);
		expect(session.model?.id).toBe(smallModel.id);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	});

	it("does not promote by default", async () => {
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!smallModel) {
			throw new Error("Expected small codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: smallModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(smallModel.provider);
		expect(session.model?.id).toBe(smallModel.id);
	});
	it("does not promote on length stop when message is from a different model", async () => {
		// Switching from a small-context model to a larger one and then receiving a
		// stale length-stop event for the previous model must NOT trigger promotion
		// or compaction on the new model — same guard as the overflow path.
		const smallModel = modelRegistry.find("openai-codex", "gpt-5.5");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-sol");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: largeModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Stale incomplete from the smaller model — current session is already on the large model.
		const staleIncomplete = createIncompleteMessage(smallModel);
		session.agent.emitExternalEvent({ type: "message_end", message: staleIncomplete });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [staleIncomplete] });

		await settle();

		expect(session.model?.provider).toBe(largeModel.provider);
		expect(session.model?.id).toBe(largeModel.id);
	});
});
