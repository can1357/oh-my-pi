import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const RENDER_WIDTH = 120;

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
const originalHyperlinks = terminalState.hyperlinks;

beforeAll(async () => {
	await initTheme(false);
	terminalState.hyperlinks = true;
});

afterAll(() => {
	terminalState.hyperlinks = originalHyperlinks;
});

describe("assistant message link URLs", () => {
	it("appends the parenthesized URL for named links by default", () => {
		const component = new AssistantMessageComponent(textMessage("Read [the docs](https://example.com) first."));

		const rendered = component.render(RENDER_WIDTH).join("\n");
		expect(Bun.stripANSI(rendered)).toContain("(https://example.com)");
	});

	it("omits the URL when linkUrls is disabled while keeping the label linked", () => {
		const component = new AssistantMessageComponent();
		component.linkUrls = false;
		component.updateContent(textMessage("Read [the docs](https://example.com) first."));

		const rendered = component.render(RENDER_WIDTH).join("\n");
		const plain = Bun.stripANSI(rendered);
		expect(plain).toContain("the docs");
		expect(plain).not.toContain("(https://example.com)");
		expect(plain).not.toContain("https://example.com");
		expect(rendered.includes("\x1b]8;;https://example.com\x07"), "Label stays hyperlinked").toBe(true);
	});
});
