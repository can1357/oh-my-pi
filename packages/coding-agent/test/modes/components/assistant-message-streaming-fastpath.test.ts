import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/messages";
import { AssistantMessageBlock } from "../../../src/ui/transcript/messages/assistant-message";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const W = 100;
const DARK = loadThemeSync("dark");

function msg(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** An assistant block on a terminal, its reply and display flags movable. */
interface Block {
	readonly term: TestTerminal;
	readonly message: Signal<AssistantMessage | undefined>;
	readonly transient: Signal<boolean>;
	readonly hideThinking: Signal<boolean>;
	/** The rows (escapes kept) after a paint. */
	rows(): string;
}

function block(options: { hideThinking?: boolean; transient?: boolean } = {}): Block {
	const message = signal<AssistantMessage | undefined>(undefined);
	const transient = signal(options.transient ?? false);
	const hideThinking = signal(options.hideThinking ?? false);
	const term = createTestTerminal(
		() => ({ main: AssistantMessageBlock({ model: { message, transient, hideThinking } }) }),
		{ columns: W, rows: 80, theme: DARK },
	);
	return {
		term,
		message,
		transient,
		hideThinking,
		rows() {
			term.render();
			return term.rows().join("\n");
		},
	};
}

/** `m` drawn by a brand-new block. */
function freshRender(m: AssistantMessage, options: { hideThinking?: boolean; transient?: boolean } = {}): string {
	const fresh = block(options);
	try {
		fresh.message.set(m);
		return fresh.rows();
	} finally {
		fresh.term.dispose();
	}
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

// Contract: a block that follows a streaming reply through every update MUST draw
// exactly what a fresh block draws for the same reply — at every step. If they
// ever diverge, the live transcript silently shows something the reply is not.
describe("assistant message block across streaming updates", () => {
	it("matches a fresh render across a growing thinking + text stream", () => {
		const reused = block();
		const thinking = "Reasoning about the **problem** with `code` and a list:\n- a\n- b";
		const steps = [
			"He",
			"Hello, ",
			"Hello, world.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.\n\n```ts\nconst x = 1;\n```",
		];
		try {
			for (const text of steps) {
				const m = msg([
					{ type: "thinking", thinking },
					{ type: "text", text },
				]);
				reused.message.set(m);
				expect(reused.rows()).toBe(freshRender(m));
			}
		} finally {
			reused.term.dispose();
		}
	});

	it("does not render dot-only reasoning placeholders", () => {
		const rendered = Bun.stripANSI(
			freshRender(
				msg([
					{ type: "thinking", thinking: ". . .", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "answer" },
				]),
			),
		);

		expect(rendered).toContain("answer");
		expect(rendered).not.toContain(". . .");
	});

	it("repairs Gemini's lone closing fence when the streamed turn becomes final", () => {
		const text = `=== PACED IP ROTATION SOAK RESULTS ===
Average Latency: 1,240 ms
\`\`\`

---

### Production Deployment Status

| Workload | Pod Status |
| :--- | :--- |
| google-scraper | **1/1 Running** |`;
		const live = block({ transient: true });
		try {
			live.message.set(msg([{ type: "text", text }]));
			expect(Bun.stripANSI(live.rows())).toContain("| :--- | :--- |");

			live.transient.set(false);
			const finalized = Bun.stripANSI(live.rows());
			expect(finalized).not.toContain("| :--- | :--- |");
			expect(finalized).toContain("google-scraper");
			expect(finalized).toContain("1/1 Running");
		} finally {
			live.term.dispose();
		}
	});

	it("matches a fresh render when a redactedThinking block shifts indices mid-stream", () => {
		const reused = block();
		try {
			const a = msg([
				{ type: "thinking", thinking: "step one details here" },
				{ type: "text", text: "answer one" },
			]);
			reused.message.set(a);
			expect(reused.rows()).toBe(freshRender(a));

			// A redactedThinking block appears at index 0, pushing thinking->1, text->2.
			const b = msg([
				{ type: "redactedThinking", data: "opaque-blob" },
				{ type: "thinking", thinking: "step two with more detail" },
				{ type: "text", text: "answer two is longer now" },
			]);
			reused.message.set(b);
			expect(reused.rows()).toBe(freshRender(b));
		} finally {
			reused.term.dispose();
		}
	});

	it("matches a fresh render when an error trailer appears after streamed text", () => {
		const reused = block();
		try {
			const ok = msg([{ type: "text", text: "partial answer in progress" }]);
			reused.message.set(ok);
			expect(reused.rows()).toBe(freshRender(ok));

			const errored = msg([{ type: "text", text: "partial answer in progress" }], {
				stopReason: "error",
				errorMessage: "upstream 502",
			});
			reused.message.set(errored);
			expect(reused.rows()).toBe(freshRender(errored));
		} finally {
			reused.term.dispose();
		}
	});

	it("matches a fresh render when a block's visibility toggles (empty -> non-empty)", () => {
		const reused = block();
		try {
			// First an empty trailing text block (not rendered), then it gains content.
			const empty = msg([
				{ type: "thinking", thinking: "thinking out loud" },
				{ type: "text", text: "" },
			]);
			reused.message.set(empty);
			expect(reused.rows()).toBe(freshRender(empty));

			const filled = msg([
				{ type: "thinking", thinking: "thinking out loud" },
				{ type: "text", text: "now there is an answer" },
			]);
			reused.message.set(filled);
			expect(reused.rows()).toBe(freshRender(filled));
		} finally {
			reused.term.dispose();
		}
	});

	it("matches fresh live output across hidden thinking emptiness transitions and reveal", () => {
		const reused = block({ hideThinking: true, transient: true });
		const latestReasoning = "Latest canonical reasoning";
		try {
			// A comment is raw-nonempty but display-empty; whitespace is canonically empty.
			// Neither transition may leave the live pulse missing or stale.
			for (const thinking of ["", "<!-- -->", " \n", latestReasoning]) {
				const message = msg([
					{ type: "text", text: "Visible answer" },
					{ type: "thinking", thinking },
				]);
				reused.message.set(message);
				expect(reused.rows()).toBe(freshRender(message, { hideThinking: true, transient: true }));
			}

			reused.hideThinking.set(false);
			const revealed = Bun.stripANSI(reused.rows());
			expect(revealed).toContain(latestReasoning);
			expect(revealed).toContain("Visible answer");
		} finally {
			reused.term.dispose();
		}
	});

	it("does not re-format an already-display thinking block (rawThinking set)", () => {
		// A display message carries a thinking block whose `thinking` is already the
		// formatted display text, the original under `rawThinking`: the fenced
		// content must not be stripped a second time.
		const m = msg([
			{
				type: "thinking",
				thinking: "Visible\n```\nkeep me\n```",
				rawThinking: "raw",
			},
		] as unknown as AssistantMessage["content"]);
		expect(Bun.stripANSI(freshRender(m))).toContain("keep me");
	});
});
