import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/messages";
import { printRows } from "../../../src/ui/print-rows";
import {
	AssistantMessageBlock,
	type AssistantMessageModel,
} from "../../../src/ui/transcript/messages/assistant-message";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

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

/** A settled assistant block's plain rows. */
function renderLines(message: AssistantMessage, hideThinkingBlock = false): string[] {
	const model: AssistantMessageModel = {
		message: signal(message),
		finalized: signal(true),
		hideThinking: signal(hideThinkingBlock),
	};
	return printRows(() => AssistantMessageBlock({ model }), RENDER_WIDTH).map(line => Bun.stripANSI(line).trimEnd());
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("assistant message block error rendering", () => {
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

describe("assistant message block hidden thinking rendering", () => {
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

describe("assistant message block streaming thinking pulse", () => {
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

	/** A live (streaming) block on a terminal whose clock stays at 0. */
	interface LiveBlock {
		readonly term: TestTerminal;
		readonly message: Signal<AssistantMessage | undefined>;
		readonly finalized: Signal<boolean>;
		text(): string;
	}

	function liveBlock(hideThinkingBlock = true): LiveBlock {
		const message = signal<AssistantMessage | undefined>(undefined);
		const finalized = signal(false);
		const model: AssistantMessageModel = {
			message,
			transient: signal(true),
			finalized,
			hideThinking: signal(hideThinkingBlock),
		};
		const term = createTestTerminal(() => ({ main: AssistantMessageBlock({ model }) }), {
			columns: RENDER_WIDTH,
			rows: 40,
			theme: loadThemeSync("dark"),
		});
		return { term, message, finalized, text: () => term.screen().join("\n") };
	}

	function liveLines(message: AssistantMessage, hideThinkingBlock = true): string[] {
		const block = liveBlock(hideThinkingBlock);
		try {
			block.message.set(message);
			block.term.render();
			return block.term.screen().map(line => line.trimEnd());
		} finally {
			block.term.dispose();
		}
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

	it("holds the pulse on its first facet while motion is reduced (tui.motion: none)", () => {
		const block = liveBlock();
		try {
			block.term.backend.setReduceMotion(true);
			block.message.set(streaming([{ type: "thinking", thinking: "private reasoning" }]));
			block.term.tick(5_000);
			expect(block.text()).toContain(`${PULSE} ${THINKING_LABEL}`);
		} finally {
			block.term.dispose();
		}
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
		const block = liveBlock();
		try {
			block.message.set(streaming([{ type: "thinking", thinking: "private reasoning" }]));
			block.term.render();
			expect(block.text().includes(PULSE)).toBe(true);

			block.finalized.set(true);
			block.term.render();
			expect(block.text().includes(PULSE)).toBe(false);
			expect(block.text().includes("private reasoning")).toBe(false);
		} finally {
			block.term.dispose();
		}
	});

	it("keeps the pulse across thinking deltas on a live block, then yields to text", () => {
		const block = liveBlock();
		const rendered = (): string => {
			block.term.render();
			return block.text();
		};
		try {
			block.message.set(streaming([{ type: "thinking", thinking: "a" }]));
			expect(rendered().includes(PULSE)).toBe(true);
			block.message.set(streaming([{ type: "thinking", thinking: "ab" }]));
			expect(rendered().includes(PULSE)).toBe(true);
			block.message.set(
				streaming([
					{ type: "thinking", thinking: "abc" },
					{ type: "text", text: "Answer" },
				]),
			);
			expect(rendered().includes(PULSE)).toBe(false);
			expect(rendered().includes("Answer")).toBe(true);
		} finally {
			block.term.dispose();
		}
	});
});
