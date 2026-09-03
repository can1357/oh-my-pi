import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { computeContextBreakdown } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("Context usage consolidation", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mockModel: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-context-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		await Settings.init({ inMemory: true });
		await initTheme();

		mockModel = createMockModel({
			id: "gpt-mock",
			provider: "openai",
			contextWindow: 100_000,
			responses: [
				{
					content: ["response text"],
					stopReason: "stop",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	function createSession(
		tempDir: TempDir,
		messages: AgentMessage[] = [],
		systemPrompt: string[] = ["You are a helpful assistant."],
	): { session: AgentSession; sessionManager: SessionManager; agent: Agent } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		for (const msg of messages) {
			sessionManager.appendMessage(msg as unknown as Parameters<typeof sessionManager.appendMessage>[0]);
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mockModel,
				systemPrompt,
				tools: [],
				messages,
			},
			streamFn: (mockModel as unknown as { stream: unknown }).stream as unknown as NonNullable<
				ConstructorParameters<typeof Agent>[0]
			>["streamFn"],
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8000,
			}),
			modelRegistry,
		});

		const sessionContext = session.buildDisplaySessionContext();
		agent.replaceMessages(sessionContext.messages);

		return { session, sessionManager, agent };
	}

	function syncSession(session: AgentSession, agent: Agent): void {
		const sessionContext = session.buildDisplaySessionContext();
		agent.replaceMessages(sessionContext.messages);
	}

	it("keeps branch-local anchors safe from sibling branches", async () => {
		const tempDir = TempDir.createSync("@branch-local-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "parent response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 100, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		syncSession(session, agent);
		const parentId = sessionManager.getBranch().slice(-1)[0]?.id;

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "sibling response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 500,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 520,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 500, nonMessageTokens: 10 },
			timestamp: 3000,
		} as AssistantMessage);

		sessionManager.branch(parentId!);
		sessionManager.appendMessage({ role: "user", content: "active branch hello", timestamp: 4000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "active response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 200,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 220,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 200, nonMessageTokens: 10 },
			timestamp: 5000,
		} as AssistantMessage);

		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBe(200);

		await tempDir.remove();
	});

	it("recovers correct anchor after rollback", async () => {
		const tempDir = TempDir.createSync("@rollback-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1000 } as Message);
		const firstId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		sessionManager.appendMessage({ role: "user", content: "second", timestamp: 3000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 300,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 320,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 300, nonMessageTokens: 10 },
			timestamp: 4000,
		} as AssistantMessage);

		sessionManager.branch(firstId);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBe(150);

		await tempDir.remove();
	});

	it("uses speculative mode after compaction with no subsequent assistant snapshot", async () => {
		const tempDir = TempDir.createSync("@compaction-speculative-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const firstId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "pre compaction response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 1000,
		} as AssistantMessage);

		sessionManager.appendCompaction("compact summary", "compact summary", firstId, 50);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(false);

		await tempDir.remove();
	});

	it("includes custom message / summary in resolved active tail", async () => {
		const tempDir = TempDir.createSync("@tail-custom-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 150,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 170,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 150, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		const customMsg: AgentMessage = {
			role: "custom",
			customType: "test-custom",
			content: "custom content block",
			display: true,
			timestamp: 3000,
		};
		sessionManager.appendMessage(customMsg as unknown as Parameters<typeof sessionManager.appendMessage>[0]);
		syncSession(session, agent);

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);

		const customEstimate = agent.tokenizer.countMessage(customMsg);
		expect(breakdown?.usedTokens).toBe(150 + customEstimate);

		await tempDir.remove();
	});

	it("ensures /context, status line, model selector, and idle compaction all agree on used tokens", async () => {
		const tempDir = TempDir.createSync("@agree-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 250,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 270,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 250, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);

		syncSession(session, agent);

		const breakdownVal = session.getContextBreakdown();
		const used = breakdownVal?.usedTokens;

		const cb = computeContextBreakdown(session);
		expect(cb.usedTokens).toBe(used!);

		const sl = new StatusLineComponent(session);
		expect(sl.getCachedContextBreakdown().usedTokens).toBe(used!);

		const cu = session.getContextUsage();
		expect(cu?.tokens).toBe(used!);

		await tempDir.remove();
	});

	it("invalidates status-line cache on reasoning-signature growth", async () => {
		const tempDir = TempDir.createSync("@cache-invalidate-");
		const { session, sessionManager, agent } = createSession(tempDir);

		sessionManager.appendMessage({ role: "user", content: "query", timestamp: 1000 } as Message);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "text content" }],
			usage: {
				input: 250,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 270,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 250, nonMessageTokens: 10 },
			timestamp: 2000,
			stopReason: "stop",
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
		};
		sessionManager.appendMessage(assistant);
		syncSession(session, agent);

		const sl = new StatusLineComponent(session);
		const initialBreakdown = sl.getCachedContextBreakdown();

		const assistantExt = assistant as unknown as { thinkingSignature: string };
		assistantExt.thinkingSignature = "signature_grows";

		const nextBreakdown = sl.getCachedContextBreakdown();
		expect(nextBreakdown.usedTokens).toBe(initialBreakdown.usedTokens);

		await tempDir.remove();
	});

	it("uses live in-flight pending snapshot when request is active", async () => {
		const tempDir = TempDir.createSync("@inflight-");
		const { session, agent } = createSession(tempDir);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		const promptPromise = session.prompt("query");

		// Wait until the prompt request is actually in flight (pending snapshot set).
		await started.promise;

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThan(0);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("prefers a completed in-turn provider anchor over the pending snapshot", async () => {
		const tempDir = TempDir.createSync("@inturn-anchor-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		const promptPromise = session.prompt("new question");
		await started.promise;

		// While the request hangs (pending snapshot active, cutoff at the new
		// prompt), simulate the turn's user message landing plus a completed tool
		// step carrying a real, large provider prompt count.
		sessionManager.appendMessage({ role: "user", content: "new question", timestamp: 5000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "step" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "toolUse",
			usage: {
				input: 9000,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 9000, nonMessageTokens: 10 },
			timestamp: 6000,
		} as AssistantMessage);
		syncSession(session, agent);

		// The in-turn anchor (index >= pending cutoff) must win: usage reflects the
		// real 9000-token prompt, not the tiny turn-start pending estimate that
		// would otherwise stack an estimate of the whole tail on top.
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThanOrEqual(9000);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("keeps the pending snapshot (not a pre-cutoff anchor) while the first turn response is pending", async () => {
		const tempDir = TempDir.createSync("@pending-precutoff-");
		const { session, sessionManager, agent } = createSession(tempDir);

		// Prior completed turn establishes a real anchor that PREDATES the new
		// prompt (resolves before the pending cutoff).
		sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1000 } as Message);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "old response" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 5000,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: { promptTokens: 5000, nonMessageTokens: 10 },
			timestamp: 2000,
		} as AssistantMessage);
		syncSession(session, agent);

		const { promise, resolve } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await promise;
		});

		// Large prompt in flight, no in-turn step has produced provider usage yet.
		const bigPrompt = "explain this in detail ".repeat(200);
		const promptPromise = session.prompt(bigPrompt);
		await started.promise;

		// Pending must win: it accounts for the just-submitted prompt on top of the
		// prior anchor. The stale pre-cutoff anchor alone (5000) would omit it, so a
		// regression to "always prefer the latest real anchor" would read ~5000.
		const breakdown = session.getContextBreakdown();
		expect(breakdown?.anchored).toBe(true);
		expect(breakdown?.usedTokens).toBeGreaterThan(5500);

		resolve();
		await promptPromise;
		promptSpy.mockRestore();
		await tempDir.remove();
	});

	it("guarantees always numeric nullable-vs-speculative contract", async () => {
		const tempDir = TempDir.createSync("@always-numeric-");
		const { session, sessionManager, agent } = createSession(tempDir);

		const dummyId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "dummy" }],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1000,
		} as AssistantMessage);

		sessionManager.appendCompaction("compact summary", "compact summary", dummyId, 50);
		syncSession(session, agent);

		const cu = session.getContextUsage();
		expect(cu?.tokens).not.toBeNull();
		expect(typeof cu?.tokens).toBe("number");
		expect(cu?.percent).not.toBeNull();
		expect(typeof cu?.percent).toBe("number");

		await tempDir.remove();
	});

	// A before_agent_start extension can hand back a system-prompt array with a
	// missing (undefined) section. getContextBreakdown funnels that array into
	// both estimate paths — computeNonMessageBreakdown AND the collapsed
	// computeNonMessageTokens — so the whole call must tolerate it rather than
	// throwing "Failed to measure JavaScript string" and killing the session
	// (issue #9331).
	it("tolerates an undefined system-prompt section without throwing", async () => {
		const tempDir = TempDir.createSync("@malformed-prompt-");
		const malformed = ["You are a helpful assistant.", undefined as unknown as string, "trailing context"];
		const { session } = createSession(tempDir, [], malformed);

		const breakdown = session.getContextBreakdown();
		expect(breakdown).toBeDefined();
		expect(Number.isFinite(breakdown?.systemContextTokens ?? Number.NaN)).toBe(true);
		expect(breakdown?.usedTokens ?? -1).toBeGreaterThanOrEqual(0);

		await tempDir.remove();
	});
});
