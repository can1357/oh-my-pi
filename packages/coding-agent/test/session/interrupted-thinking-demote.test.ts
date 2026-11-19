import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { demoteInterruptedThinking } from "@oh-my-pi/pi-coding-agent/session/messages";

function demoteContent(content: AssistantMessage["content"]) {
	return demoteInterruptedThinking({ content });
}

describe("demoteInterruptedThinking", () => {
	it("demotes a trailing run of non-empty thinking blocks and drops trailing empty text", () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "Visible answer." },
			{ type: "thinking", thinking: " First thought " },
			{ type: "thinking", thinking: "Second thought\n" },
			{ type: "text", text: " \n\t" },
		];

		expect(demoteContent(content)).toEqual({
			reasoning: "First thought\n\nSecond thought",
			strippedContent: [{ type: "text", text: "Visible answer." }],
			blockCount: 2,
		});
	});

	it("demotes only the final contiguous thinking run", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Earlier reasoning" },
			{ type: "text", text: "A visible checkpoint." },
			{ type: "thinking", thinking: "Interrupted tail" },
		];

		expect(demoteContent(content)).toEqual({
			reasoning: "Interrupted tail",
			strippedContent: [
				{ type: "thinking", thinking: "Earlier reasoning" },
				{ type: "text", text: "A visible checkpoint." },
			],
			blockCount: 1,
		});
	});

	it("returns undefined when the meaningful tail is text or a tool call", () => {
		expect(
			demoteContent([
				{ type: "thinking", thinking: "Do not demote" },
				{ type: "text", text: "Visible final text" },
			]),
		).toBeUndefined();

		expect(
			demoteContent([
				{ type: "thinking", thinking: "Do not demote" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
			]),
		).toBeUndefined();
	});

	it("returns undefined for empty, encrypted-only, and redacted thinking tails", () => {
		expect(demoteContent([])).toBeUndefined();
		expect(demoteContent([{ type: "text", text: "\n\t " }])).toBeUndefined();
		expect(demoteContent([{ type: "thinking", thinking: "", thinkingSignature: "opaque" }])).toBeUndefined();
		expect(
			demoteContent([
				{ type: "thinking", thinking: "Preserve visible reasoning" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque" },
				{ type: "text", text: "\n" },
			]),
		).toBeUndefined();
		expect(demoteContent([{ type: "thinking", thinking: " \n\t" }])).toBeUndefined();
		expect(demoteContent([{ type: "redactedThinking", data: "encrypted" }])).toBeUndefined();
	});

	it("preserves a non-empty signed thinking tail as native replayable reasoning", () => {
		expect(
			demoteContent([
				{ type: "text", text: "Visible answer." },
				{ type: "thinking", thinking: "Complete signed reasoning", thinkingSignature: "sig" },
			]),
		).toBeUndefined();
	});

	it("demotes only the unsigned tail and keeps an earlier signed thinking block", () => {
		expect(
			demoteContent([
				{ type: "thinking", thinking: "Complete signed reasoning", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "Interrupted unsigned tail" },
			]),
		).toEqual({
			reasoning: "Interrupted unsigned tail",
			strippedContent: [{ type: "thinking", thinking: "Complete signed reasoning", thinkingSignature: "sig" }],
			blockCount: 1,
		});
	});
});
