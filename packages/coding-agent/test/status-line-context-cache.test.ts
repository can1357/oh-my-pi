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
import {
	disposeStatusLines,
	flushStatus,
	lineText,
	segmentText,
	statusFacts,
	statusLine,
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
				{ leftSegments: ["cache"], rightSegments: [] },
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
