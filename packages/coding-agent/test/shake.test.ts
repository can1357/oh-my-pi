import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, RESCUE_SHAKE_CONFIG, Tokenizer } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatShakeSummary } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgCompactionDropUseless,
	cfgCompactionKeepRecentTokens,
	cfgCompactionMethodOrder,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
	cfgContextPromotionEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";

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
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		setSystemTime();
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

		it("continues artifact-less when ordinary shake cannot allocate an artifact", async () => {
			seedHeavyToolResult("X".repeat(4000));
			appendRecentProtectedTail();
			const allocateArtifactPath = vi
				.spyOn(sessionManager, "allocateArtifactPath")
				.mockRejectedValue(new Error("artifact directory unavailable"));
			const saveArtifact = vi.spyOn(sessionManager, "saveArtifact").mockResolvedValue(undefined);

			const result = await session.shake("elide");

			expect(result.toolResultsDropped).toBe(1);
			expect(result.artifactId).toBeUndefined();
			const [toolResult] = branchToolResults();
			expect(toolResult.content).toEqual([{ type: "text", text: expect.stringContaining("[shaken ~") }]);
			expect(toolResult.content).not.toEqual([{ type: "text", text: expect.stringContaining("artifact://") }]);
			saveArtifact.mockRestore();
			allocateArtifactPath.mockRestore();
		});

		it("preserves mixed tool-result images while eliding only recoverable text", async () => {
			const largeText = "mixed tool output ".repeat(2_000);
			const image: ImageContent = {
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
				mimeType: "image/png",
				detail: "original",
				providerFile: { provider: "openai", id: "file_shake_image" },
				url: "https://images.example.invalid/shake.png",
			};
			const imageSnapshot = structuredClone(image);
			seedHeavyToolResult(largeText);
			const [mixedResult] = branchToolResults();
			mixedResult.content = [{ type: "text", text: largeText }, image];
			const tailBefore = recentProtectedTail("newer context");
			appendRecentProtectedTail();

			const result = await session.shake("elide");

			expect(result.toolResultsDropped).toBe(1);
			expect(result.imagesDropped).toBeUndefined();
			expect(result.artifactId).toBeDefined();
			const placeholder = mixedResult.content[0];
			expect(placeholder?.type).toBe("text");
			if (placeholder?.type !== "text") throw new Error("Expected shake placeholder text");
			expect(placeholder.text).toContain("shaken");
			expect(placeholder.text).toContain(`artifact://${result.artifactId}`);
			expect(mixedResult.content[1]).toBe(image);
			expect(mixedResult.content[1]).toEqual(imageSnapshot);

			const tokenizer = new Tokenizer();
			const expectedFreed = tokenizer.countTokens(largeText) - tokenizer.countTokens(placeholder.text);
			expect(result.tokensFreed).toBe(expectedFreed);
			expect(result.tokensFreed).toBeGreaterThan(0);

			if (!result.artifactId) throw new Error("Expected shake artifact");
			const artifactPath = await sessionManager.getArtifactPath(result.artifactId);
			if (!artifactPath) throw new Error("Expected persisted shake artifact");
			expect(await Bun.file(artifactPath).text()).toContain(largeText);

			const latestUser = sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "user");
			expect(
				latestUser?.type === "message" && latestUser.message.role === "user"
					? latestUser.message.content
					: undefined,
			).toEqual([{ type: "text", text: tailBefore }]);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted shake session");
			const persisted = await SessionManager.open(sessionFile, tempDir.path());
			try {
				const persistedResult = persisted
					.getBranch()
					.find(
						entry =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === mixedResult.toolCallId,
					);
				const persistedImage =
					persistedResult?.type === "message" && persistedResult.message.role === "toolResult"
						? persistedResult.message.content.find(block => block.type === "image")
						: undefined;
				expect(persistedImage).toEqual(imageSnapshot);
			} finally {
				await persisted.close();
			}

			const imageResult = await session.shake("images");
			expect(imageResult.imagesDropped).toBe(1);
			expect(mixedResult.content.some(block => block.type === "image")).toBe(false);
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
			const tokensBefore = tokenizer.countMessage(mixed, { excludeEncryptedReasoning: true });
			const thinkingOnlyBefore = tokenizer.countMessage(thinkingOnly, { excludeEncryptedReasoning: true });

			const result = await session.shake("thinking");

			expect(result.thinkingBlocksDropped).toBe(3);
			expect(mixed.content).toEqual([{ type: "text", text: "visible answer" }]);
			expect(thinkingOnly.content).toEqual([]);
			expect(tokenizer.countMessage(mixed, { excludeEncryptedReasoning: true })).toBeLessThan(tokensBefore);
			const measuredSaving =
				tokensBefore +
				thinkingOnlyBefore -
				tokenizer.countMessage(mixed, { excludeEncryptedReasoning: true }) -
				tokenizer.countMessage(thinkingOnly, { excludeEncryptedReasoning: true });
			expect(measuredSaving).toBeGreaterThan(0);
			expect(result.tokensFreed).toBe(measuredSaving);
			expect(formatShakeSummary(result)).toContain(`~${result.tokensFreed} tokens freed`);

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

		it("does not inflate reported savings with opaque signature bytes", async () => {
			const signed: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "short", thinkingSignature: "S".repeat(20_000) },
					{ type: "text", text: "answer" },
				],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now(),
			};
			sessionManager.appendMessage(signed);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const tokenizer = new Tokenizer();
			const before = tokenizer.countMessage(signed, { excludeEncryptedReasoning: true });
			const rawBefore = tokenizer.countMessage(signed);
			const result = await session.shake("thinking");

			expect(result.thinkingBlocksDropped).toBe(1);
			expect(result.tokensFreed).toBe(before - tokenizer.countMessage(signed, { excludeEncryptedReasoning: true }));
			expect(result.tokensFreed).toBeLessThan(rawBefore - tokenizer.countMessage(signed));
		});

		it("updates the provider-anchored context meter for earlier thinking", async () => {
			const prior: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "old reasoning ".repeat(1_000) },
					{ type: "text", text: "old answer" },
				],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: Date.now() - 1,
			};
			sessionManager.appendMessage(prior);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "latest answer" }],
				...apiInfo,
				stopReason: "stop",
				usage: { ...usage, input: 20_000, totalTokens: 20_008 },
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			expect(session.getContextUsage()?.tokens).toBe(20_000);

			const result = await session.shake("thinking");

			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(session.getContextUsage()?.tokens).toBe(20_000 - result.tokensFreed);
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

	describe("cache-expired shake on user turns", () => {
		async function seedConversation(
			ageMs: number,
			selectedModel?: Model,
			apiKey = "test-key",
		): Promise<ToolResultMessage> {
			// Catalog declares `prompt-cache { short 300; long 3600 }` for first-party Anthropic.
			const model = selectedModel ?? getBundledModel("anthropic", "claude-sonnet-5");
			if (!model) throw new Error("Expected test model to exist");
			authStorage.keys.setRuntime(model.provider, apiKey);
			apiInfo = { api: model.api, provider: model.provider, model: model.id };

			const completedAt = Date.now() - ageMs;
			const toolCallId = "call_cold_cache";
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "inspect the large output" }],
				timestamp: completedAt - 3,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "build" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: completedAt - 2,
			});
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "cold output ".repeat(12_000) }],
				isError: false,
				timestamp: completedAt - 1,
			};
			sessionManager.appendMessage(result);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `finished\n${"tail ".repeat(20_000)}` }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: completedAt,
			});
			await sessionManager.rewriteEntries();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await session.dispose();
			sessionManager = await SessionManager.open(sessionFile, tempDir.path());
			const resumedAgent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done again"] }] }).stream,
			});
			session = new AgentSession({
				agent: resumedAgent,
				sessionManager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"compaction.shakeOnCacheExpiry": true,
				}),
				modelRegistry,
			});
			session.subscribe(event => events.push(event));
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const resumedResult = session.messages.find(
				message => message.role === "toolResult" && message.toolCallId === result.toolCallId,
			);
			if (resumedResult?.role !== "toolResult") throw new Error("Expected resumed tool result");
			return resumedResult;
		}

		it("preserves a warm Claude prefix when the user returns inside the declared lifetime", async () => {
			const result = await seedConversation(4 * 60_000);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue");

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(result.prunedAt).toBeUndefined();
		});

		it("shakes an expired Claude prefix before the first resumed user turn", async () => {
			const result = await seedConversation(5 * 60_000 + 1);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue after reopening");

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain("shaken");
		});

		it("never shakes a model without a catalog-declared prompt-cache lifetime", async () => {
			// Unknown lifetime is not an expired one: providers opt in through the
			// KDL `prompt-cache` axis, never through a generic fallback.
			const result = await seedConversation(24 * 60 * 60_000, createMockModel());
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue on a model with no declared lifetime");

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(result.prunedAt).toBeUndefined();
		});

		it("uses the one-hour tier for an Anthropic OAuth seat when the turn reported no tier", async () => {
			// OAuth subscriber seats write 1h entries by default (cache-warmer /
			// request-builder semantics); 30 minutes later the prefix is still warm.
			const result = await seedConversation(30 * 60_000, undefined, "sk-ant-oat01-test");
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue on a subscription seat");

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(result.prunedAt).toBeUndefined();
		});

		it("uses the five-minute tier for an Anthropic API key when the turn reported no tier", async () => {
			const result = await seedConversation(30 * 60_000, undefined, "sk-ant-api03-test");
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue on a pay-per-token key");

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
		});

		it("shakes before an expired queued user follow-up resumes", async () => {
			const result = await seedConversation(60 * 60_000 + 1);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.followUp("queued after the cache expired");
			await Bun.sleep(0);
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
		});

		it("shakes before an expired queued user steer resumes", async () => {
			const result = await seedConversation(60 * 60_000 + 1);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.steer("steered after the cache expired");
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
		});

		it("still shakes when a failed turn left a fresh timestamp on a cold cache", async () => {
			const result = await seedConversation(60 * 60_000 + 1);
			// An aborted turn never reached the provider, so it cannot have warmed
			// the prefix — its fresh timestamp must not postpone the shake.
			session.agent.replaceMessages([
				...session.messages,
				{
					role: "assistant",
					content: [{ type: "text", text: "interrupted" }],
					...apiInfo,
					stopReason: "aborted",
					usage,
					timestamp: Date.now(),
				},
			]);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("continue after the failed turn");

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
		});

		it("treats a writable collaboration prompt as a user turn", async () => {
			const result = await seedConversation(60 * 60_000 + 1);
			const shakeSpy = vi.spyOn(session, "shake");

			await session.promptCustomMessage({
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: "continue from a collaborator",
				display: true,
				details: { from: "reviewer" },
				attribution: "user",
			});

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(result.prunedAt).toBeGreaterThan(0);
		});
	});

	describe("cache-expired shake before every provider request", () => {
		/**
		 * Seed an older heavy bash result that sits outside the auto-shake protect
		 * window, with a fresh timestamp so the cache reads warm at the first
		 * request of the next prompt.
		 */
		function seedWarmHeavyHistory(model: Model): ToolResultMessage {
			authStorage.keys.setRuntime(model.provider, "test-key");
			apiInfo = { api: model.api, provider: model.provider, model: model.id };
			const toolCallId = "call_warm_history";
			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "inspect the large output" }],
				timestamp: now - 3,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "build" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: now - 2,
			});
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "warm output ".repeat(12_000) }],
				isError: false,
				timestamp: now - 1,
			};
			sessionManager.appendMessage(result);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `finished\n${"tail ".repeat(20_000)}` }],
				...apiInfo,
				stopReason: "stop",
				usage,
				timestamp: now,
			});
			return result;
		}

		/**
		 * Replace the default session with one whose mock model answers the
		 * prompt with a `bash` tool call, then a final text turn. `onToolRun`
		 * executes inside the tool call, between the two provider requests.
		 */
		async function openToolLoopSession(options: {
			onToolRun: () => void;
			settings: Settings;
			agentKind?: "main" | "sub";
			/** Catalog-declared prompt-cache lifetimes (seconds per tier) for the mock model. */
			promptCache?: Model["promptCache"];
			cacheWarmer?: CacheWarmer;
		}): Promise<{ model: MockModel; seeded: ToolResultMessage; requests: string[] }> {
			const model = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "call_loop", name: "bash", arguments: { command: "sleep" } }] },
					{ content: ["Done"] },
				],
			});
			// Generic mock models declare nothing; this path is opt-in via the
			// catalog, so give the mock the common 5-minute tier unless a test
			// supplies its own lifetimes.
			model.promptCache = options.promptCache ?? { short: 300 };
			const seeded = seedWarmHeavyHistory(model);
			await sessionManager.rewriteEntries();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session");
			await session.dispose();
			sessionManager = await SessionManager.open(sessionFile, tempDir.path());
			const bashTool: AgentTool = {
				name: "bash",
				label: "Bash",
				description: "Mock bash tool",
				parameters: type({}),
				execute: async () => {
					options.onToolRun();
					return { content: [{ type: "text" as const, text: "fresh tool output" }] };
				},
			};
			// Snapshot each request's wire context at call time: shake mutates the
			// journaled messages in place, so a live reference would show the
			// post-shake text for the first request too.
			const requests: string[] = [];
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
				streamFn: (streamModel, context, options) => {
					requests.push(JSON.stringify(context.messages));
					return model.stream(streamModel, context, options);
				},
			});
			session = new AgentSession({
				agent,
				sessionManager,
				settings: options.settings,
				modelRegistry,
				agentKind: options.agentKind,
				cacheWarmer: options.cacheWarmer,
			});
			session.subscribe(event => events.push(event));
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			return { model, seeded, requests };
		}

		function seededBranchResult(seeded: ToolResultMessage): ToolResultMessage {
			const match = branchToolResults().find(message => message.toolCallId === seeded.toolCallId);
			if (!match) throw new Error("Expected the seeded tool result on the branch");
			return match;
		}

		it("shakes between tool-loop requests once a long tool call outlives the cache TTL", async () => {
			const { model, seeded, requests } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": true }),
				// The declared lifetime is 5 minutes; a tool call that runs longer
				// leaves the prefix cold for the request that carries its result.
				onToolRun: () => setSystemTime(new Date(Date.now() + 6 * 60_000)),
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the slow build");
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.objectContaining({ config: expect.anything() }));
			expect(seededBranchResult(seeded).prunedAt).toBeGreaterThan(0);
			expect(model.calls).toHaveLength(2);
			expect(requests).toHaveLength(2);
			// First request went out against the warm prefix untouched.
			expect(requests[0]).toContain("warm output");
			// Second request replays the shaken prefix AND still carries the tool
			// result that was pending (not yet journaled) when the rewrite ran.
			expect(requests[1]).not.toContain("warm output");
			expect(requests[1]).toContain("shaken");
			expect(requests[1]).toContain("fresh tool output");
			expect(requests[1]).toContain("run the slow build");
			// The loop finished on the rebuilt context without stranding anything.
			const last = session.messages.at(-1);
			expect(last?.role).toBe("assistant");
			expect(JSON.stringify(last?.content)).toContain("Done");
		});

		it("uses the catalog-declared prompt-cache lifetime of the model", async () => {
			const { model, seeded } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": true }),
				// Declared 30-minute short tier: a 6-minute tool call still finds the
				// prefix warm.
				promptCache: { short: 30 * 60 },
				onToolRun: () => setSystemTime(new Date(Date.now() + 6 * 60_000)),
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the slow build");
			await session.waitForIdle();

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(seededBranchResult(seeded).prunedAt).toBeUndefined();
			expect(model.calls).toHaveLength(2);
		});

		it("shakes once a tool call outlives the catalog-declared lifetime", async () => {
			const { seeded, requests } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": true }),
				promptCache: { short: 30 * 60 },
				onToolRun: () => setSystemTime(new Date(Date.now() + 31 * 60_000)),
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the slow build");
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(seededBranchResult(seeded).prunedAt).toBeGreaterThan(0);
			expect(requests[1]).not.toContain("warm output");
		});

		it("treats a successful cache-warmer refresh as a cache touch", async () => {
			const cacheWarmer = new CacheWarmer({
				stream: () => {
					throw new Error("not used");
				},
				getPromptTokens: () => 0,
				getMode: () => "off",
			});
			const { model, seeded } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": true }),
				cacheWarmer,
				onToolRun: () => {
					// The warmer refreshed the prefix 4.5 minutes into a 6-minute tool
					// call: the entry is only 1.5 minutes old when the next request goes out.
					setSystemTime(new Date(Date.now() + 4.5 * 60_000));
					cacheWarmer.onWarmed?.(
						{
							role: "assistant",
							content: [],
							...apiInfo,
							stopReason: "stop",
							usage,
							timestamp: Date.now(),
						} as AssistantMessage,
						false,
					);
					setSystemTime(new Date(Date.now() + 1.5 * 60_000));
				},
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the slow build");
			await session.waitForIdle();

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(seededBranchResult(seeded).prunedAt).toBeUndefined();
			expect(model.calls).toHaveLength(2);
		});

		it("leaves a tool loop alone while the cache stays warm", async () => {
			const { model, seeded } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": true }),
				onToolRun: () => {},
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the fast build");
			await session.waitForIdle();

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(seededBranchResult(seeded).prunedAt).toBeUndefined();
			expect(model.calls).toHaveLength(2);
		});

		it("does nothing when compaction.shakeOnCacheExpiry is off", async () => {
			const { seeded } = await openToolLoopSession({
				settings: Settings.isolated({ "compaction.enabled": false, "compaction.shakeOnCacheExpiry": false }),
				onToolRun: () => setSystemTime(new Date(Date.now() + 6 * 60_000)),
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("run the slow build");
			await session.waitForIdle();

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(seededBranchResult(seeded).prunedAt).toBeUndefined();
		});

		it("applies to subagent sessions through the inherited settings", async () => {
			const parentSettings = Settings.isolated({
				"compaction.enabled": false,
				"compaction.shakeOnCacheExpiry": true,
			});
			const { model, seeded, requests } = await openToolLoopSession({
				settings: createSubagentSettings(parentSettings),
				agentKind: "sub",
				onToolRun: () => setSystemTime(new Date(Date.now() + 6 * 60_000)),
			});
			const shakeSpy = vi.spyOn(session, "shake");

			await session.prompt("subagent task");
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(seededBranchResult(seeded).prunedAt).toBeGreaterThan(0);
			expect(model.calls).toHaveLength(2);
			expect(requests[1]).toContain("shaken");
			expect(requests[1]).toContain("fresh tool output");
		});
	});

	describe("auto-shake strategy", () => {
		it("dispatches the elide path and emits a shake action for threshold maintenance", async () => {
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdPercent.set(session.settings, 1);
			cfgContextPromotionEnabled.set(session.settings, false);

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgContextPromotionEnabled.set(session.settings, false);
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

		it("keeps an incomplete shake retry committed before rollback can restore the length tail", async () => {
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			// Over threshold: the window, not the output cap, ran out, so recovery compacts.
			cfgCompactionThresholdTokens.set(session.settings, 10_000);
			cfgContextPromotionEnabled.set(session.settings, false);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
			const shakeSpy = vi
				.spyOn(session, "shake")
				// Reclaims back under the recovery band, so shake retries instead of falling back.
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 20_000 });

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdPercent.set(session.settings, 1);
			cfgContextPromotionEnabled.set(session.settings, false);

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdPercent.set(session.settings, 1);
			cfgContextPromotionEnabled.set(session.settings, false);

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdTokens.set(session.settings, 5_000);
			cfgContextPromotionEnabled.set(session.settings, false);

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdTokens.set(session.settings, 76384);
			cfgCompactionThresholdPercent.set(session.settings, -1);
			cfgCompactionDropUseless.set(session.settings, true);
			cfgContextPromotionEnabled.set(session.settings, false);

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
			cfgCompactionMethodOrder.set(session.settings, ["shake", "soft"]);
			cfgCompactionThresholdTokens.set(session.settings, 8_000);
			cfgCompactionKeepRecentTokens.set(session.settings, 1);
			cfgContextPromotionEnabled.set(session.settings, false);

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
