import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, RESCUE_SHAKE_CONFIG, Tokenizer } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession shake", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	/** Seed a user → assistant(toolCall) → toolResult turn carrying a heavy bash result. */
	function seedHeavyToolResult(text: string, toolName = "bash"): void {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do it" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "ls" } },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now() - 1,
		});
	}

	/** Build enough recent content to place a seeded result outside manual shake's protected tail. */
	function recentProtectedTail(label: string): string {
		return `${label}\n${"tail ".repeat(4_000)}`;
	}

	function appendRecentProtectedTail(): void {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: recentProtectedTail("newer context") }],
			timestamp: Date.now() + 2,
		});
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	describe("elide", () => {
		it("drops the tool result, offloads to an artifact, and embeds the recovery link", async () => {
			seedHeavyToolResult("X".repeat(4000));
			appendRecentProtectedTail();
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const result = await session.shake("elide");

			expect(result.mode).toBe("elide");
			expect(result.toolResultsDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(result.artifactId).toBeDefined();
			expect(replaceSpy).toHaveBeenCalled();

			const [tr] = branchToolResults();
			expect(tr.prunedAt).toBeGreaterThan(0);
			const text = tr.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(text).toContain(`artifact://${result.artifactId}`);
			expect(text).toContain("shaken");
		});

		it("updates provider-anchored context usage immediately after rewriting prompt history", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: recentProtectedTail("done") }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(
				sessionManager
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			);
			const before = session.getContextUsage()?.tokens;
			expect(before).toBe(20_000);

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(20_000 - result.tokensFreed);
			const anchor = sessionManager
				.getBranch()
				.findLast(
					entry =>
						entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
				);
			expect(
				anchor?.type === "message" && anchor.message.role === "assistant"
					? anchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBe(result.tokensFreed);
		});

		it("skips response-only usage when selecting the correction anchor", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: recentProtectedTail("anchored") }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "response-only" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 0, output: 8, totalTokens: 8 },
				timestamp: Date.now() + 1,
			});
			session.agent.replaceMessages(
				sessionManager
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			);
			const before = session.getContextUsage()?.tokens;
			expect(before).toBeDefined();

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(before! - result.tokensFreed);
			const assistants = sessionManager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "assistant");
			const usableAnchor = assistants.at(-2);
			const responseOnly = assistants.at(-1);
			expect(
				usableAnchor?.type === "message" && usableAnchor.message.role === "assistant"
					? usableAnchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBe(result.tokensFreed);
			expect(
				responseOnly?.type === "message" && responseOnly.message.role === "assistant"
					? responseOnly.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBeUndefined();
		});

		it("does not subtract remote-compacted entries omitted from the provider prompt", async () => {
			seedHeavyToolResult("X".repeat(20_000));
			const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
			if (!firstKeptEntryId) throw new Error("Expected seeded branch");
			sessionManager.appendCompaction("remote summary", undefined, firstKeptEntryId, 10_000, {
				details: {},
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [],
					},
				},
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: recentProtectedTail("post-compaction") }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			expect(session.getContextUsage()?.tokens).toBe(20_000);

			const result = await session.shake("elide");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(20_000);
			const anchor = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(
				anchor?.type === "message" && anchor.message.role === "assistant"
					? anchor.message.contextSnapshot?.historyRewriteTokensRemoved
					: undefined,
			).toBeUndefined();
		});

		it("returns zero counts for an empty branch", async () => {
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
		});
	});

	describe("images", () => {
		it("mirrors dropImages and reports the removed image count", async () => {
			const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "look" }, png],
				timestamp: Date.now(),
			});

			const result = await session.shake("images");

			expect(result.mode).toBe("images");
			expect(result.imagesDropped).toBe(1);
			const branch = sessionManager.getBranch();
			const userMsg = branch.find(e => e.type === "message" && (e.message as { role?: string }).role === "user");
			const content = (userMsg as { message: { content: unknown } }).message.content as Array<{ type: string }>;
			expect(content.some(b => b.type === "image")).toBe(false);
		});
	});

	describe("thinking", () => {
		it("drops both thinking variants, keeps empty turns empty, and refreshes persisted and runtime state", async () => {
			const mixed: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reasoning ".repeat(1_000) },
					{ type: "redactedThinking", data: "opaque-reasoning" },
					{ type: "text", text: "visible answer" },
				],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now(),
			};
			const thinkingOnly: AssistantMessage = {
				role: "assistant",
				content: [{ type: "thinking", thinking: "private reasoning" }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now() + 1,
			};
			sessionManager.appendMessage(mixed);
			sessionManager.appendMessage(thinkingOnly);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const tokenizer = new Tokenizer();
			const tokensBefore = tokenizer.countMessage(mixed);

			const result = await session.shake("thinking");

			expect(result.thinkingBlocksDropped).toBe(3);
			expect(mixed.content).toEqual([{ type: "text", text: "visible answer" }]);
			expect(thinkingOnly.content).toEqual([]);
			expect(tokenizer.countMessage(mixed)).toBeLessThan(tokensBefore);

			const runtimeAssistants = session.agent.state.messages.filter(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			expect(runtimeAssistants.flatMap(message => message.content.map(block => block.type))).toEqual(["text"]);
			expect(runtimeAssistants.some(message => message.content.length === 0)).toBe(true);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted shake session");
			const persisted = await SessionManager.open(sessionFile, tempDir.path());
			try {
				const persistedAssistants = persisted
					.getBranch()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
					);
				expect(persistedAssistants.flatMap(message => message.content.map(block => block.type))).toEqual(["text"]);
				expect(persistedAssistants.some(message => message.content.length === 0)).toBe(true);
			} finally {
				await persisted.close();
			}
		});
	});

	describe("protected tools", () => {
		it("never shakes skill results", async () => {
			seedHeavyToolResult("S".repeat(4000), "skill");
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
		});

		/** Seed a user → assistant(read toolCall) → toolResult turn recovering an artifact. */
		function seedArtifactRecoveryResult(text: string, args: Record<string, unknown>, details?: unknown): void {
			const toolCallId = `call_read_${Math.random().toString(36).slice(2)}`;
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "recover it" }],
				timestamp: Date.now() - 3,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{ type: "text", text: "recovering" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: args },
				],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text }],
				...(details === undefined ? {} : { details }),
				isError: false,
				timestamp: Date.now() - 1,
			});
		}

		it("rescue config never re-elides artifact recovery reads, by path or by source meta", async () => {
			seedArtifactRecoveryResult("R".repeat(4000), { path: "artifact://0" });
			seedArtifactRecoveryResult(
				"F".repeat(4000),
				{ path: "/tmp/artifacts/3.shake.log" },
				{
					meta: { source: { type: "internal", value: "artifact://3" } },
				},
			);
			const result = await session.shake("elide", { config: RESCUE_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(0);
			const texts = branchToolResults().map(m => (m.content[0] as { text: string }).text);
			expect(texts.some(t => t.startsWith("R"))).toBe(true);
			expect(texts.some(t => t.startsWith("F"))).toBe(true);
		});

		it("rescue config still elides ordinary oversized results", async () => {
			seedHeavyToolResult("B".repeat(4000));
			seedArtifactRecoveryResult("R".repeat(4000), { path: "artifact://0" });
			const result = await session.shake("elide", { config: RESCUE_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(1);
			const texts = branchToolResults().map(m => (m.content[0] as { text: string }).text);
			expect(texts.some(t => t.startsWith("B"))).toBe(false);
			expect(texts.some(t => t.startsWith("R"))).toBe(true);
		});
	});

	describe("auto-shake strategy", () => {
		it("dispatches the elide path and emits a shake action for threshold maintenance", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Reclaim enough that the corrected (provider − tokensFreed) figure lands
			// inside the 80% recovery band — otherwise the #2275 post-shake check would
			// (correctly) declare pressure unresolved and fall back to context-full.
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10_000 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
			const start = events.filter(e => e.type === "auto_compaction_start");
			expect(start).toHaveLength(1);
			expect(start[0]).toMatchObject({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
			const end = events.filter(e => e.type === "auto_compaction_end");
			expect(end).toHaveLength(1);
			expect(end[0]).toMatchObject({ type: "auto_compaction_end", action: "shake" });
		});

		it("keeps a successful overflow shake recovery committed before retrying", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("contextPromotion.enabled", false);
			seedHeavyToolResult("X ".repeat(20000));
			branchToolResults()[0].useless = true;
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				...apiInfo,
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				usage: {
					input: 250_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 250_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "error",
						errorMessage: assistantMessage.errorMessage,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMessage.errorMessage,
				}),
			);
		});

		it("keeps a no-op incomplete shake retry committed before rollback can restore the length tail", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("contextPromotion.enabled", false);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "partial response" }],
				...apiInfo,
				stopReason: "length",
				usage: {
					input: 20_000,
					output: 5_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 25_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						timestamp: assistantMessage.timestamp,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "length",
					timestamp: assistantMessage.timestamp,
				}),
			);
		});

		it("has isCompacting true when the shake auto_compaction_start event fires", async () => {
			// Defect 1 parity for the shake strategy: the controller backing isCompacting
			// must be installed before auto_compaction_start is emitted, so a message
			// typed as the loader appears is queued safely rather than mis-routed.
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			let capturedIsCompacting: boolean | undefined;
			const { promise: shakeStarted, resolve: onShakeStarted } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start" && event.action === "shake") {
					capturedIsCompacting = session.isCompacting;
					onShakeStarted();
				}
			});

			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 1,
				blocksDropped: 0,
				tokensFreed: 10_000,
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await shakeStarted;

			expect(capturedIsCompacting).toBe(true);
		});

		it("advances to soft compaction when shake cannot drop context below the threshold (regression #2119)", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Seed agent state so the post-shake estimate is well above the 1% threshold
			// (~2K tokens for a 200K window). The mocked shake returns reclaimed=true but
			// does not modify state, mimicking the dead-loop scenario where shake removes
			// nothing material yet the threshold check stays positive.
			session.agent.replaceMessages([
				{
					role: "user",
					content: [{ type: "text", text: "x".repeat(40000) }],
					timestamp: Date.now(),
				} as never,
			]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();

			// Shake fires once. The pre-fix bug auto-continued, which would re-trigger shake
			// on the next agent_end. The fix replaces that loop with a one-shot fallback.
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/trying the next preferred compaction method/i);

			// Fallback enters the context-full path so the situation actually resolves.
			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("falls back when provider-reported usage stays above the threshold even though the local estimate is below it (regression #2275)", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdTokens", 5_000);
			session.settings.set("contextPromotion.enabled", false);

			// Agent state holds almost no content, so #estimatePendingPromptTokens reads
			// well below the 5K threshold. The pre-fix post-shake check trusted that
			// estimate and treated the pressure as resolved, even though the assistant
			// message's provider-reported usage (11K) was well above the threshold.
			// This is the metric-divergence dead loop from #2275: thinking-heavy
			// sessions hit it for real (thinkingSignature payloads aren't counted by
			// the estimator), and an empty-state probe mimics it deterministically.
			session.agent.replaceMessages([]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/trying the next preferred compaction method/i);

			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("counts pre-shake prune savings when deciding whether to fall back to context-full", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdTokens", 76384);
			session.settings.set("compaction.thresholdPercent", -1);
			session.settings.set("compaction.dropUseless", true);
			session.settings.set("contextPromotion.enabled", false);

			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: "Investigate every module of the project.",
				timestamp: now - 200,
			});
			const bigCallId = "call-big-useless-for-shake";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: now - 180,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: bigCallId,
				toolName: "grep",
				content: [{ type: "text", text: "match line\n".repeat(20000) }],
				isError: false,
				useless: true,
				timestamp: now - 170,
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 100 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 5000,
					output: 1000,
					cacheRead: 85000,
					cacheWrite: 0,
					totalTokens: 91000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now,
			};

			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeUndefined();
		});

		it("falls back after pre-prompt shake when the floored stored conversation remains over threshold", async () => {
			session.settings.set("compaction.methodOrder", ["shake", "soft"]);
			session.settings.set("compaction.thresholdTokens", 8_000);
			session.settings.set("compaction.keepRecentTokens", 1);
			session.settings.set("contextPromotion.enabled", false);

			const seedUser: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "seed" }],
				timestamp: Date.now() - 2,
			};
			const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
			const seedAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: bulkText }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - 1,
			};
			sessionManager.appendMessage(seedUser);
			sessionManager.appendMessage(seedAssistant);
			session.agent.replaceMessages([seedUser, seedAssistant]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "pre-prompt shake fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

			expect(session.getContextUsage({ contextWindow: 200_000 })?.tokens).toBe(1_000);

			await session.prompt("small pending prompt", { skipCompactionCheck: true });

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy).toHaveBeenCalled();
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});
	});
});
