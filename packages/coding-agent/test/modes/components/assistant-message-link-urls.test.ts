import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { signal } from "@oh-my-pi/pi-tui";
import { setMarkdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/messages";
import { printRows } from "../../../src/ui/print-rows";
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

function renderMessage(message: AssistantMessage): string {
	const rows = printRows(
		() => AssistantMessageBlock({ model: { message: signal(message), finalized: signal(true) } }),
		120,
		{ hyperlinks: true },
	);
	return rows.map(line => Bun.stripANSI(line).trimEnd()).join("\n");
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
	it("follows the linkUrls look on a rendered message and flips with it", () => {
		setMarkdownLook({ colorful: true, mermaid: true, linkUrls: false });
		const message = createAssistantMessage("Read [the docs](https://example.com) first.");

		const hidden = renderMessage(message);
		expect(hidden).toContain("the docs");
		expect(hidden).not.toContain("(https://example.com)");

		setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true });
		expect(renderMessage(message)).toContain("(https://example.com)");
	});

	it("keeps the label hyperlinked while the suffix is hidden", () => {
		setMarkdownLook({ colorful: true, mermaid: true, linkUrls: false });
		const rows = printRows(
			() =>
				AssistantMessageBlock({
					model: {
						message: signal(createAssistantMessage("Read [the docs](https://example.com) first.")),
						finalized: signal(true),
					},
				}),
			120,
			{ hyperlinks: true },
		);
		expect(rows.some(line => line.includes("\x1b]8;;https://example.com\x07"))).toBe(true);
	});
});
