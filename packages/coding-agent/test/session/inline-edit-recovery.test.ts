import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { recoverInlineSloppyEdit } from "../../src/session/inline-edit-recovery";

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		timestamp: 1,
	};
}

const payload = [
	'<SM:EDIT path="src/a.ts">',
	"<SM:FIND>",
	"const x = 1;",
	"</SM:FIND>",
	"<SM:PUT>",
	"const x = 2;",
	"</SM:PUT>",
	"</SM:EDIT>",
].join("\n");

describe("recoverInlineSloppyEdit", () => {
	test("lifts a stray payload out of prose into a synthetic edit tool call", () => {
		const message = assistant([{ type: "text", text: `Fixing the constant.\n\n${payload}\n\nDone.` }], "stop");

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		const text = message.content.find(block => block.type === "text");
		expect(text?.type === "text" && text.text).toBe("Fixing the constant.\n\n\nDone.");
		const call = message.content.find(block => block.type === "toolCall");
		expect(call?.type === "toolCall" && call.name).toBe("edit");
		expect(call?.type === "toolCall" && call.arguments).toEqual({ input: payload });
		expect(call?.type === "toolCall" && call.rawBlock).toBe(payload);
	});

	test("drops a text block the payload fully occupied, leaving only the call", () => {
		const message = assistant([{ type: "text", text: payload }], "stop");

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		expect(message.content.map(block => block.type)).toEqual(["toolCall"]);
	});

	test("never executes a length-truncated payload", () => {
		const message = assistant([{ type: "text", text: payload }], "length");

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content.map(block => block.type)).toEqual(["text"]);
	});

	test("leaves a turn that already carries tool calls untouched", () => {
		const message = assistant(
			[
				{ type: "text", text: payload },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
			],
			"stop",
		);

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content.map(block => block.type)).toEqual(["text", "toolCall"]);
	});
});
