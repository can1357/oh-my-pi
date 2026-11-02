import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const REASONING = "Weighing whether the gradle run already finished.";
const NARRATION = "The build is running; it should finish in about fifteen minutes.";

function turn(narration: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: REASONING, thinkingSignature: "sig-reasoning" },
			{ type: "thinking", thinking: NARRATION, thinkingSignature: "sig-narration", ...(narration && { narration }) },
			{ type: "toolCall", id: "toolu_1", name: "wait", arguments: {} },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function rendered(message: AssistantMessage): string {
	// Thinking hidden: only answer text may reach the transcript.
	return Bun.stripANSI(new AssistantMessageComponent(message, true).render(100).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("narration returned as thinking", () => {
	// Regression: Opus 5.5 returns between-tool replies as thinking blocks, so a
	// reply to a mid-task question vanished into the folded reasoning.
	it("renders narration as answer text while reasoning stays hidden", () => {
		const output = rendered(turn(true));
		expect(output).toContain(NARRATION);
		expect(output).not.toContain(REASONING);
	});

	it("keeps unmarked thinking hidden", () => {
		expect(rendered(turn(false))).not.toContain(NARRATION);
	});
});
