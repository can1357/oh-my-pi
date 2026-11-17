import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createOpenAIResponsesHistoryPayload, syncOpenAIResponsesHistoryTexts } from "@oh-my-pi/pi-ai/utils";
import type { AssistantMessage, Context, TextContent } from "@oh-my-pi/pi-ai/types";
import { createCodexModel } from "./helpers";

const model = createCodexModel("gpt-5.6-codex");

function fixtureMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{
				type: "text",
				text: "original",
				textSignature: JSON.stringify({ v: 1, id: "msg_fixture", phase: "commentary" }),
			},
		],
		providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
			{ type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "ENC" },
			{
				type: "message",
				id: "msg_fixture",
				role: "assistant",
				phase: "commentary",
				content: [
					{
						type: "output_text",
						text: "original",
						annotations: [{ type: "url_citation", url: "https://example.test/a" }],
					},
				],
			},
		]),
	};
}

function userContext(messages: AssistantMessage[]): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "hello", timestamp: 1 }, ...messages],
	};
}

function replayedOutputTexts(context: Context): string[] {
	const texts: string[] = [];
	for (const message of convertCodexResponsesMessages(model, context)) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if ((part as { type?: unknown }).type === "output_text") {
				texts.push((part as { text: string }).text);
			}
		}
	}
	return texts;
}

describe("assistant_message rewrites reaching Codex native replay (#18312)", () => {
	it("delivers the rewrite through same-model native replay once the payload is synced", () => {
		const message = fixtureMessage();
		const rewritten: AssistantMessage["content"] = [{ ...(message.content[0] as TextContent), text: "rewritten" }];
		const synced = syncOpenAIResponsesHistoryTexts(message.providerPayload, ["rewritten"]);
		const texts = replayedOutputTexts(userContext([{ ...message, content: rewritten, providerPayload: synced }]));
		expect(texts).toContain("rewritten");
		expect(texts).not.toContain("original");
	});

	it("keeps item ids and citations while syncing", () => {
		const synced = syncOpenAIResponsesHistoryTexts(fixtureMessage().providerPayload, ["rewritten"]);
		const messageItem = synced?.items.find(item => item.type === "message") as {
			id: unknown;
			content: Array<{ annotations: unknown[] }>;
		};
		expect(messageItem.id).toBe("msg_fixture");
		expect(messageItem.content[0].annotations).toHaveLength(1);
	});

	it("pairs multiple text blocks across message items positionally", () => {
		const payload = createOpenAIResponsesHistoryPayload(model.provider, [
			{ type: "message", id: "msg_a", role: "assistant", content: [{ type: "output_text", text: "one" }] },
			{ type: "reasoning", id: "rs_b", summary: [] },
			{ type: "message", id: "msg_b", role: "assistant", content: [{ type: "output_text", text: "two" }] },
		]);
		const synced = syncOpenAIResponsesHistoryTexts(payload, ["ONE", "TWO"]);
		expect(synced).toBeDefined();
		const texts = synced?.items
			.filter(item => item.type === "message")
			.flatMap(item => (item.content as Array<{ text: string }>).map(part => part.text));
		expect(texts).toEqual(["ONE", "TWO"]);
	});

	it("leaves the payload untouched on shape mismatch instead of half-updating", () => {
		expect(syncOpenAIResponsesHistoryTexts(fixtureMessage().providerPayload, ["a", "b"])).toBeUndefined();
		const nonList = createOpenAIResponsesHistoryPayload(model.provider, [
			{ type: "message", id: "msg_x", role: "assistant", content: "suddenly a string" },
		]);
		expect(syncOpenAIResponsesHistoryTexts(nonList, ["a"])).toBeUndefined();
	});
});
