import { describe, expect, it } from "bun:test";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { assistantMessageLinkTargets } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";

function assistant(block: TextContent): AssistantMessage {
	return {
		role: "assistant",
		content: [block],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
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
	};
}

describe("assistantMessageLinkTargets", () => {
	it("picks up a link that completes while its streaming text block grows in place", () => {
		const block: TextContent = { type: "text", text: "See [the report](local://report" };
		const message = assistant(block);
		const targets = new Map([["local://report.md", "file:///tmp/report.md"]]);
		expect([...assistantMessageLinkTargets(message, targets)]).toEqual([]);

		block.text += ".md) for details.";
		expect([...assistantMessageLinkTargets(message, targets)]).toEqual([
			["local://report.md", "file:///tmp/report.md"],
		]);
	});
});
