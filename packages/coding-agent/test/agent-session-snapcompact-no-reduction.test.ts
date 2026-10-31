/**
 * Regression test for issue #10023.
 *
 * Snapcompact renders archived history text into image frames. When the
 * archived slice is small, the frame overhead (billed at `FRAME_TOKEN_ESTIMATE`
 * per frame) plus the text edges can cost MORE tokens than the original text,
 * so the "compacted" context is larger than the pre-compaction context. The old
 * commit path persisted that inflating result and swapped it into the live
 * agent, growing the context and wedging the next turn.
 *
 * The contract this test defends: a snapcompact result whose projected local
 * context is not smaller than the pre-compaction context (measured on the same
 * tokenizer + non-message overhead, recomputed from the live messages rather
 * than the provider-only `preparation.tokensBefore`) MUST be rejected before it
 * is persisted — manual `/compact snapcompact` throws instead of committing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";

describe("AgentSession snapcompact no-reduction guard", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		expect(model.input).toContain("image");

		// A short conversation so the summarized region is tiny — the archive's
		// frame overhead must dwarf it to prove the guard fires on real growth,
		// not on a large kept tail that would overflow the budget check first.
		const seed: Message[] = [
			{ role: "user", content: [{ type: "text", text: "first question" }], timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 20,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: [{ type: "text", text: "second question" }], timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "second answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 20,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: [{ type: "text", text: "third question" }], timestamp: Date.now() },
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: seed },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		for (const message of seed) sessionManager.appendMessage(message);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["snapcompact"],
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				// Force nearly everything into the summarized region so the archive
				// is what dominates the projection.
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		vi.restoreAllMocks();
	});

	it("rejects a snapcompact result whose frame overhead exceeds the archived text", async () => {
		const branchEntries = sessionManager.getBranch();
		const firstKeptEntry = branchEntries[branchEntries.length - 1];
		if (!firstKeptEntry?.id) throw new Error("Expected branch entry with id");

		// Three frames ≈ 3 × FRAME_TOKEN_ESTIMATE, far more than the handful of
		// tokens in the short summarized conversation — a genuine token increase.
		const frame = { data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 } as const;
		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "archived onto frames",
			shortSummary: "archived",
			firstKeptEntryId: firstKeptEntry.id,
			// Provider-only figure: intentionally large to prove the guard does
			// NOT key on preparation.tokensBefore (imported sessions report 0).
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [frame, frame, frame], totalChars: 12, truncatedChars: 0 },
			},
		});

		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			"snapcompact would not reduce context locally.",
		);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("rejects an inflating automatic result triggered by a large pending prompt", async () => {
		const branchEntries = sessionManager.getBranch();
		const firstKeptEntry = branchEntries[branchEntries.length - 1];
		if (!firstKeptEntry?.id) throw new Error("Expected branch entry with id");

		const frame = { data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 } as const;
		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "archived onto frames",
			shortSummary: "archived",
			firstKeptEntryId: firstKeptEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [frame, frame, frame], totalChars: 12, truncatedChars: 0 },
			},
		});

		let rejectedInflatingSnapcompact = false;
		session.subscribe(event => {
			if (
				event.type === "auto_compaction_end" &&
				event.action === "snapcompact" &&
				event.errorMessage?.includes("would not reduce context")
			) {
				rejectedInflatingSnapcompact = true;
			}
		});
		await session.prompt("pending ".repeat(190_000));

		expect(rejectedInflatingSnapcompact).toBe(true);
		expect(compactSpy).toHaveBeenCalled();
	});

	it("rejects non-shrinking remote/soft auto-compactions instead of committing tokensAfter >= tokensBefore", async () => {
		const customSessionManager = SessionManager.inMemory();
		const model = modelRegistry.find("anthropic", "claude-haiku-5-5");
		if (!model) throw new Error("Expected anthropic/claude-haiku-5-5 model in registry");
		expect(model.contextWindow).toBe(100_000);

		// Under testEnv byteEstimate (4 chars/token), 4 chars = 1 token.
		const seed: Message[] = [
			{ role: "user", content: [{ type: "text", text: "abcd".repeat(28_000) }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "abcd".repeat(28_000) }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 28_000,
					output: 28_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 56_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "abcd".repeat(10_000) }], timestamp: 3 },
		];
		for (const msg of seed) customSessionManager.appendMessage(msg);
		const triggerAssistant: Message = {
			role: "assistant",
			content: [{ type: "text", text: "abcd".repeat(6_000) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 66_000,
				output: 6_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 72_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 4,
		};

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [...seed] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		const customSession = new AgentSession({
			agent,
			sessionManager: customSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdPercent": 40,
				"compaction.thresholdTokens": -1,
				"compaction.keepRecentTokens": 20_000,
				"compaction.reserveTokens": 16_384,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
			}),
			modelRegistry,
			toolRegistry: new Map(),
		});

		try {
			// Summarize the prefix into a bloated 70,000-token summary. The kept tail is capped
			// to land under 0.8 × the 40k trigger, so it keeps only triggerAssistant (6,000
			// tokens), and the post-compaction context (76,000) is still larger than
			// pre-compaction (72,000).
			vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "abcd".repeat(70_000),
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));

			const { promise: compactionEndPromise, resolve } = Promise.withResolvers<{
				action: string;
				result?: compactionModule.CompactionResult;
				errorMessage?: string;
			}>();
			customSession.subscribe(event => {
				if (event.type === "auto_compaction_end") {
					resolve({
						action: event.action,
						result: event.result,
						errorMessage: event.errorMessage,
					});
				}
			});

			customSession.agent.emitExternalEvent({ type: "message_end", message: triggerAssistant });
			customSession.agent.emitExternalEvent({ type: "agent_end", messages: [triggerAssistant] });

			const endEvent = await compactionEndPromise;
			expect(endEvent.result).toBeUndefined();
			expect(endEvent.errorMessage).toContain("would not reduce context");
			const compactionEntries = customSessionManager
				.getBranch()
				.filter((e): e is CompactionEntry => e.type === "compaction");
			expect(compactionEntries).toHaveLength(0);
		} finally {
			await customSession.dispose();
		}
	});

	it("compacts a 100k-window session at its configured 40% trigger and lands the result in the recovery band", async () => {
		const customSessionManager = SessionManager.inMemory();
		const model = modelRegistry.find("anthropic", "claude-haiku-5-5");
		if (!model) throw new Error("Expected anthropic/claude-haiku-5-5 model in registry");
		expect(model.contextWindow).toBe(100_000);

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		const customSession = new AgentSession({
			agent,
			sessionManager: customSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdPercent": 40,
				"compaction.thresholdTokens": -1,
				"compaction.keepRecentTokens": 20_000,
				"compaction.reserveTokens": 16_384,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
			}),
			modelRegistry,
			toolRegistry: new Map(),
		});

		try {
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "concise summary of earlier turns",
				shortSummary: "concise summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));

			// Turns grow 18k -> 36k -> 54k on a 100k window with a 40% (40k) trigger: the
			// trigger is honored, so turn 3 compacts, and the kept tail is capped so the
			// compacted context lands under 0.8 × 40k instead of compacting again at once.
			const turnUsages = [18_000, 36_000, 54_000];
			for (let idx = 0; idx < turnUsages.length; idx++) {
				const total = turnUsages[idx];
				const userMsg: Message = {
					role: "user",
					content: [{ type: "text", text: "abc".repeat(4_000) }],
					timestamp: idx * 2 + 1,
				};
				const assistantMsg: Message = {
					role: "assistant",
					content: [{ type: "text", text: "abc".repeat(4_000) }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: {
						input: total - 9_000,
						output: 9_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: total,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: idx * 2 + 2,
				};
				customSession.agent.emitExternalEvent({ type: "message_end", message: userMsg });
				customSession.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
				customSession.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
				await customSession.waitForIdle();

				if (idx < 2) {
					expect(compactSpy).not.toHaveBeenCalled();
				}
			}

			expect(compactSpy).toHaveBeenCalledTimes(1);
			const compactionEntries = customSessionManager
				.getBranch()
				.filter((e): e is CompactionEntry => e.type === "compaction");
			expect(compactionEntries).toHaveLength(1);
			expect(compactionEntries[0].tokensAfter).toBeDefined();
			expect(compactionEntries[0].tokensAfter!).toBeLessThan(compactionEntries[0].tokensBefore);
			expect(compactionEntries[0].tokensAfter!).toBeLessThanOrEqual(Math.floor(40_000 * 0.8));
		} finally {
			await customSession.dispose();
		}
	});
});
