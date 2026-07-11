/**
 * Contract for `StatusLineComponent.getCachedContextBreakdown`.
 *
 * The status-line context% segment no longer keeps its own cl100k estimate of
 * the whole conversation. It surfaces `session.getContextUsage()`, which
 * anchors on the last assistant's real provider prompt-token count — so the bar
 * matches the provider and the `/context` panel instead of an independent
 * estimate that drifted past 100%.
 *
 * `getTopBorder()` runs on every agent event (event-controller.ts), so the
 * breakdown is memoized: it re-queries `getContextUsage()` only when an input
 * it depends on changes (a new/grown message, a replaced message array, or the
 * model's context window). A stable conversation must not re-query on every
 * redraw — that per-event recompute is what previously froze large sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ContextUsage } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import { StatusLineComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

interface Fake {
	session: AgentSession;
	/** Number of times `getContextUsage()` was queried. */
	usageCalls: () => number;
	/** Swap the value the next `getContextUsage()` query returns. */
	setUsage: (usage: ContextUsage | undefined) => void;
	/** Bump the in-flight pending revision the next `getCachedContextBreakdown()` reads. */
	setRevision: (n: number) => void;
}

function makeSession(opts: { messages: unknown[]; contextWindow?: number; usage?: ContextUsage | undefined }): Fake {
	const contextWindow = opts.contextWindow ?? 200_000;
	let usage: ContextUsage | undefined = "usage" in opts ? opts.usage : { tokens: 1234, contextWindow, percent: 0.6 };
	let calls = 0;
	let revision = 0;
	const session = {
		messages: opts.messages,
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "test-model", contextWindow },
		state: { messages: opts.messages, model: { contextWindow } },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => {
			calls++;
			return usage;
		},
		get contextUsageRevision() {
			return revision;
		},
	} as unknown as AgentSession;
	return {
		session,
		usageCalls: () => calls,
		setUsage: next => {
			usage = next;
		},
		setRevision: (n: number) => {
			revision = n;
		},
	};
}

function userMessage(text: string): unknown {
	return { role: "user", content: text };
}
function assistantMessage(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("StatusLineComponent context breakdown", () => {
	it("surfaces the provider-anchored tokens and context window from getContextUsage", () => {
		const { session } = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 5000, contextWindow: 272_000, percent: 1.8 },
		});
		const breakdown = new StatusLineComponent(session).getCachedContextBreakdown();
		expect(breakdown.usedTokens).toBe(5000);
		expect(breakdown.contextWindow).toBe(272_000);
	});

	it("memoizes: repeated redraws with no change do not re-query usage", () => {
		const { session, usageCalls } = makeSession({ messages: [userMessage("hi")] });
		const comp = new StatusLineComponent(session);

		comp.getCachedContextBreakdown();
		comp.getCachedContextBreakdown();
		comp.getCachedContextBreakdown();

		expect(usageCalls()).toBe(1);
	});

	it("re-queries and surfaces the new total when a message is appended", () => {
		const fake = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 100, contextWindow: 200_000, percent: 0.05 },
		});
		const comp = new StatusLineComponent(fake.session);
		expect(comp.getCachedContextBreakdown().usedTokens).toBe(100);

		(fake.session.messages as unknown[]).push(assistantMessage("a reply that bumped the real prompt size"));
		fake.setUsage({ tokens: 250, contextWindow: 200_000, percent: 0.125 });

		expect(comp.getCachedContextBreakdown().usedTokens).toBe(250);
		expect(fake.usageCalls()).toBe(2);
	});

	it("re-queries when the streaming tail grows in place", () => {
		const tail = assistantMessage("partial") as { content: { type: string; text: string }[] };
		const { session, usageCalls } = makeSession({ messages: [userMessage("hi"), tail] });
		const comp = new StatusLineComponent(session);

		comp.getCachedContextBreakdown();
		tail.content[0]!.text = "partial response that kept streaming".repeat(8);
		comp.getCachedContextBreakdown();

		expect(usageCalls()).toBe(2);
	});

	it("re-queries when the message array is replaced (branch switch / rebuild)", () => {
		const { session, usageCalls } = makeSession({
			messages: [userMessage("a"), userMessage("b")],
		});
		const comp = new StatusLineComponent(session);
		comp.getCachedContextBreakdown();

		(session as { messages: unknown[] }).messages = [userMessage("c"), userMessage("d")];
		comp.getCachedContextBreakdown();

		expect(usageCalls()).toBe(2);
	});

	it("re-queries when the model context window changes", () => {
		const { session, usageCalls } = makeSession({ messages: [userMessage("hi")], contextWindow: 200_000 });
		const comp = new StatusLineComponent(session);
		comp.getCachedContextBreakdown();

		(session.model as { contextWindow: number }).contextWindow = 400_000;
		comp.getCachedContextBreakdown();

		expect(usageCalls()).toBe(2);
	});

	it("re-queries when only the in-flight pending revision changes (no message change)", () => {
		const fake = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 190_000, contextWindow: 272_000, percent: 69.9 },
		});
		const comp = new StatusLineComponent(fake.session);
		expect(comp.getCachedContextBreakdown().usedTokens).toBe(190_000);

		// Turn ends/aborts: the message list and last-message fingerprint are
		// unchanged, but clearing the pending snapshot recalibrates usage to the
		// real provider anchor. The memo must not keep serving the stale estimate.
		fake.setUsage({ tokens: 117_000, contextWindow: 272_000, percent: 43.0 });
		fake.setRevision(1);

		expect(comp.getCachedContextBreakdown().usedTokens).toBe(117_000);
		expect(fake.usageCalls()).toBe(2);
	});

	it("propagates a speculative/numeric token count, e.g. right after compaction", () => {
		const { session } = makeSession({
			messages: [userMessage("compaction summary")],
			usage: { tokens: 1234, contextWindow: 272_000, percent: 0.45 },
		});
		const breakdown = new StatusLineComponent(session).getCachedContextBreakdown();
		expect(breakdown.usedTokens).toBe(1234);
		expect(breakdown.contextWindow).toBe(272_000);
	});

	it("falls back to the model window with 0 tokens when usage is unavailable", () => {
		const { session } = makeSession({ messages: [userMessage("hi")], usage: undefined, contextWindow: 128_000 });
		const breakdown = new StatusLineComponent(session).getCachedContextBreakdown();
		expect(breakdown.usedTokens).toBe(0);
		expect(breakdown.contextWindow).toBe(128_000);
	});

	it("does not query usage when no context segment is rendered", () => {
		const { session, usageCalls } = makeSession({ messages: [userMessage("hi")] });
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
		});

		const border = comp.getTopBorder(80);
		expect(border.content.length).toBeGreaterThan(0);
		expect(usageCalls()).toBe(0);
	});

	it("renders the anchored percent against the (sub-)budget window in the context segment", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 5000, contextWindow: 272_000, percent: 1.8 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		// 5000 / 272000 → 1.8%, window formatted as 272K (matches the footer gauge).
		const plain = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("1.8%/272K");
	});

	it("renders speculative percent instead of ? after compaction", () => {
		const { session } = makeSession({
			messages: [userMessage("compaction summary")],
			usage: { tokens: 1234, contextWindow: 272_000, percent: 0.45 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const plain = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("0.5%/272K");
	});

	it("renders token usage with an unknown marker when the model window is unavailable", () => {
		const { session } = makeSession({
			messages: [userMessage("hi")],
			contextWindow: 0,
			usage: { tokens: 5000, contextWindow: 0, percent: 0 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const plain = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("5K/?");
		expect(plain).not.toContain("0.0%/0");
	});
});
