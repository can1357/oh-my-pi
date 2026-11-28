import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRoot, resolveChildren, signal } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { setMarkdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/messages";
import { ensureTheme } from "../../../src/ui/theme/service";
import { AssistantMessageBlock } from "../../../src/ui/transcript/messages/assistant-message";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
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

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true });
});

describe("assistant message link urls", () => {
	it("repaints a settled message when the host look's linkUrls flips", () => {
		ensureTheme();
		const env = staticEnvironment(currentTheme(), { now: 0, reduceMotion: true, hyperlinks: true });
		const message = createAssistantMessage("Read [the docs](https://example.com) first.");
		createRoot(dispose => {
			try {
				const nodes = resolveChildren(() =>
					AssistantMessageBlock({ model: { message: signal(message), finalized: signal(true) } }),
				)();
				const paint = () =>
					nodes
						.flatMap(node => renderBlock(node, 120, { env }).rows)
						.map(row => Bun.stripANSI(row))
						.join("\n");

				expect(paint()).toContain("the docs (https://example.com)");
				setMarkdownLook({ colorful: true, mermaid: true, linkUrls: false });
				const hidden = paint();
				expect(hidden).toContain("the docs");
				expect(hidden).not.toContain("(https://example.com)");
			} finally {
				dispose();
			}
		});
	});
});
