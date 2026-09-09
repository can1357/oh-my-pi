import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

function buildContext(): InteractiveModeContext {
	const chatContainer = new TranscriptContainer();
	return {
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		getUserMessageText: (message: Message) =>
			message.role === "user" && typeof message.content === "string" ? message.content : "",
		viewSession: {
			extensionRunner: undefined,
			sessionManager: { putBlobSync: () => "unused" },
		},
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		settings: { get: vi.fn(() => false) },
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		editor: { addToHistory: vi.fn() },
	} as unknown as InteractiveModeContext;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("post-compaction transcript reuse", () => {
	it("retains settled user and assistant components across a rebuild", () => {
		const ctx = buildContext();
		const helpers = new UiHelpers(ctx);
		const messages: AgentMessage[] = [
			{ role: "user", content: "large settled user turn", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "## Large settled assistant turn\n\n```ts\nconst retained = true;\n```" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		for (const message of messages) helpers.addMessageToChat(message);
		const settledComponents = ctx.chatContainer.children;
		ctx.chatContainer.clear();
		for (const message of messages) {
			helpers.addMessageToChat(message, { reuseSettledComponent: true });
		}

		expect(ctx.chatContainer.children).toEqual(settledComponents);
	});
});
