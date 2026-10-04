/**
 * Bedrock Converse accepts at most 20 images per `Message`
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html).
 * A snapcompact archive travels as one user message and a run of tool results
 * is serialized into one user message, so the outgoing clamp must hold each of
 * those to 20 images — checked here on the request body Bedrock would receive.
 */
import { describe, expect, it } from "bun:test";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, ImageContent, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import * as snapcompact from "@oh-my-pi/snapcompact";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function bedrockModel(provider = "amazon-bedrock"): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-opus-4-6-v1",
		name: "Claude Opus on Bedrock",
		api: "bedrock-converse-stream",
		provider,
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	});
}

function images(count: number): ImageContent[] {
	return Array.from({ length: count }, () => ({ type: "image", data: PNG_DATA, mimeType: "image/png" }));
}

function toolCalls(model: Model, ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `/tmp/${id}.png` } })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(id: string, count: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `Read ${count} images` }, ...images(count)],
		isError: false,
		timestamp: 3,
	};
}

/** Archive of `frames` frames as the rebuilt context sends it, then a tool round with `perResult` images per result. */
function sessionContext(model: Model, frames: number, perResult: number): Context {
	const archive = createCompactionSummaryMessage("archived history", 900_000, new Date(0).toISOString(), {
		blocks: [{ type: "text", text: "HEAD" }, ...images(frames), { type: "text", text: "TAIL" }],
	});
	return {
		messages: [
			...defaultConvertToLlm([archive]),
			{ role: "user", content: "Look at both screenshots.", timestamp: 1 },
			toolCalls(model, ["a", "b"]),
			toolResult("a", perResult),
			toolResult("b", perResult),
		],
	};
}

async function capturePayload(model: Model<"bedrock-converse-stream">, context: Context): Promise<object> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<object>();
	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		onPayload: payload => {
			if (typeof payload === "object" && payload !== null) resolve(payload);
		},
	});
	return promise;
}

/** Image blocks in a wire content array, counting images nested in toolResult blocks. */
function countWireImages(blocks: unknown): number {
	if (!Array.isArray(blocks)) return 0;
	let count = 0;
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		if ("image" in block) count++;
		if ("toolResult" in block && typeof block.toolResult === "object" && block.toolResult !== null) {
			if ("content" in block.toolResult) count += countWireImages(block.toolResult.content);
		}
	}
	return count;
}

/** Image blocks per wire message of a captured Converse request. */
function imagesPerMessage(payload: object): number[] {
	const messages: unknown = Reflect.get(payload, "messages");
	if (!Array.isArray(messages)) throw new Error("Expected payload messages");
	return messages.map(message =>
		typeof message === "object" && message !== null && "content" in message ? countWireImages(message.content) : 0,
	);
}

describe("Bedrock per-message image limit", () => {
	it("caps a snapcompact archive on Bedrock at 20 frames", () => {
		expect(snapcompact.providerFrameBudget("amazon-bedrock")).toBe(20);
		// The request budget stays as it was: the limit is per message.
		expect(snapcompact.providerImageBudget("amazon-bedrock")).toBe(90);
	});

	it("sends no Bedrock message with more than 20 images", async () => {
		const model = bedrockModel();
		const context = sessionContext(model, 30, 12);

		// Without the clamp the serializer emits the 30-frame archive and the
		// 24-image tool round as single messages, which Converse rejects.
		expect(imagesPerMessage(await capturePayload(model, context))).toEqual([30, 0, 0, 24]);

		const clamped = clampProviderContextImages(context, model);
		expect(imagesPerMessage(await capturePayload(model, clamped))).toEqual([20, 0, 0, 20]);

		// The oldest frames go first: the archive keeps its newest frames and both edges' text.
		const archive = clamped.messages[0];
		const content = Array.isArray(archive.content) ? archive.content : [];
		expect(content.filter(block => block.type === "image")).toHaveLength(20);
		const texts = content.flatMap(block => (block.type === "text" ? [block.text] : []));
		expect(texts).toEqual(expect.arrayContaining(["HEAD", "TAIL"]));
		// The tool round dropped its oldest images and keeps every result.
		expect(clamped.messages.slice(3).map(message => message.role)).toEqual(["toolResult", "toolResult"]);
	});

	it("leaves providers without a per-message limit to their request budget", () => {
		const model = bedrockModel("anthropic");
		const context = sessionContext(model, 30, 12);
		expect(clampProviderContextImages(context, model)).toBe(context);
	});
});
