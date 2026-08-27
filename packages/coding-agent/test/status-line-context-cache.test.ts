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
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme, setSymbolPreset, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSessionAccentAnsi } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { adjustHsv } from "@oh-my-pi/pi-utils";

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

function makeSession(opts: {
	messages: unknown[];
	contextWindow?: number;
	usage?: ContextUsage | undefined;
	settings?: AgentSession["settings"];
	/** Session title; `null` models a fresh, not-yet-titled session. */
	sessionName?: string | null;
	/** Model input modalities; gates snapcompact availability in boundary math. */
	modelInput?: string[];
}): Fake {
	const contextWindow = opts.contextWindow ?? 200_000;
	const model = opts.modelInput
		? { id: "test-model", contextWindow, input: opts.modelInput }
		: { id: "test-model", contextWindow };
	let usage: ContextUsage | undefined = "usage" in opts ? opts.usage : { tokens: 1234, contextWindow, percent: 0.6 };
	let calls = 0;
	let revision = 0;
	const session = {
		messages: opts.messages,
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages: opts.messages, model },
		settings: opts.settings,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => (opts.sessionName === null ? undefined : (opts.sessionName ?? "test")),
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
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

	it("memoizes usage queries so repeated renders query only once", () => {
		const { session, usageCalls } = makeSession({ messages: [userMessage("hi")] });
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
		});

		const border1 = comp.getTopBorder(80);
		const border2 = comp.getTopBorder(80);
		expect(border1.content.length).toBeGreaterThan(0);
		expect(border2.content.length).toBeGreaterThan(0);
		expect(usageCalls()).toBe(1);
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

	it("splits the gap gauge into used (accent) and unused (border) portions", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "percentage",
		});

		const border = comp.getTopBorder(80).content;
		// The gauge resets the background and paints the used half in the accent
		// border color, the remainder in the plain border color.
		expect(border).toContain("\x1b[49m");
		expect(border).toContain(theme.getFgAnsi("borderAccent"));
		expect(border).toContain(theme.getFgAnsi("border"));
	});

	it("contextLine off renders a solid accent gauge without the unused split", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "off",
		});

		const border = comp.getTopBorder(80).content;
		expect(border).toContain(theme.getFgAnsi("borderAccent"));
		expect(border).not.toContain(`${theme.getFgAnsi("border")}─`);
	});

	it("loads embedded mode on the initial render and absorbs configured context segments", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 80_000, contextWindow: 1_000_000, percent: 8 },
		});
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "context_pct"]);
		settings.override("statusLine.rightSegments", ["context_total", "session_name"]);
		settings.override("statusLine.contextLine", "embedded");

		try {
			const comp = new StatusLineComponent(session);
			const border = comp.getTopBorder(120);
			const plain = border.content.replaceAll(/\x1b\[[0-9;]*m/g, "");
			const percentIndex = plain.indexOf("8%");
			const speculationIndex = plain.indexOf("╎");
			const compactionIndex = plain.indexOf("┃");
			const windowIndex = plain.indexOf("1M");
			expect(border.width).toBe(120);
			expect(plain).not.toContain("8.0%/1M");
			expect(percentIndex).toBeGreaterThanOrEqual(0);
			expect(speculationIndex).toBeGreaterThan(percentIndex);
			expect(compactionIndex).toBeGreaterThan(speculationIndex);
			expect(windowIndex).toBeGreaterThan(compactionIndex);
			expect(plain.indexOf("1M", windowIndex + 1)).toBe(-1);
		} finally {
			settings.clearOverride("statusLine.contextLine");
			settings.clearOverride("statusLine.rightSegments");
			settings.clearOverride("statusLine.leftSegments");
			settings.clearOverride("statusLine.preset");
		}
	});
	it("keeps embedded context on the gauge while the session is unnamed", () => {
		// Regression: a fresh session has no title, so `session_name` is
		// invisible and the right group is empty. The gauge must still bridge to
		// the border edge and absorb the context segment — not fall back to a
		// context chip that vanishes once the session gets auto-titled.
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 80_000, contextWindow: 1_000_000, percent: 8 },
			sessionName: null,
		});
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "context_pct"]);
		settings.override("statusLine.rightSegments", ["session_name"]);
		settings.override("statusLine.contextLine", "embedded");

		try {
			const comp = new StatusLineComponent(session);
			const border = comp.getTopBorder(120);
			const plain = border.content.replaceAll(/\x1b\[[0-9;]*m/g, "");
			expect(border.width).toBe(120);
			expect(plain).not.toContain("8.0%/1M");
			expect(plain).toContain("8%");
			expect(plain).toContain("1M");
		} finally {
			settings.clearOverride("statusLine.contextLine");
			settings.clearOverride("statusLine.rightSegments");
			settings.clearOverride("statusLine.leftSegments");
			settings.clearOverride("statusLine.preset");
		}
	});
	it("embedded overflow (>100%) breaks the raw percent past the window label in error color", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			contextWindow: 200_000,
			usage: { tokens: 240_000, contextWindow: 200_000, percent: 120 },
		});
		settings.override("statusLine.preset", "custom");
		settings.override("statusLine.leftSegments", ["pi", "context_pct"]);
		settings.override("statusLine.rightSegments", ["context_total", "session_name"]);
		settings.override("statusLine.contextLine", "embedded");

		try {
			const comp = new StatusLineComponent(session);
			const border = comp.getTopBorder(120);
			const plain = border.content.replaceAll(/\x1b\[[0-9;]*m/g, "");
			const windowIndex = plain.indexOf("200K");
			const percentIndex = plain.indexOf("120%");
			expect(border.width).toBe(120);
			expect(windowIndex).toBeGreaterThanOrEqual(0);
			expect(percentIndex).toBeGreaterThan(windowIndex);
			// The clamped label must not render alongside the overflow one.
			expect(plain).not.toContain("100%");
			expect(border.content).toContain(`${theme.getFgAnsi("error")}120%`);
		} finally {
			settings.clearOverride("statusLine.contextLine");
			settings.clearOverride("statusLine.rightSegments");
			settings.clearOverride("statusLine.leftSegments");
			settings.clearOverride("statusLine.preset");
		}
	});
	it("uses semantic Nerd Font markers for async speculation and compaction boundaries", async () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
			settings,
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "annotated",
		});

		await setSymbolPreset("nerd");
		try {
			const border = comp.getTopBorder(80).content;
			const nerd = border.replaceAll(/\x1b\[[0-9;]*m/g, "");
			const speculationIndex = nerd.indexOf("󰕝");
			const compactionIndex = nerd.indexOf("󰁨");
			expect(speculationIndex).toBeGreaterThanOrEqual(0);
			expect(compactionIndex).toBeGreaterThanOrEqual(0);
			expect(speculationIndex).toBeLessThan(compactionIndex);
			expect(nerd).not.toContain("╎");
			expect(nerd).not.toContain("┃");
			const expectedDimmed = getSessionAccentAnsi(adjustHsv(theme.getColorHex("borderAccent"), { s: 0.7, v: 0.75 }));
			expect(border).toContain(`${expectedDimmed}󰁨`);
			expect(border).not.toContain(`${theme.getFgAnsi("warning")}󰁨`);
			await setSymbolPreset("unicode");
			const unicode = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
			expect(unicode).toContain("╎");
			expect(unicode).toContain("┃");
			expect(unicode).not.toContain("󰕝");
			expect(unicode).not.toContain("󰁨");
		} finally {
			await initTheme();
		}
	});

	it("hides the speculation tick when the leading method is instant snapcompact", () => {
		// A vision model with snapcompact first never speculates (local, instant),
		// so the gauge shows only the auto-compaction boundary.
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
			settings: Settings.isolated({ "compaction.methodOrder": ["snapcompact", "soft"] }),
			modelInput: ["text", "image"],
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "annotated",
		});

		const plain = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("┃");
		expect(plain).not.toContain("╎");
	});

	it("hides the speculation tick when async compaction is disabled", () => {
		const { session } = makeSession({
			messages: [userMessage("hi"), assistantMessage("done")],
			usage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
			settings: Settings.isolated({ "compaction.asyncEnabled": false }),
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "annotated",
		});

		const plain = comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("┃");
		expect(plain).not.toContain("╎");
	});

	it("standalone mode renders a plain bottom bar without powerline chrome", () => {
		const { session } = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 1000, contextWindow: 100_000, percent: 1 },
		});
		const comp = new StatusLineComponent(session);
		expect(comp.render(80)).toHaveLength(0); // box mode: main status lives in the editor border

		comp.setComposerStyle({ bottomBar: "full", bottomBarGap: false });
		const lines = comp.render(80);
		expect(lines).toHaveLength(1);
		// Plain bar: transparent background, no powerline caps or bg fill.
		expect(lines[0]).not.toContain("\x1b[48;");
		expect(lines[0]).toContain("\x1b[49m");

		// Styles without bottom chrome (rule/field/rail) request a spacer row so
		// the bar doesn't sit flush against the last input row.
		comp.setComposerStyle({ bottomBar: "full", bottomBarGap: true });
		const gapped = comp.render(80);
		expect(gapped).toHaveLength(2);
		expect(gapped[0]).toBe("");
		expect(gapped[1]).toBe(lines[0]);
	});

	it("standalone bar yields to the autocomplete menu via the probe", () => {
		const { session } = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 1000, contextWindow: 100_000, percent: 1 },
		});
		const comp = new StatusLineComponent(session);
		comp.setComposerStyle({ bottomBar: "full", bottomBarGap: true });
		let menuOpen = true;
		comp.setAutocompleteActiveProbe(() => menuOpen);
		expect(comp.render(80)).toHaveLength(0);
		menuOpen = false;
		expect(comp.render(80)).toHaveLength(2); // spacer + bar return together
	});

	it("claude layout splits groups: left-only bottom bar, right group as top-rule chip", () => {
		const { session } = makeSession({
			messages: [userMessage("hi")],
			usage: { tokens: 1000, contextWindow: 100_000, percent: 1 },
		});
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
		});
		comp.setComposerStyle({ bottomBar: "left", bottomBarGap: false });

		const bottom = comp.render(80);
		expect(bottom).toHaveLength(1);
		expect(bottom[0]).not.toContain("test"); // session name lives in the chip, not the bottom bar

		const chip = comp.getStandaloneTopBorder(80);
		expect(chip.width).toBeGreaterThan(0);
		expect(chip.content).toContain("test");
	});
});
