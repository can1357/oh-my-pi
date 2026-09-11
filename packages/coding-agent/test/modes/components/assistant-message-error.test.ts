import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AssistantMessageComponent,
	resetThinkingSpeedTracker,
} from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

const RENDER_WIDTH = 120;

function erroredMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function renderLines(message: AssistantMessage, hideThinkingBlock = false): string[] {
	const component = new AssistantMessageComponent(message, hideThinkingBlock);
	return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
});

describe("AssistantMessageComponent error rendering", () => {
	// A proxy 502 returns its own HTML page as the body; AnthropicApiError folds
	// that whole document into `errorMessage`. The inline transcript render must
	// not faithfully reprint every line, or the scrollback fills with the HTML
	// page's blank lines (the reported "weird terminal state").
	const longLine = "x".repeat(300);
	const body = Array.from({ length: 25 }, (_, i) => `marker-${i} <div>content</div>`).join("\n\n");
	const proxy502 = `${longLine}\n\n${body}`;

	it("drops the blank-line flood from a multi-line HTML error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		// The body interleaves 25 markers with blank lines (~50 source lines). If
		// blanks leaked through, the rendered block would be dozens of lines tall.
		const blankRun = lines.reduce(
			(acc, line) => {
				const run = line === "" ? acc.run + 1 : 0;
				return { run, max: Math.max(acc.max, run) };
			},
			{ run: 0, max: 0 },
		);
		expect(blankRun.max).toBeLessThanOrEqual(1);
		expect(lines.length).toBeLessThan(15);
	});

	it("clamps the row count of a runaway error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const markerLines = lines.filter(line => line.includes("marker-"));
		// MAX_TRANSCRIPT_ERROR_ROWS is 8; the wrapped long line spends several of
		// them, so only the first few markers survive — the late ones are gone.
		expect(markerLines.length).toBeLessThanOrEqual(7);
		expect(lines.some(line => line.includes("marker-0"))).toBe(true);
		expect(lines.some(line => line.includes("marker-24"))).toBe(false);
	});

	it("wraps an overlong error line within the render width instead of cutting it", () => {
		const lines = renderLines(erroredMessage(proxy502));
		// Every row fits the terminal, and the 300-char line is fully readable
		// across rows rather than ending in an ellipsis at a fixed column.
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(RENDER_WIDTH);
		const body = lines.filter(line => !line.includes("more lines"));
		expect((body.join("").match(/x/g) ?? []).length).toBe(300);
		expect(body.some(line => line.includes("…"))).toBe(false);
	});

	it("renders a short single-line error unchanged", () => {
		const lines = renderLines(erroredMessage("overloaded_error: Overloaded"));
		expect(lines.some(line => line.includes("Error: overloaded_error: Overloaded"))).toBe(true);
	});
});

