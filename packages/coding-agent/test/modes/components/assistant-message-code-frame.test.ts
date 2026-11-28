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
	setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true, codeFrame: false });
});

describe("assistant message code frames", () => {
	it("repaints a settled reply with hairlines when the host look's codeFrame flips, leaving the code rows alone", () => {
		ensureTheme();
		const env = staticEnvironment(currentTheme(), { now: 0, reduceMotion: true });
		const message = createAssistantMessage("Run it:\n\n```sh\necho hi\n```\n");
		createRoot(dispose => {
			try {
				const nodes = resolveChildren(() =>
					AssistantMessageBlock({ model: { message: signal(message), finalized: signal(true) } }),
				)();
				const paint = () =>
					nodes.flatMap(node => renderBlock(node, 60, { env }).rows).map(row => Bun.stripANSI(row).trimEnd());

				const fenced = paint();
				expect(fenced.some(row => row.includes("```sh"))).toBe(true);
				expect(fenced.some(row => row.includes("╌"))).toBe(false);

				setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true, codeFrame: true });
				const framed = paint();
				expect(framed.some(row => row.includes("```"))).toBe(false);
				expect(framed.some(row => row.includes("╌╌ sh ╌"))).toBe(true);
				expect(framed.some(row => /^╌+$/.test(row.trim()))).toBe(true);
				// The body keeps its row, so a selection of it copies the code exactly.
				expect(framed.filter(row => row.includes("echo hi")).map(row => row.trim())).toEqual(["echo hi"]);
			} finally {
				dispose();
			}
		});
	});
});
