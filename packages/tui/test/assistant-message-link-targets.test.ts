import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import {
	type AssistantMessageHost,
	assistantMessageLinkTargets,
	createAssistantMessageComponent,
} from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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

describe("createAssistantMessageComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("draws a reply for a host whose extension runner predates text renderers", () => {
		const host: AssistantMessageHost = {
			viewSession: { extensionRunner: { getAssistantThinkingRenderers: () => [] } },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			expandThinkingBlocks: false,
			assistantImagesVisible: true,
			tableChartsVisible: true,
			hideToolActivity: false,
			toolOutputExpanded: false,
			ui: { requestRender: () => {}, imageBudget: new ImageBudget(8, () => {}) },
			resolveAssistantMessageLinkHrefs: async () => new Map(),
		};
		const component = createAssistantMessageComponent(host, assistant({ type: "text", text: "As written." }));
		expect(Bun.stripANSI(component.render(40).join("\n"))).toContain("As written.");
	});
});
