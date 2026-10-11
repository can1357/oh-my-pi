/**
 * Snapcompact archive size follows the room under the compaction trigger, not
 * the window: half of what the trigger leaves after the system prompt, kept
 * turns and the archive's text, planned within 60% of the trigger.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { rejectionOf } from "./helpers/rejection";

const SHARE = 0.5;
const TARGET = 0.6;

describe("snapcompact archive sized by the compaction trigger", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function opus(contextWindow: number): Model {
		const bundled = getBundledModel("anthropic", "claude-opus-5-5");
		if (!bundled) throw new Error("Expected bundled claude-opus-5-5");
		return { ...bundled, contextWindow, maxTokens: 64_000 };
	}

	/** A session whose discarded history needs `turns × ~2.6k` chars of archive. */
	function createSession(
		model: Model,
		overrides: Record<string, unknown>,
		turns = 64,
	): { session: AgentSession; notices: string[] } {
		const sessionManager = SessionManager.inMemory();
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		for (let i = 0; i < turns; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: Date.now() - (turns - i) * 1000,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}: ${filler}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 1000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - (turns - i) * 1000 + 100,
			});
		}
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["snapcompact", "soft"],
				"compaction.autoContinue": false,
				"compaction.keepRecentTokens": 4000,
				...overrides,
			}),
			modelRegistry,
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		});
		sessions.push(session);
		return { session, notices };
	}

	/** What the frame cap charges per frame of `model`'s shape: its own price, at least the ceiling. */
	function framePrice(model: Model): number {
		return Math.max(snapcompact.FRAME_TOKEN_ESTIMATE, snapcompact.resolveShape(model).frameTokenEstimate);
	}

	/** Tokens the session's tokenizer charges for the committed archive's frames. */
	function committedFrameTokens(session: AgentSession): number {
		const summary = session.messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected a compaction summary message");
		const blocks = summary.blocks ?? [];
		const textOnly = { ...summary, blocks: blocks.filter(block => block.type === "text") };
		return session.agent.tokenizer.countMessage(summary) - session.agent.tokenizer.countMessage(textOnly);
	}

	function latestArchive(session: AgentSession): snapcompact.Archive | undefined {
		const entry = session.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		return snapcompact.getPreservedArchive(entry?.type === "compaction" ? entry.preserveData : undefined);
	}

	/** Stub render that records maxFrames and stops the pass before anything is committed. */
	function stopAtRender(): number[] {
		const requested: number[] = [];
		vi.spyOn(snapcompact, "compact").mockImplementation(async (_preparation, options) => {
			requested.push(options?.maxFrames ?? -1);
			throw new Error("stop after sizing");
		});
		return requested;
	}

	/** maxFrames the session hands snapcompact for one manual snapcompact pass. */
	async function requestedFrames(model: Model, overrides: Record<string, unknown>): Promise<number> {
		const { session } = createSession(model, overrides);
		const spy = vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => ({
			summary: "stub",
			shortSummary: "stub",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: { snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 } },
		}));
		await session.compact(undefined, { mode: "snapcompact" });
		const maxFrames = spy.mock.calls[0]?.[1]?.maxFrames;
		spy.mockRestore();
		if (maxFrames === undefined) throw new Error("snapcompact.compact was not called");
		return maxFrames;
	}

	/** Answer every model request with "ok", recording the stored context and compaction count each request saw. */
	function recordRequests(session: AgentSession, model: Model): { tokens: number; compactions: number }[] {
		const requests: { tokens: number; compactions: number }[] = [];
		session.agent.streamFn = () => {
			requests.push({
				tokens: storedContextTokens(session),
				compactions: session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length,
			});
			const response = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ok" }],
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
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		};
		return requests;
	}

	/** A user prompt of `repeats` filler sentences and what the tokenizer charges for it. */
	function largePrompt(session: AgentSession, repeats: number): { prompt: string; promptTokens: number } {
		const prompt = `please read this: ${"the quick brown fox jumps over the lazy dog. ".repeat(repeats)}`;
		const promptTokens = session.agent.tokenizer.countMessage({
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		});
		return { prompt, promptTokens };
	}

	/** What the compaction trigger counts for the session's current context (stored estimate). */
	function storedContextTokens(session: AgentSession): number {
		return (
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages as AgentMessage[], { excludeEncryptedReasoning: true })
		);
	}

	it("scales the frame budget with the trigger and ignores the window above it", async () => {
		const frame = framePrice(opus(1_000_000));
		const low = await requestedFrames(opus(1_000_000), { "compaction.thresholdTokens": 80_000 });
		const high = await requestedFrames(opus(1_000_000), { "compaction.thresholdTokens": 160_000 });
		const smallWindow = await requestedFrames(opus(300_000), { "compaction.thresholdTokens": 160_000 });

		expect(smallWindow).toBe(high);
		expect(low).toBeGreaterThan(0);
		expect(high).toBeGreaterThan(2 * low - 2);
		expect(low * frame).toBeLessThanOrEqual(SHARE * 80_000);
		expect(high * frame).toBeLessThanOrEqual(SHARE * 160_000);
	});

	it("keeps a trigger far below the window from getting a window-sized archive", async () => {
		const model = opus(1_000_000);
		const frames = await requestedFrames(model, { "compaction.thresholdTokens": 60_000 });
		expect(frames).toBeGreaterThan(0);
		expect(frames * framePrice(model)).toBeLessThanOrEqual(SHARE * 60_000);
		// The window alone would allow the full payload cap.
		expect(frames).toBeLessThan(snapcompact.maxFramesForDataBudget(snapcompact.resolveShape(model)));
	});

	it("sizes from the active model's compaction.modelThresholds entry", async () => {
		const model = opus(1_000_000);
		const perModel = await requestedFrames(model, {
			"compaction.modelThresholds": { "anthropic/claude-opus-5-5": "f80000" },
		});
		const global = await requestedFrames(model, { "compaction.thresholdTokens": 80_000 });
		expect(perModel).toBe(global);
		expect(perModel * framePrice(model)).toBeLessThanOrEqual(SHARE * 80_000);
	});

	it("never plans the compacted context past 60% of the trigger when kept turns fill much of it", async () => {
		const model = opus(1_000_000);
		const thresholdTokens = 100_000;
		const { session } = createSession(model, {
			"compaction.thresholdTokens": thresholdTokens,
			"compaction.keepRecentTokens": 30_000,
		});
		const spy = vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => ({
			summary: "stub",
			shortSummary: "stub",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: { snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 } },
		}));
		await session.compact(undefined, { mode: "snapcompact" });
		const frames = spy.mock.calls[0]?.[1]?.maxFrames ?? 0;
		// The stub committed an empty archive: the rest is the system prompt, tools and kept turns.
		const summary = session.messages.find(message => message.role === "compactionSummary");
		if (!summary) throw new Error("Expected a compaction summary message");
		const archiveText =
			Math.ceil((2 * snapcompact.geometry(snapcompact.resolveShape(model)).capacity * 1.15) / 4) + 2000;
		const fixedTokens = storedContextTokens(session) - session.agent.tokenizer.countMessage(summary) + archiveText;

		// Half the room alone would allow another frame; the 60% target is what binds.
		expect(SHARE * (thresholdTokens - fixedTokens)).toBeGreaterThanOrEqual((frames + 1) * framePrice(model));
		expect(frames).toBeGreaterThan(0);
		expect(frames * framePrice(model)).toBeLessThanOrEqual(TARGET * thresholdTokens - fixedTokens);
	});

	it("sizes the trigger room without the kept turns' opaque reasoning replay bytes", async () => {
		const model = opus(1_000_000);
		const settings = { "compaction.thresholdTokens": 100_000 };
		const frames = async (signature: string): Promise<number> => {
			const { session } = createSession(model, settings);
			// A kept assistant turn whose replay signature the trigger's stored count skips.
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "short", thinkingSignature: signature },
					{ type: "text", text: "kept answer" },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			const spy = vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => ({
				summary: "stub",
				shortSummary: "stub",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: [], modifiedFiles: [] },
				preserveData: { snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 } },
			}));
			await session.compact(undefined, { mode: "snapcompact" });
			const maxFrames = spy.mock.calls[0]?.[1]?.maxFrames ?? 0;
			spy.mockRestore();
			return maxFrames;
		};
		const plain = await frames("sig");
		expect(plain).toBeGreaterThan(1);
		// ~40k tokens of signature text, which the trigger never counts.
		expect(await frames("x".repeat(160_000))).toBe(plain);
	});

	it("follows the active model's trigger after a model switch", async () => {
		const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!haiku) throw new Error("Expected bundled claude-haiku-4-5");
		// 20% of each model's window: 200k on Opus 1M, 40k on Haiku 200k.
		const { session } = createSession(opus(1_000_000), { "compaction.thresholdPercent": 20 });
		const requested = stopAtRender();
		expect(await rejectionOf(session.compact(undefined, { mode: "snapcompact" }))).toHaveProperty(
			"message",
			"stop after sizing",
		);
		session.agent.setModel(haiku);
		expect(await rejectionOf(session.compact(undefined, { mode: "snapcompact" }))).toHaveProperty(
			"message",
			"stop after sizing",
		);

		const [onOpus, onHaiku] = requested;
		expect(onHaiku).toBeGreaterThan(0);
		expect(onHaiku * framePrice(haiku)).toBeLessThanOrEqual(SHARE * 40_000);
		expect(onOpus).toBeGreaterThan(onHaiku);
	});

	it("still commits a manual compaction that leaves no room under the trigger", async () => {
		// Manual `/compact` keeps only its reduction and window-fit checks: the
		// user asked for it, so a one-frame archive above a tiny trigger lands.
		const thresholdTokens = 12_000;
		const { session } = createSession(opus(1_000_000), { "compaction.thresholdTokens": thresholdTokens });
		const spy = vi.spyOn(snapcompact, "compact");
		await session.compact(undefined, { mode: "snapcompact" });
		expect(spy.mock.calls[0]?.[1]?.maxFrames).toBe(1);
		expect(latestArchive(session)?.frames.length).toBe(1);
		expect(storedContextTokens(session)).toBeGreaterThan(thresholdTokens);
	});

	it("hands an automatic compaction to the next method when even one frame leaves no room under the trigger", async () => {
		const model = opus(1_000_000);
		// The kept turns, text edges and one frame already exceed 80% of a 12k trigger.
		const { session, notices } = createSession(model, {
			"compaction.thresholdTokens": 12_000,
			"compaction.methodOrder": ["snapcompact", "soft"],
		});
		const compactSpy = vi.spyOn(snapcompact, "compact");
		const summarize = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "summarized",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const { promise: done, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			// The rejected snapcompact pass ends first; wait for the method that commits.
			if (event.type === "auto_compaction_end" && event.result !== undefined) resolve();
		});
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop" as const,
			usage: {
				input: 60_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await done;
		await session.waitForIdle();

		// The single-frame render really happened, was rejected, and the next method committed instead.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]?.maxFrames).toBe(1);
		expect(notices.some(notice => notice.includes("could not leave room under the compaction trigger"))).toBe(true);
		expect(summarize).toHaveBeenCalledTimes(1);
		const compactions = session.sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({ summary: "summarized" });
		expect(snapcompact.getPreservedArchive(compactions[0]?.preserveData)).toBeUndefined();
	});

	it.each([
		{ label: "snapcompact-only", methodOrder: ["snapcompact"] },
		// Shake finds nothing to drop in a text-only history, so it cannot replace the archive.
		{ label: "snapcompact-then-shake", methodOrder: ["snapcompact", "shake"] },
	])(
		"keeps a $label threshold archive that fits the window when even one frame leaves no room under the trigger",
		async ({ methodOrder }) => {
			const model = opus(1_000_000);
			const { session, notices } = createSession(model, {
				"compaction.thresholdTokens": 12_000,
				"compaction.methodOrder": methodOrder,
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const uncompacted = storedContextTokens(session);
			const { promise: done, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") resolve();
			});
			const assistant = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "Done." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop" as const,
				usage: {
					input: 60_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 60_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await done;
			await session.waitForIdle();

			expect(
				notices.some(notice =>
					notice.includes("keeping its archive because no later summarizing compaction method is usable"),
				),
			).toBe(true);
			expect(latestArchive(session)?.frames.length).toBe(1);
			const after = storedContextTokens(session);
			expect(after).toBeLessThan(uncompacted / 2);
			expect(after).toBeLessThanOrEqual(1_000_000 - 16_384);
		},
	);

	it.each([
		{
			reason: "overflow",
			turns: 400,
			failure: {
				stopReason: "error" as const,
				errorMessage: "prompt is too long: 600000 tokens > 200000 maximum",
				input: 600_000,
			},
		},
		// Reported input below the 200k window and above the 12k trigger.
		{ reason: "incomplete", turns: 100, failure: { stopReason: "length" as const, input: 150_000 } },
	])(
		"keeps $reason recovery on the window fit: an archive above the trigger is committed and retried",
		async ({ reason, turns, failure }) => {
			const model = opus(200_000);
			const thresholdTokens = 12_000;
			const { session, notices } = createSession(
				model,
				{
					"compaction.thresholdTokens": thresholdTokens,
					"compaction.methodOrder": ["snapcompact"],
					"contextPromotion.enabled": false,
				},
				turns,
			);
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			const retry = vi.spyOn(session.agent, "continue").mockResolvedValue();
			const reasons: string[] = [];
			const { promise: done, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start") reasons.push(event.reason);
				if (event.type === "auto_compaction_end") resolve();
			});
			const { input, ...stop } = failure;
			const assistant = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				...stop,
				usage: {
					input,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await done;
			await session.waitForIdle();

			expect(reasons).toEqual([reason]);
			expect(latestArchive(session)?.frames.length).toBeGreaterThan(0);
			// Above the recovery band, inside the window: the retry still runs.
			expect(storedContextTokens(session)).toBeGreaterThan(0.8 * thresholdTokens);
			expect(notices.some(notice => notice.includes("could not leave room under the compaction trigger"))).toBe(
				false,
			);
			expect(retry).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps idle compaction on the window fit: an archive above the trigger is committed", async () => {
		const thresholdTokens = 12_000;
		const { session, notices } = createSession(
			opus(200_000),
			{
				"compaction.thresholdTokens": thresholdTokens,
				"compaction.methodOrder": ["snapcompact"],
				"contextPromotion.enabled": false,
			},
			400,
		);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.runIdleCompaction();
		await session.waitForIdle();

		expect(latestArchive(session)?.frames.length).toBeGreaterThan(0);
		expect(storedContextTokens(session)).toBeGreaterThan(0.8 * thresholdTokens);
		expect(notices.some(notice => notice.includes("could not leave room under the compaction trigger"))).toBe(false);
	});

	it("counts a pending prompt toward the 60% target when it triggers pre-prompt compaction", async () => {
		const model = opus(1_000_000);
		const thresholdTokens = 100_000;
		const { session } = createSession(
			model,
			{ "compaction.thresholdTokens": thresholdTokens, "compaction.asyncEnabled": false },
			500,
		);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const requests = recordRequests(session, model);
		// ~22k tokens of prompt, not yet in the session when the pre-prompt pass sizes the archive.
		const { prompt, promptTokens } = largePrompt(session, 2_200);
		await session.prompt(prompt);

		expect(latestArchive(session)?.frames.length).toBeGreaterThan(0);
		expect(requests[0]?.compactions).toBe(1);
		// The stored context at request time is the compacted history; the prompt rides on top.
		expect((requests[0]?.tokens ?? Number.POSITIVE_INFINITY) + promptTokens).toBeLessThanOrEqual(
			TARGET * thresholdTokens,
		);
	});

	it("hands a pre-prompt archive the pending prompt pushes over the recovery band to the next method", async () => {
		const model = opus(1_000_000);
		const thresholdTokens = 100_000;
		const { session, notices } = createSession(
			model,
			{
				"compaction.thresholdTokens": thresholdTokens,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["snapcompact", "soft"],
			},
			500,
		);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const summarize = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "summarized",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const requests = recordRequests(session, model);
		// ~70k tokens of prompt: even a one-frame archive plus the prompt is above 80% of the trigger.
		const { prompt, promptTokens } = largePrompt(session, 7_000);
		await session.prompt(prompt);

		expect(promptTokens).toBeGreaterThan(0.6 * thresholdTokens);
		expect(notices.some(notice => notice.includes("could not leave room under the compaction trigger; trying"))).toBe(
			true,
		);
		expect(summarize).toHaveBeenCalledTimes(1);
		// The request went out on the next method's summary, not on the snapcompact archive.
		expect(requests[0]?.compactions).toBe(1);
		const compaction = session.sessionManager.getBranch().find(entry => entry.type === "compaction");
		expect(compaction).toMatchObject({ summary: "summarized" });
		expect(
			snapcompact.getPreservedArchive(compaction?.type === "compaction" ? compaction.preserveData : undefined),
		).toBeUndefined();
	});

	it("keeps a snapcompact-only pre-prompt archive that fits the window when the pending prompt pushes it over the band", async () => {
		const model = opus(1_000_000);
		const thresholdTokens = 100_000;
		const { session, notices } = createSession(
			model,
			{
				"compaction.thresholdTokens": thresholdTokens,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["snapcompact"],
			},
			500,
		);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const uncompacted = storedContextTokens(session);
		const requests = recordRequests(session, model);
		const { prompt, promptTokens } = largePrompt(session, 7_000);
		await session.prompt(prompt);

		expect(
			notices.some(notice =>
				notice.includes("keeping its archive because no later summarizing compaction method is usable"),
			),
		).toBe(true);
		// The first request carries the archive, well below the uncompacted history, and fits the window.
		expect(requests[0]?.compactions).toBe(1);
		expect(latestArchive(session)?.frames.length).toBeGreaterThan(0);
		const requestTokens = (requests[0]?.tokens ?? Number.POSITIVE_INFINITY) + promptTokens;
		expect(requestTokens).toBeLessThan(uncompacted / 2);
		expect(requestTokens).toBeLessThanOrEqual(1_000_000 - 16_384);
	});

	it("re-renders toward 60% of the trigger, dropping the oldest frames when a render overshoots", async () => {
		const thresholdTokens = 100_000;
		const { session } = createSession(opus(1_000_000), { "compaction.thresholdTokens": thresholdTokens }, 500);
		const compact = snapcompact.compact;
		const calls: number[] = [];
		vi.spyOn(snapcompact, "compact").mockImplementation((preparation, options) => {
			calls.push(options?.maxFrames ?? -1);
			// First render ignores the budget, as if the text estimate had run short.
			return compact(preparation, calls.length === 1 ? { ...options, maxFrames: 30 } : options);
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(calls.length).toBeGreaterThanOrEqual(2);
		const last = calls.at(-1) ?? 0;
		expect(last).toBeGreaterThan(0);
		expect(last).toBeLessThan(30);
		expect(latestArchive(session)?.frames.length).toBe(last);
		const stored = storedContextTokens(session);
		expect(stored).toBeLessThanOrEqual(TARGET * thresholdTokens);
		// The archive still fills most of the allowed room rather than collapsing.
		expect(stored).toBeGreaterThan(0.4 * thresholdTokens);
	});

	it("lands a real archive under the target, priced as the trigger counts it", async () => {
		const model = opus(1_000_000);
		const thresholdTokens = 100_000;
		const { session } = createSession(model, { "compaction.thresholdTokens": thresholdTokens }, 500);
		const spy = vi.spyOn(snapcompact, "compact");
		await session.compact(undefined, { mode: "snapcompact" });
		expect(spy).toHaveBeenCalledTimes(1);
		const stored = storedContextTokens(session);
		expect(stored).toBeLessThanOrEqual(TARGET * thresholdTokens);
		expect(stored).toBeGreaterThan(0.4 * thresholdTokens);
		const frames = latestArchive(session)?.frames.length ?? 0;
		expect(frames).toBeGreaterThan(3);
		expect(committedFrameTokens(session)).toBeLessThanOrEqual(frames * framePrice(model));
	});
});
