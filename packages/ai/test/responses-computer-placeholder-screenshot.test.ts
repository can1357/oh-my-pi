// Contract: a computer result whose screenshot is well-formed but unreplayable
// (BMP) degrades to a text placeholder. The serializer must carry that
// placeholder into the demoted pair instead of promising an attachment that no
// longer exists, and must keep the recorded actions instead of letting orphan
// repair rewrite the call as "interrupted before a screenshot was recorded".
import { describe, expect, it } from "bun:test";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const BMP_B64 = Buffer.from("424d1e00000000000000001a0000000c000000010001000100180000000000", "hex").toString("base64");
const BMP_PLACEHOLDER = "[unsupported image: image/bmp]";
const CALL_ID = "call_shot";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	} satisfies ModelSpec<"openai-responses">);
}

function computerCallTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `${CALL_ID}|item_shot`,
				name: "computer",
				arguments: {},
				providerMetadata: {
					type: "computer",
					providerItemId: "item_shot",
					actions: [{ type: "screenshot" }],
					pendingSafetyChecks: [],
				},
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

// The canonical result kept the screenshot as ordinary image content and lost
// its computer metadata, which is what a rewritten or replayed history yields.
function promotedBmpResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${CALL_ID}|item_shot`,
		toolName: "computer",
		content: [{ type: "image", data: BMP_B64, mimeType: "image/bmp" }],
		isError: false,
		timestamp: 2,
	};
}

function contextFor(): Context {
	return {
		messages: [
			{ role: "user", content: "take a screenshot", timestamp: 0 },
			computerCallTurn(),
			promotedBmpResult(),
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("Responses computer result with a placeholder-only screenshot", () => {
	it("preserves the placeholder and demotes the pair without a false attachment note", () => {
		const items = buildResponsesInput({
			model: responsesModel(),
			context: contextFor(),
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
		});
		const serialized = JSON.stringify(items);

		expect(items.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(serialized).toContain(BMP_PLACEHOLDER);
		expect(serialized).not.toContain("(see attached image)");
		expect(serialized).not.toContain("interrupted before a screenshot was recorded");

		const callNoteIndex = items.findIndex(item =>
			JSON.stringify(item).includes(`[Computer call failed before a screenshot was recorded; call_id=${CALL_ID}]`),
		);
		const resultNoteIndex = items.findIndex(item => JSON.stringify(item).includes(BMP_PLACEHOLDER));
		expect(callNoteIndex).toBeGreaterThanOrEqual(0);
		expect(resultNoteIndex).toBe(callNoteIndex + 1);
		expect(JSON.stringify(items[callNoteIndex])).toContain("screenshot");
	});
});