describe("AssistantMessageComponent hidden thinking rendering", () => {
	function thinkingMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("omits hidden thinking instead of rendering a placeholder", () => {
		const lines = renderLines(thinkingMessage(), true);
		expect(lines.some(line => line.includes("Thinking..."))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("still renders thinking when it is not hidden", () => {
		const lines = renderLines(thinkingMessage());
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});
});

describe("AssistantMessageComponent streaming thinking pulse", () => {
	// The in-flight streaming partial always carries stopReason "stop" (proxy.ts
	// seeds it), so "still streaming" is keyed off the block not yet being
	// finalized — a live component is constructed with no message.
	function streaming(content: AssistantMessage["content"], output = 0): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function liveLines(message: AssistantMessage, hideThinkingBlock = true): string[] {
		const component = new AssistantMessageComponent(undefined, hideThinkingBlock);
		component.updateContent(message);
		const lines = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		component.dispose();
		return lines;
	}

	// First frame of the expanding/shrinking ✻ pulse; deterministic right after updateContent.
	const PULSE = "✻";
	const THINKING_LABEL = "Thinking";
	const THINKING_GLYPH_ONLY_LINE = /^[✻✼❉❊✺✹✸✶]\s*$/;

	it("shows a described pulse in place of hidden reasoning while thinking streams", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		expect(lines.some(line => line.includes(PULSE) && line.includes(THINKING_LABEL))).toBe(true);
		expect(lines.map(line => line.trim()).some(line => THINKING_GLYPH_ONLY_LINE.test(line))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
	});

	it("drops the pulse once visible text starts streaming", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			]),
		);
		expect(lines.some(line => line.includes(PULSE))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("does not show the pulse when thinking is visible", () => {
		const lines = liveLines(streaming([{ type: "thinking", thinking: "private reasoning" }]), false);
		expect(lines.some(line => line.includes(PULSE))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});

	it("does not show the pulse once a tool call streams", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
			]),
		);
		expect(lines.some(line => line.includes(PULSE))).toBe(false);
	});

	it("removes the pulse when the block is finalized", () => {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(streaming([{ type: "thinking", thinking: "private reasoning" }]));
		expect(Bun.stripANSI(component.render(RENDER_WIDTH).join("\n")).includes(PULSE)).toBe(true);

		component.markTranscriptBlockFinalized();
		const afterFinalize = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(afterFinalize.includes(PULSE)).toBe(false);
		expect(afterFinalize.includes("private reasoning")).toBe(false);
		component.dispose();
	});

	it("keeps the pulse across thinking deltas on a reused component, then yields to text", () => {
		// Mirrors live streaming: one component reused across updateContent calls
		// (the fast path early-returns on a stable shape, so the placeholder must
		// persist) until visible text arrives and replaces it.
		const component = new AssistantMessageComponent(undefined, true);
		const rendered = () => Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }]));
		expect(rendered().includes(PULSE)).toBe(true);
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }]));
		expect(rendered().includes(PULSE)).toBe(true);
		component.updateContent(
			streaming([
				{ type: "thinking", thinking: "abc" },
				{ type: "text", text: "Answer" },
			]),
		);
		expect(rendered().includes(PULSE)).toBe(false);
		expect(rendered().includes("Answer")).toBe(true);
		component.dispose();
	});

	it("derives the windowed token speed from provider usage while thinking streams", () => {
		resetThinkingSpeedTracker();
		const component = new AssistantMessageComponent(undefined, true);
		const nowSpy = spyOn(performance, "now");

		let mockTime = 1000;
		nowSpy.mockImplementation(() => mockTime);

		// First update seeds the baseline from provider output tokens; no rate yet.
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }], 10), { transient: true });

		// +47 provider output tokens 1s later → 47 tok/s.
		mockTime = 2000;
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }], 57), { transient: true });

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		// Layout: "<glyph> Thinking · <total> · <rate> toks/s" — 57 provider tokens, 47.0 tok/s.
		expect(plain).toContain("57 · 47.0 toks/s");

		nowSpy.mockRestore();
		component.dispose();
	});

	it("clamps the displayed speed to the 200 tok/s ceiling", () => {
		resetThinkingSpeedTracker();
		const component = new AssistantMessageComponent(undefined, true);
		const nowSpy = spyOn(performance, "now");

		let mockTime = 1000;
		nowSpy.mockImplementation(() => mockTime);
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }], 10), { transient: true });

		// +977 provider output tokens in 100 ms is far past the ceiling.
		mockTime = 1100;
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }], 987), { transient: true });

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toContain("200.0 toks/s");

		nowSpy.mockRestore();
		component.dispose();
	});

	it("drops the badge entirely once the rate reads zero (streaming lull)", () => {
		resetThinkingSpeedTracker();
		const component = new AssistantMessageComponent(undefined, true);
		const nowSpy = spyOn(performance, "now");

		let mockTime = 1000;
		nowSpy.mockImplementation(() => mockTime);
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }], 10), { transient: true });
		mockTime = 2000;
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }], 57), { transient: true });

		// Long pause: rate observations age out of the window. A same-token update
		// refreshes the live label, which now drops the numeric badge entirely
		// rather than lingering on "0.0 toks/s" while retaining descriptive text.
		mockTime = 30_000;
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }], 57), { transient: true });
		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).not.toContain("toks/s");
		expect(plain).not.toContain("57");
		expect(plain.includes(PULSE)).toBe(true);
		expect(plain).toContain(THINKING_LABEL);

		nowSpy.mockRestore();
		component.dispose();
	});

	it("ignores the session gauge's prior-turn rate on a fresh token-less block", () => {
		resetThinkingSpeedTracker();
		const nowSpy = spyOn(performance, "now");
		let mockTime = 1000;
		nowSpy.mockImplementation(() => mockTime);

		// Block A records a live rate into the session-wide gauge.
		const a = new AssistantMessageComponent(undefined, true);
		a.updateContent(streaming([{ type: "thinking", thinking: "a" }], 10), { transient: true });
		mockTime = 2000;
		a.updateContent(streaming([{ type: "thinking", thinking: "ab" }], 57), { transient: true });
		expect(Bun.stripANSI(a.render(RENDER_WIDTH).join("\n"))).toContain("toks/s");
		a.dispose();

		// Block B starts moments later with provider tokens but no positive delta of
		// its own; the gauge still holds A's observation, but B must not borrow it.
		mockTime = 2500;
		const b = new AssistantMessageComponent(undefined, true);
		b.updateContent(streaming([{ type: "thinking", thinking: "xyz" }], 99), { transient: true });
		const plain = Bun.stripANSI(b.render(RENDER_WIDTH).join("\n"));
		expect(plain).not.toContain("toks/s");
		expect(plain).not.toContain("99");
		expect(plain.includes(PULSE)).toBe(true);
		expect(plain).toContain(THINKING_LABEL);

		nowSpy.mockRestore();
		b.dispose();
	});
});
