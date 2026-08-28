/**
 * Regression test for issue #3247.
 *
 * Snapcompact's bundled `MAX_FRAMES_DEFAULT = 80` × `FRAME_TOKEN_ESTIMATE = 5024`
 * ≈ 402k tokens worth of frames. On any sub-1M-token window (e.g. Claude
 * Sonnet 4.5's 200k), passing the default cap to `snapcompact.compact()` made
 * the post-render projection in `AgentSession` always overflow the budget,
 * emit the "snapcompact could not bring the context under the limit" warning
 * on every threshold tick, and downgrade to an LLM summary. The fix sizes the
 * `maxFrames` cap from the live model window (window − reserve − non-message
 * overhead − kept-recent − summary-text reserve) before calling
 * `snapcompact.compact()`.
 *
 * The contract this test defends: for a 200k-window vision model with sane
 * kept-recent traffic, AgentSession MUST pass a budget-sized `maxFrames`
 * (smaller than `MAX_FRAMES_DEFAULT`, and with `maxFrames × FRAME_TOKEN_ESTIMATE`
 * inside the resolved budget) so the projection accepts the snapcompact
 * result instead of falling back to the LLM summarizer.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { effectiveReserveTokens, prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { computeNonMessageTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";

describe("AgentSession snapcompact frame-budget sizing", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled claude-sonnet-4-5 model");
		// Pin the window and output reservation: this contract defends the
		// sub-1M/200k Sonnet failure mode, so catalog regeneration must not change
		// the compaction budget math under test.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		expect(model.input).toContain("image");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		// Seed a representative long-running session: many turn-pairs with
		// substantial filler so prepareCompaction() splits the branch into
		// "discard + summarize" (oldest) vs "kept-recent" (newest).
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		for (let i = 0; i < 64; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: Date.now() - (64 - i) * 1000,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}: ${filler}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 1000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - (64 - i) * 1000 + 100,
			});
		}

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["snapcompact", "soft"],
				"compaction.autoContinue": false,
				// Force a small kept-recent window so the seeded conversation
				// definitely splits into discard + kept and prepareCompaction()
				// returns a non-empty preparation.
				"compaction.keepRecentTokens": 4000,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("passes a maxFrames whose full projection (frames + text edges + base) fits the budget", async () => {
		// Tighten kept-recent into the realistic ~100k-token range. Without
		// it, the helper has so much headroom that even a flawed (too-large)
		// cap reserve passes the `maxFrames × FRAME_TOKEN_ESTIMATE < budget`
		// check by accident. Reviewer chatgpt-codex on #3249 cited the exact
		// failure mode: ~120k headroom on Anthropic 11on16-bw chose 23 frames
		// under the previous 4k-reserve helper, but `23 × 5024 + 7k text
		// edges + 2k summary template + base` then exceeded the same headroom.
		const model = session.model;
		if (!model) throw new Error("Expected model to be set on session");
		const ctxWindow = model.contextWindow ?? 0;
		expect(ctxWindow).toBeGreaterThan(0);

		const settings = { enabled: true as const, reserveTokens: 16384, keepRecentTokens: 4000 };
		const reserve = effectiveReserveTokens(ctxWindow, settings);
		const budget = ctxWindow - reserve;
		// Filler tuned so `baseTokens ≈ 100k`, leaving ~70k headroom — the
		// regime where a shape-aware cap reserve actually matters.
		const targetRecentTokens = 100_000;
		const filler = "x".repeat(targetRecentTokens * 4);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: filler }],
			timestamp: Date.now(),
		});

		const branchEntries = sessionManager.getBranch();
		const firstKeptEntry = branchEntries[branchEntries.length - 1];
		if (!firstKeptEntry?.id) throw new Error("Expected branch entry with id");

		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: firstKeptEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
			},
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const opts = compactSpy.mock.calls[0]?.[1];
		expect(opts).toBeDefined();
		const maxFrames = opts?.maxFrames;
		expect(maxFrames).toBeDefined();
		expect(maxFrames).toBeLessThan(snapcompact.MAX_FRAMES_DEFAULT);
		expect(maxFrames).toBeLessThanOrEqual(snapcompact.maxFramesForDataBudget());
		expect(maxFrames).toBeGreaterThan(0);

		// Verify the FULL projection — base (non-message + kept-recent) +
		// frame-bearing summary cost — fits the budget. The projection
		// {@link #projectSnapcompactContextTokens} mirrors what the auto and
		// manual paths charge: countTokens(summary + textHead + textTail) +
		// numFrames × FRAME_TOKEN_ESTIMATE + non-message + kept-recent.
		const preparation = prepareCompaction(branchEntries, settings);
		if (!preparation) throw new Error("Expected non-empty preparation");
		let baseTokens = computeNonMessageTokens(session, session.agent.tokenizer);
		baseTokens += session.agent.tokenizer.countMessages(preparation.recentMessages);
		const shape = snapcompact.resolveShape(model);
		const edgeCap = snapcompact.geometry(shape).capacity;
		// Worst-case `textHead + textTail` tokenized at the cl100k 4-chars/token
		// baseline, plus a 2k allowance for the snapcompact summary template
		// (intro + FILES section + grid notes).
		const worstCaseEdgeTokens = Math.ceil((2 * edgeCap) / 4) + 2000;
		const fullProjection = baseTokens + (maxFrames ?? 0) * snapcompact.FRAME_TOKEN_ESTIMATE + worstCaseEdgeTokens;
		expect(fullProjection).toBeLessThanOrEqual(budget);
	});

	it("still invokes snapcompact with maxFrames=1 when residual headroom is below the summary-text reserve", async () => {
		// Reviewer (chatgpt-codex on #3249, second pass): when kept-recent +
		// non-message leaves SOME real headroom but less than the 4k
		// SUMMARY_TEXT_RESERVE the helper holds back to size frame caps, the
		// previous revision still went negative and returned 0 (skipped
		// snapcompact). But a text-only snapcompact archive (the
		// `text.length <= 2 * edgeCap` short-circuit in `planArchive`)
		// typically costs only a few hundred tokens of summary lead, far
		// below 4k. The skip decision MUST use raw `baseTokens >= totalBudget`
		// — the cap reserve applies only to the maxFrames math, not the skip.
		const model = session.model;
		if (!model) throw new Error("Expected model");
		const ctxWindow = model.contextWindow ?? 0;
		// Tune kept-recent so the residual `totalBudget − baseTokens` is
		// 1500 tokens — strictly positive, but well below the 4k cap reserve.
		// The previous helper would compute frameBudget = 1500 − 4000 = −2500
		// and return 0; the fixed helper returns 1 because the residual is
		// positive and the text-only archive can still fit.
		const reserve = Math.max(Math.floor(ctxWindow * 0.15), 16384);
		const headroomTokens = 1500;
		const targetRecentTokens = ctxWindow - reserve - headroomTokens;
		// Rough 4-chars-per-token rule for the tiktoken estimator on ASCII.
		const filler = "x".repeat(targetRecentTokens * 4);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: filler }],
			timestamp: Date.now(),
		});

		const branchEntries = sessionManager.getBranch();
		const lastEntry = branchEntries[branchEntries.length - 1];
		if (!lastEntry?.id) throw new Error("Expected branch entry with id");

		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: lastEntry.id,
			tokensBefore: 100_000,
			// Text-only archive: zero frames, modest text edges. The projection
			// charges 0 for frames, so the post-compaction context fits.
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 1000, truncatedChars: 0 },
			},
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const opts = compactSpy.mock.calls[0]?.[1];
		// Snapcompact MUST be invoked with the floor cap, never skipped,
		// even though one frame charge would overflow the budget — the
		// text-only `planArchive` path makes this case recoverable.
		expect(opts?.maxFrames).toBe(1);
	});

	it("applies the frame byte cap when the model context window is unknown", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected model");
		session.agent.setModel({ ...model, contextWindow: 0 });

		const branchEntries = sessionManager.getBranch();
		const lastEntry = branchEntries[branchEntries.length - 1];
		if (!lastEntry?.id) throw new Error("Expected branch entry with id");
		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: lastEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
			},
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(compactSpy.mock.calls[0]?.[1]?.maxFrames).toBe(snapcompact.maxFramesForDataBudget());
	});

	it("caps maxFrames at the provider image budget so unknown gateways do not archive frames the send path will drop", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected model");
		session.agent.setModel({ ...model, provider: "ramp", contextWindow: 500_000 });

		const branchEntries = sessionManager.getBranch();
		const lastEntry = branchEntries[branchEntries.length - 1];
		if (!lastEntry?.id) throw new Error("Expected branch entry with id");
		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: lastEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
			},
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]?.maxFrames).toBe(snapcompact.DEFAULT_PROVIDER_IMAGE_BUDGET);
	});

	it("keeps the frame archive out of the RPC result after persisting it", async () => {
		const branchEntries = sessionManager.getBranch();
		const lastEntry = branchEntries[branchEntries.length - 1];
		if (!lastEntry?.id) throw new Error("Expected branch entry with id");
		const archive = {
			frames: [
				{
					data: "A".repeat(MAX_RPC_FRAME_BYTES),
					mimeType: "image/png",
					cols: 10,
					rows: 10,
					chars: 10,
				},
			],
			totalChars: 10,
			truncatedChars: 0,
		};
		vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: lastEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				extensionState: "keep-me",
				[snapcompact.PRESERVE_KEY]: archive,
			},
		});

		const result = await session.compact(undefined, { mode: "snapcompact" });
		const response = JSON.parse(
			encodeRpcFrame({ id: "c1", type: "response", command: "compact", success: true, data: result }),
		) as { success: boolean; error?: string };

		expect(response).toMatchObject({ success: true });
		expect(result.preserveData).toEqual({ extensionState: "keep-me" });
		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
		expect(compactionEntry.preserveData).toEqual({
			extensionState: "keep-me",
			[snapcompact.PRESERVE_KEY]: archive,
		});
	});

	it("keeps the frame archive out of the auto_compaction_end event after persisting it", async () => {
		const branchEntries = sessionManager.getBranch();
		const lastEntry = branchEntries[branchEntries.length - 1];
		if (!lastEntry?.id) throw new Error("Expected branch entry with id");
		// A zero-frame archive clears the payload/projection gates on the auto
		// path while still carrying PRESERVE_KEY, so the strip is what removes it.
		const archive = { frames: [], totalChars: 1000, truncatedChars: 0 };
		vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: lastEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				extensionState: "keep-me",
				[snapcompact.PRESERVE_KEY]: archive,
			},
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.runIdleCompaction();

		const endEvent = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_end" }> =>
				event.type === "auto_compaction_end" && event.result !== undefined,
		);
		if (!endEvent?.result) throw new Error("Expected a result-carrying auto_compaction_end event");
		expect(endEvent.result.preserveData).toEqual({ extensionState: "keep-me" });
		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
		expect(compactionEntry.preserveData).toEqual({
			extensionState: "keep-me",
			[snapcompact.PRESERVE_KEY]: archive,
		});
	});
});
