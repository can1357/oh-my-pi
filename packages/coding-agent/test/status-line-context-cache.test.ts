/**
 * The status line's context usage: it surfaces `session.getContextUsage()`,
 * which anchors on the last assistant's real provider prompt-token count — so
 * the bar matches the provider and the `/context` panel instead of an
 * independent estimate that drifted past 100%.
 *
 * Painting is not an input: the facts re-read usage when the session reports a
 * change (an event, or `refresh()` for changes that emit none), and repeated
 * paints in between reuse the snapshot — the per-paint recompute is what
 * previously froze large sessions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/ui/status/facts";
import {
	disposeStatusLines,
	flushStatus,
	lineText,
	segmentText,
	statusFacts,
	statusLine,
	statusRows,
	statusSession,
} from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
});

function makeSession(opts: { contextWindow?: number; usage?: ContextUsage | undefined }) {
	const contextWindow = opts.contextWindow ?? 200_000;
	const model = {
		id: "test-model",
		provider: "test",
		contextWindow,
		input: ["text"],
	};
	let usage: ContextUsage | undefined = "usage" in opts ? opts.usage : { tokens: 1234, contextWindow, percent: 0.6 };
	let calls = 0;
	const session = statusSession({
		model,
		state: { messages: [], model },
		getContextUsage: () => {
			calls++;
			return usage;
		},
	});
	return {
		session,
		usageCalls: () => calls,
		setUsage: (next: ContextUsage | undefined) => {
			usage = next;
		},
	};
}

describe("status line context usage", () => {
	it("surfaces the provider-anchored tokens and context window from getContextUsage", () => {
		const { session } = makeSession({
			usage: { tokens: 5000, contextWindow: 272_000, percent: 1.8 },
		});
		const line = statusLine(session);
		expect(line.contextBreakdown()).toEqual({
			usedTokens: 5000,
			contextWindow: 272_000,
		});
		expect(line.facts().context).toMatchObject({
			tokens: 5000,
			window: 272_000,
		});
	});

	it("re-reads usage when the session reports a change, not on every paint", () => {
		const fake = makeSession({
			usage: { tokens: 100, contextWindow: 200_000, percent: 0.05 },
		});
		const line = statusLine(fake.session, {
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
		});
		lineText(line);
		lineText(line);
		expect(fake.usageCalls()).toBe(1);

		fake.setUsage({ tokens: 250, contextWindow: 200_000, percent: 0.125 });
		line.refresh();

		expect(line.facts().context.tokens).toBe(250);
		expect(fake.usageCalls()).toBe(2);
	});

	it("refreshes token-dependent facts on deltas, and the full snapshot on the next session event", async () => {
		vi.useFakeTimers();
		try {
			let emit!: (event: { type: string }) => void;
			const readName = vi.fn(() => "live session");
			let tokens = 100;
			let window = 20_000;
			const boundaries = vi.spyOn(statusLineHost, "computeCompactionBoundaries");
			const line = statusLine(
				statusSession({
					subscribe: (listener: typeof emit) => {
						emit = listener;
						return () => {};
					},
					sessionManager: { getSessionName: readName },
					getContextUsage: () => ({ tokens, contextWindow: window, percent: 0 }),
					getPromptCacheStatus: (_now: number, nextTokens: number) => ({ nextTokens }),
				}),
				{ preset: "custom", leftSegments: ["cache"], rightSegments: [] },
			);
			line.facts();
			readName.mockClear();
			tokens = 200;
			emit({ type: "message_update" });
			emit({ type: "message_update" });
			vi.advanceTimersByTime(100);
			await flushStatus();
			expect(line.facts()).toMatchObject({ context: { tokens }, promptCache: { nextTokens: tokens } });
			expect(readName).not.toHaveBeenCalled();
			expect(boundaries).toHaveBeenCalledTimes(1);

			window = 40_000;
			emit({ type: "message_update" });
			vi.advanceTimersByTime(100);
			await flushStatus();
			expect(line.facts().context.window).toBe(window);
			expect(boundaries).toHaveBeenCalledTimes(2);

			emit({ type: "message_end" });
			await flushStatus();
			expect(line.facts().sessionName).toBe("live session");
			expect(readName).toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("matches a full repaint throughout a stream without publishing unchanged facts", async () => {
		vi.useFakeTimers();
		try {
			let emit!: (event: { type: string }) => void;
			let tokens = 100;
			let rate: number | null = null;
			let running = false;
			let accountLabel: string | undefined;
			const getUsage = vi.fn(() => ({ tokens, contextWindow: 1_000, percent: tokens / 10 }));
			const session = statusSession({
				subscribe: (listener: typeof emit) => {
					emit = listener;
					return () => {};
				},
				getContextUsage: getUsage,
				tokenRate: { rate: () => rate },
				getAsyncJobSnapshot: () => ({ running: running ? [{ type: "bash" }] : [] }),
				getAnthropicSlowModeLabel: () => accountLabel,
			});
			const settings: StatusLineSettings = { preset: "custom", leftSegments: ["context_pct"], rightSegments: [] };
			const reference = statusLine(session, settings);
			const live = statusLine(session, settings);
			const step = async (type: string) => {
				emit({ type });
				vi.advanceTimersByTime(100);
				await flushStatus();
				reference.refresh();
				expect(statusRows(settings, live.facts())).toEqual(statusRows(settings, reference.facts()));
			};

			const initial = live.facts();
			expect(live.composerRate()).toBeUndefined();
			rate = 17.34;
			await step("message_update");
			expect(live.composerRate()).toBe(17.3);
			expect(live.facts()).toBe(initial);

			tokens = 250;
			await step("message_update");
			expect(live.facts().context.tokens).toBe(250);
			const changed = live.facts();
			getUsage.mockClear();
			await step("tool_stream_update");
			expect(live.facts()).toBe(changed);
			expect(getUsage).toHaveBeenCalledTimes(1); // reference only

			running = true;
			accountLabel = "low priority";
			await step("tool_execution_update");
			expect(live.facts()).toMatchObject({ jobs: 1, slowModeLabel: accountLabel });
			running = false;
			accountLabel = undefined;
			await step("tool_execution_update");
			expect(live.facts().slowModeLabel).toBeUndefined();
			tokens = 420;
			await step("message_end");
			expect(live.facts()).toMatchObject({ jobs: 0, context: { tokens } });
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to the model window with 0 tokens when usage is unavailable", () => {
		const { session } = makeSession({
			usage: undefined,
			contextWindow: 128_000,
		});
		expect(statusLine(session).contextBreakdown()).toEqual({
			usedTokens: 0,
			contextWindow: 128_000,
		});
	});

	it("renders the anchored percent against the (sub-)budget window in the context segment", () => {
		// 5000 / 272000 → 1.8%, window formatted as 272K (matches the footer gauge).
		const facts = statusFacts({
			context: { tokens: 5000, window: 272_000, percent: 1.8 },
		});
		expect(segmentText("context_pct", facts)).toContain("1.8%/272K");
	});

	it("renders the percent of a speculative post-compaction estimate", () => {
		const facts = statusFacts({
			context: { tokens: 1234, window: 272_000, percent: 0.45 },
		});
		expect(segmentText("context_pct", facts)).toContain("0.5%/272K");
	});

	it("renders token usage with an unknown marker when the model window is unavailable", () => {
		const facts = statusFacts({
			context: { tokens: 5000, window: 0, percent: null },
		});
		const text = segmentText("context_pct", facts);
		expect(text).toContain("5K/?");
		expect(text).not.toContain("0.0%/0");
	});
});
