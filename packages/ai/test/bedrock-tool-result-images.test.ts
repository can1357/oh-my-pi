import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Bedrock Converse rejects an image nested in `toolResult.content` for the
// OpenAI models:
//
//   Bedrock HTTP 400: "This model doesn't support the image field for user
//   messages."
//
// The text names user messages because convertMessages() collects tool results
// into one, so it describes the envelope rather than the offending block. The
// models accept image input fine — the same bytes pass in a plain user block,
// and pass nested in a tool result when the same model is reached over an
// OpenAI-compatible transport. Only the nesting is unsupported here.
//
// Compaction renders large tool output as PNG frames into exactly that
// position, so every subagent whose own output was big enough to compact died
// on the first replay. Those images are now hoisted into the enclosing user
// message, which the same models accept.

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";

// Built from real ids so the whole chain is under test: the KDL rule, the
// compiled rule index, `buildModel`'s cascade, and the wire transform. Nothing
// here sets the flag by hand — an id whose class the rule misses would fail
// these cases rather than quietly keep the old behaviour.
function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		input: ["text", "image"],
		cost: { input: 1, output: 1 },
		contextWindow: 200000,
		maxTokens: 4096,
	} as never) as Model<"bedrock-converse-stream">;
}

const OPENAI = "global.openai.gpt-5.6-sol";
const ANTHROPIC = "global.anthropic.claude-opus-5";

function contextWithImageResults(count: number): Context {
	const messages: Context["messages"] = [
		{ role: "user", content: "Screenshot the page", timestamp: 0 },
		{
			role: "assistant",
			content: Array.from({ length: count }, (_, n) => ({
				type: "toolCall" as const,
				id: `tu_${n}`,
				name: "shot",
				arguments: {},
			})),
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			model: OPENAI,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	];
	for (let n = 0; n < count; n++) {
		messages.push({
			role: "toolResult",
			toolCallId: `tu_${n}`,
			toolName: "shot",
			content: [
				{ type: "text", text: `frame ${n}` },
				{ type: "image", data: PNG, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2 + n,
		});
	}
	return { messages };
}

type WireMessage = { role: string; content: Array<Record<string, unknown>> };

async function capturePayload(model: Model<"bedrock-converse-stream">, context: Context): Promise<WireMessage[]> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();
	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		maxTokens: 16,
		onPayload: payload => resolve(payload),
	});
	return ((await promise) as { messages: WireMessage[] }).messages;
}

describe("Bedrock tool-result images", () => {
	test("hoists a nested image into the enclosing user message", async () => {
		const messages = await capturePayload(bedrockModel(OPENAI), contextWithImageResults(1));
		const userMessage = messages[messages.length - 1];
		expect(userMessage.role).toBe("user");

		// The tool result keeps its own text and no longer carries the image...
		const toolResult = userMessage.content[0].toolResult as { content: Array<Record<string, unknown>> };
		expect(toolResult.content).toEqual([{ text: "frame 0" }]);

		// ...and the image follows the run behind the marker the Anthropic,
		// openai-completions and codex encoders already use for this.
		expect(userMessage.content[1]).toMatchObject({ text: "Attached image(s) from the tool result(s) above:" });
		expect(userMessage.content[2]).toMatchObject({ image: { format: "png", source: { bytes: PNG } } });
	});

	test("leaves the image nested when the model accepts it there", async () => {
		// Measured: claude-opus-5 accepts the nested form on this same API, so the
		// rule must not reach it. Hoisting every Bedrock model would rewrite a
		// request that already works.
		const messages = await capturePayload(bedrockModel(ANTHROPIC), contextWithImageResults(1));
		const userMessage = messages[messages.length - 1];
		const toolResult = userMessage.content[0].toolResult as { content: Array<Record<string, unknown>> };
		expect(toolResult.content[1]).toMatchObject({ image: { format: "png", source: { bytes: PNG } } });
		// Nothing was hoisted: no image rides at the top level of the message.
		// (Claude also gets a trailing cachePoint block here, which is unrelated.)
		expect(userMessage.content.some(block => "image" in block)).toBe(false);
	});

	test("keeps every tool result ahead of the marker and the hoisted images", async () => {
		// Bedrock requires the tool results to lead the message, so ordering is a
		// wire constraint and not a preference. Verified against live Converse:
		// two results plus two sibling images in one user message is accepted by
		// sol, luna and claude.
		const messages = await capturePayload(bedrockModel(OPENAI), contextWithImageResults(2));
		const userMessage = messages[messages.length - 1];
		expect(userMessage.content.map(block => Object.keys(block)[0])).toEqual([
			"toolResult",
			"toolResult",
			"text",
			"image",
			"image",
		]);
		// One marker for the run, not one per result.
		expect(userMessage.content.filter(block => "text" in block)).toHaveLength(1);
	});

	test("never leaves an image-only tool result with empty content", async () => {
		// Converse rejects an empty tool-result content array outright:
		// "Invalid 'input': value did not match any expected variant". Hoisting the
		// only block out would produce exactly that, so a note takes its place.
		const context = contextWithImageResults(1);
		const source = context.messages[2] as { content: Array<{ type: string }> };
		source.content = [{ type: "image", data: PNG, mimeType: "image/png" } as never];
		const messages = await capturePayload(bedrockModel(OPENAI), context);
		const userMessage = messages[messages.length - 1];
		const wire = userMessage.content[0].toolResult as { content: Array<Record<string, unknown>> };
		expect(wire.content).toEqual([{ text: "[image hoisted below]" }]);
		expect(userMessage.content[2]).toMatchObject({ image: { format: "png", source: { bytes: PNG } } });
	});

	test("does not disturb a text-only tool result", async () => {
		const context = contextWithImageResults(1);
		const toolResult = context.messages[2] as { content: Array<{ type: string }> };
		toolResult.content = [{ type: "text", text: "no image here" } as never];
		const messages = await capturePayload(bedrockModel(OPENAI), context);
		const userMessage = messages[messages.length - 1];
		expect(userMessage.content).toHaveLength(1);
		const wire = userMessage.content[0].toolResult as { content: Array<Record<string, unknown>> };
		expect(wire.content).toEqual([{ text: "no image here" }]);
	});
});
