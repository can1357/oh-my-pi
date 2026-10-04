/**
 * Snapcompact archive size follows the compaction trigger, not the window.
 *
 * The archive rides in every later request, so its frames eat the room under
 * the trigger. Sized from the window, a 1M-token Opus session with a 600k
 * trigger got the same 17 frames as a 200k one (and a low per-model trigger
 * could get an archive that leaves no room at all). These tests defend:
 * - frames scale with the resolved trigger, follow the active model's trigger
 *   across a model switch, and ignore the window above it;
 * - frames are priced by the trigger's own tokenizer, so the budget and the
 *   post-commit count agree;
 * - `snapcompact.archiveShare` sets the share of the room and is range-checked;
 * - 60% of the trigger is a sizing target: a render that overshoots it is
 *   re-rendered with the oldest frames dropped; automatic passes above the 80%
 *   recovery band are handed to the next method; manual `/compact` keeps its
 *   reduction and window-fit checks only;
 * - a trailing archive written for one model is rebuilt for a smaller one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgSnapcompactArchiveShare } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { shapeFrameTokens } from "@oh-my-pi/pi-coding-agent/session/snapcompact-archive-budget";
import { computeSessionContextBreakdown } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import { buildContextReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/context-report";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as snapcompact from "@oh-my-pi/snapcompact";

const TARGET = 0.6;
const RECOVERY_BAND = 0.8;

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

	/** What the session's tokenizer (the trigger's counter) charges for one frame of `model`'s shape. */
	async function framePrice(model: Model): Promise<number> {
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } });
		return shapeFrameTokens(agent.tokenizer, snapcompact.resolveShape(model));
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

	/** What the compaction trigger counts for the session's current context (stored estimate). */
	function storedContextTokens(session: AgentSession): number {
		return (
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages as AgentMessage[], { excludeEncryptedReasoning: true })
		);
	}

	it("scales the frame budget with the trigger and ignores the window above it", async () => {
		const frame = await framePrice(opus(1_000_000));
		const low = await requestedFrames(opus(1_000_000), { "compaction.thresholdTokens": 200_000 });
		const high = await requestedFrames(opus(1_000_000), { "compaction.thresholdTokens": 400_000 });
		const smallWindow = await requestedFrames(opus(500_000), { "compaction.thresholdTokens": 400_000 });

		expect(smallWindow).toBe(high);
		// Doubling the trigger roughly doubles the room (minus the fixed kept/system cost).
		expect(high).toBeGreaterThan(2 * low - 2);
		expect(high).toBeLessThan(snapcompact.MAX_FRAMES_DEFAULT);
		// Default share 0.5: the archive takes at most half the trigger.
		expect(low * frame).toBeLessThanOrEqual(0.5 * 200_000);
		expect(high * frame).toBeLessThanOrEqual(0.5 * 400_000);
		expect(low).toBeGreaterThan(10);
	});

	it("keeps a trigger far below the window from getting a window-sized archive", async () => {
		const frame = await framePrice(opus(1_000_000));
		const frames = await requestedFrames(opus(1_000_000), { "compaction.thresholdTokens": 60_000 });
		expect(frames).toBeGreaterThan(0);
		expect(frames * frame).toBeLessThanOrEqual(0.5 * 60_000);
		// The window alone (1M − reserve) would allow the 80-frame cap.
		expect(frames).toBeLessThan(10);
	});

	it("follows the active model's trigger after a model switch", async () => {
		const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!haiku) throw new Error("Expected bundled claude-haiku-4-5");
		// 40% of each model's window: 400k on Opus 1M, 80k on Haiku 200k.
		const { session } = createSession(opus(1_000_000), { "compaction.thresholdPercent": 40 });
		const requested = stopAtRender();
		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow("stop after sizing");
		session.agent.setModel(haiku);
		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow("stop after sizing");

		const [onOpus, onHaiku] = requested;
		expect(onOpus * (await framePrice(opus(1_000_000)))).toBeLessThanOrEqual(0.5 * 400_000);
		expect(onHaiku * (await framePrice(haiku))).toBeLessThanOrEqual(0.5 * 80_000);
		expect(onHaiku).toBeGreaterThan(0);
		expect(onOpus).toBeGreaterThan(2 * onHaiku);
	});

	it("gives the archive the configured share of the room", async () => {
		const settings = { "compaction.thresholdTokens": 400_000 };
		const share30 = await requestedFrames(opus(1_000_000), { ...settings, "snapcompact.archiveShare": 0.3 });
		const share50 = await requestedFrames(opus(1_000_000), settings);
		expect(share30).toBeLessThan(share50);
		expect(Math.abs(share30 / share50 - 0.6)).toBeLessThan(0.05);
	});

	it("rejects archive shares outside 0.1–0.9", () => {
		const settings = Settings.isolated();
		expect(cfgSnapcompactArchiveShare.get(settings)).toBe(0.5);
		for (const bad of [0, 0.05, 0.95, 1, Number.NaN]) {
			expect(() => cfgSnapcompactArchiveShare.set(settings, bad)).toThrow("snapcompact.archiveShare");
		}
		for (const ok of [0.1, 0.9]) {
			cfgSnapcompactArchiveShare.set(settings, ok);
			expect(cfgSnapcompactArchiveShare.get(settings)).toBe(ok);
		}
	});

	it("warns once per model and trigger when the trigger leaves no room for an archive frame", async () => {
		const { session, notices } = createSession(opus(1_000_000), { "compaction.thresholdTokens": 12_000 });
		const requested = stopAtRender();
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow("stop after sizing");
		}
		expect(requested).toEqual([1, 1]);
		const noRoom = notices.filter(notice => notice.includes("leaves no room for an image archive"));
		expect(noRoom).toHaveLength(1);
		expect(noRoom[0]).toContain("12,000");
	});

	it("still commits a manual compaction that leaves no room under the trigger", async () => {
		// Manual `/compact` keeps only its reduction and window-fit checks: the
		// user asked for it, so a one-frame archive above a tiny trigger lands.
		const thresholdTokens = 12_000;
		const { session, notices } = createSession(opus(1_000_000), { "compaction.thresholdTokens": thresholdTokens });
		await session.compact(undefined, { mode: "snapcompact" });
		const archive = snapcompact.getPreservedArchive(
			session.sessionManager.getBranch().findLast(entry => entry.type === "compaction")?.preserveData,
		);
		expect(archive?.frames.length).toBe(1);
		expect(storedContextTokens(session)).toBeGreaterThan(thresholdTokens);
		expect(notices.some(notice => notice.includes("leaves no room for an image archive"))).toBe(true);
	});

	it("hands an automatic compaction to the next method when even one frame leaves no room under the trigger", async () => {
		const model = opus(1_000_000);
		// The kept turns, text edges and one frame already exceed 80% of a 12k trigger.
		const { session, notices } = createSession(model, {
			"compaction.thresholdTokens": 12_000,
			"compaction.methodOrder": ["snapcompact"],
		});
		const compactSpy = vi.spyOn(snapcompact, "compact");
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

		// The single-frame render really happened, and was rejected rather than committed.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]?.maxFrames).toBe(1);
		expect(notices.some(notice => notice.includes("could not leave room under the compaction trigger"))).toBe(true);
		expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("re-renders toward 60% of the trigger, dropping the oldest frames when a render overshoots", async () => {
		const thresholdTokens = 200_000;
		// 0.9 asks for more than the target allows; ~1.3M chars of history need far more frames than fit.
		const { session } = createSession(
			opus(1_000_000),
			{ "compaction.thresholdTokens": thresholdTokens, "snapcompact.archiveShare": 0.9 },
			500,
		);
		const compact = snapcompact.compact;
		const calls: number[] = [];
		vi.spyOn(snapcompact, "compact").mockImplementation((preparation, options) => {
			calls.push(options?.maxFrames ?? -1);
			// First render ignores the budget, as if the text estimate had run short.
			return compact(preparation, calls.length === 1 ? { ...options, maxFrames: 60 } : options);
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(calls).toHaveLength(2);
		expect(calls[1]).toBeGreaterThan(0);
		expect(calls[1]).toBeLessThan(60);
		const archive = snapcompact.getPreservedArchive(
			session.sessionManager.getBranch().findLast(entry => entry.type === "compaction")?.preserveData,
		);
		expect(archive?.frames.length).toBe(calls[1]);
		const stored = storedContextTokens(session);
		expect(stored).toBeLessThanOrEqual(TARGET * thresholdTokens);
		// The archive still fills most of the allowed room rather than collapsing.
		expect(stored).toBeGreaterThan(0.45 * thresholdTokens);
	});

	it("lands a real archive under the target without a re-render and reports it in /context", async () => {
		const thresholdTokens = 200_000;
		const { session } = createSession(
			opus(1_000_000),
			{ "compaction.thresholdTokens": thresholdTokens, "snapcompact.archiveShare": 0.9 },
			500,
		);
		const spy = vi.spyOn(snapcompact, "compact");
		await session.compact(undefined, { mode: "snapcompact" });
		expect(spy).toHaveBeenCalledTimes(1);
		const stored = storedContextTokens(session);
		expect(stored).toBeLessThanOrEqual(TARGET * thresholdTokens);
		expect(stored).toBeGreaterThan(0.45 * thresholdTokens);

		const archive = snapcompact.getPreservedArchive(
			session.sessionManager.getBranch().findLast(entry => entry.type === "compaction")?.preserveData,
		);
		const frames = archive?.frames.length ?? 0;
		expect(frames).toBeGreaterThan(10);
		const breakdown = computeSessionContextBreakdown(session);
		// /context prices the frames at the same per-frame charge the budget planned with.
		expect(breakdown.snapcompactArchive).toEqual({ frames, tokens: frames * (await framePrice(opus(1_000_000))) });
		expect(breakdown.thresholdTokens).toBe(thresholdTokens);
		const report = buildContextReportText({ session } as unknown as SlashCommandRuntime);
		expect(report).toContain(`Snapcompact archive: ${frames} frames`);
		expect(report).toContain("room before the next compaction");
	});
	it("rebuilds a 56-frame Opus archive for a 272k Codex model and recovers below the recovery band", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6-astra");
		if (!codex) throw new Error("Expected bundled gpt-6-astra");
		// A real Opus archive: 600 turns (~3.5M chars) rendered into 56 1932px frames.
		// 85% of each window: 850k on Opus 1M, 231,200 on Codex 272k.
		const { session, notices } = createSession(
			opus(1_000_000),
			{ "compaction.thresholdPercent": 85, "snapcompact.archiveShare": 0.9 },
			600,
		);
		const compact = snapcompact.compact;
		const spy = vi
			.spyOn(snapcompact, "compact")
			.mockImplementationOnce((preparation, options) => compact(preparation, { ...options, maxFrames: 56 }));
		await session.compact(undefined, { mode: "snapcompact" });
		spy.mockRestore();
		const opusEntry = session.sessionManager.getBranch().at(-1);
		expect(opusEntry?.type).toBe("compaction");
		expect(
			snapcompact.getPreservedArchive(opusEntry?.type === "compaction" ? opusEntry.preserveData : undefined)?.frames
				.length,
		).toBe(56);

		// Switch to Codex (trigger 85% of 272k = 231,200): the Opus
		// archive alone is now over the trigger, and nothing after it can be
		// summarized, so maintenance must rebuild the archive for the new model.
		session.agent.setModel(codex);
		const { thresholdTokens } = computeSessionContextBreakdown(session);
		if (thresholdTokens === undefined) throw new Error("Expected a compaction threshold");
		const before = storedContextTokens(session);
		expect(before).toBeGreaterThan(thresholdTokens);

		const { promise: done, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: codex.api,
			provider: codex.provider,
			model: codex.id,
			stopReason: "stop" as const,
			usage: {
				input: before,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: before + 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await done;
		await session.waitForIdle();

		const compactions = session.sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(2);
		const after = storedContextTokens(session);
		expect(after).toBeLessThanOrEqual(Math.floor(RECOVERY_BAND * thresholdTokens));
		expect(notices.some(notice => notice.includes("rebuilt the trailing snapcompact archive"))).toBe(true);
		expect(notices.some(notice => notice.includes("freed too little context"))).toBe(false);
	});
});
