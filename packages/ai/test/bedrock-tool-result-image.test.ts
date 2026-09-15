import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function model(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

function assistant(target: Model<"bedrock-converse-stream">): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "/tmp/t8.png" } }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: target.id,
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
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_read",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: PNG_DATA, mimeType: "image/png" },
		],
		isError: false,
		timestamp: 2,
	};
}

function objectValue(value: unknown, label: string): object {
	if (typeof value !== "object" || value === null) throw new Error(`Expected ${label} to be an object`);
	return value;
}

function arrayField(value: object, key: string): unknown[] {
	const field: unknown = Reflect.get(value, key);
	if (!Array.isArray(field)) throw new Error(`Expected ${key} to be an array`);
	return field;
}

async function capturePayload(target: Model<"bedrock-converse-stream">): Promise<object> {
	const context: Context = {
		messages: [{ role: "user", content: "Read the image.", timestamp: 0 }, assistant(target), toolResult()],
	};
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<object>();
	void streamBedrock(target, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		onPayload: payload => resolve(objectValue(payload, "payload")),
	});
	return promise;
}

function finalUserContent(payload: object): unknown[] {
	const messages = arrayField(payload, "messages");
	const finalMessage = objectValue(messages.at(-1), "final message");
	return arrayField(finalMessage, "content");
}

describe("Bedrock tool-result image placement", () => {
	it("hoists OpenAI tool-result images into sibling user blocks", async () => {
		const target = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "global.openai.gpt-5.6-sol");
		const content = finalUserContent(await capturePayload(target));
		const toolResultBlock = objectValue(content[0], "tool result block");
		const nestedContent = arrayField(
			objectValue(Reflect.get(toolResultBlock, "toolResult"), "tool result"),
			"content",
		);
		const siblingBlock = objectValue(
			content.find(block => Reflect.has(objectValue(block, "user block"), "image")),
			"sibling image block",
		);
		const image = objectValue(Reflect.get(siblingBlock, "image"), "image");
		const source = objectValue(Reflect.get(image, "source"), "image source");

		expect(nestedContent.some(block => Reflect.has(objectValue(block, "nested block"), "image"))).toBe(false);
		expect(
			nestedContent.some(
				block => Reflect.get(objectValue(block, "nested block"), "text") === "Read image file [image/png]",
			),
		).toBe(true);
		expect(content.indexOf(siblingBlock)).toBeGreaterThan(0);
		expect(Reflect.get(source, "bytes")).toBe(PNG_DATA);
	});

	it("keeps Claude tool-result images nested", async () => {
		const content = finalUserContent(await capturePayload(model("global.anthropic.claude-opus-5")));
		const toolResultBlock = objectValue(content[0], "tool result block");
		const nestedContent = arrayField(
			objectValue(Reflect.get(toolResultBlock, "toolResult"), "tool result"),
			"content",
		);

		expect(nestedContent.some(block => Reflect.has(objectValue(block, "nested block"), "image"))).toBe(true);
		expect(content.slice(1).some(block => Reflect.has(objectValue(block, "user block"), "image"))).toBe(false);
	});

	it("hoists images for opaque OpenAI inference-profile ARNs classified as unknown", async () => {
		const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/company-gpt-sol";
		const target = model(arn);
		expect(target.identity.class).toBe("unknown");
		const content = finalUserContent(await capturePayload(target));
		const toolResultBlock = objectValue(content[0], "tool result block");
		const nestedContent = arrayField(
			objectValue(Reflect.get(toolResultBlock, "toolResult"), "tool result"),
			"content",
		);

		expect(nestedContent.some(block => Reflect.has(objectValue(block, "nested block"), "image"))).toBe(false);
		expect(content.slice(1).some(block => Reflect.has(objectValue(block, "user block"), "image"))).toBe(true);
	});
});
