// Regression: amazon-bedrock ignored the onPayload replacement return value
// (fire-and-forget), so the hook could never change the body actually sent
// upstream. The replacement contract matches anthropic / openai-responses /
// google: await the hook and use its non-undefined return as the request body.
import { describe, expect, it, vi } from "bun:test";
import { type BedrockOptions, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

// Capture the serialized body the provider sends. The response is an empty
// event stream: the fetch (and thus the body capture) happens before any
// response parsing, and the stream's outcome is irrelevant to the assertion.
async function captureSentBody(
	onPayload: (payload: unknown) => unknown | Promise<unknown>,
	target: Model<"bedrock-converse-stream"> = model(),
	options: Partial<BedrockOptions> = {},
): Promise<Record<string, any>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, any>>();
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body;
		const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
		resolve(JSON.parse(text));
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
		);
	}) as unknown as typeof fetch;

	const stream = streamBedrock(target, context, {
		...options,
		bearerToken: "test-token",
		fetch: fetchMock,
		onPayload,
	});
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events
			}
		} catch {
			// empty event stream: stream errors are expected and irrelevant
		}
	})();

	return promise;
}

describe("bedrock onPayload replacement", () => {
	it("sends an async onPayload replacement body", async () => {
		const body = await captureSentBody(async payload => ({
			...(payload as Record<string, unknown>),
			messages: [{ role: "user", content: [{ text: "replacement" }] }],
		}));

		expect(body.messages).toEqual([{ role: "user", content: [{ text: "replacement" }] }]);
		expect(JSON.stringify(body.messages)).not.toContain("hi");
	}, 10_000);

	it("keeps the original body when onPayload returns undefined", async () => {
		const body = await captureSentBody(async () => undefined);

		expect(body.messages[0].content[0].text).toBe("hi");
	}, 10_000);

	it("sends Fable 5.1 thinking-binding controls through additional fields", async () => {
		const target = buildModel({
			id: "us.anthropic.claude-fable-5-1-v1:0",
			name: "Claude Fable 5.1",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
		const body = await captureSentBody(async () => undefined, target, { reasoning: Effort.High });

		expect(body.additionalModelRequestFields.thinking.block_binding).toEqual({
			prefix_mismatch_behavior: "drop_block",
		});
		expect(body.additionalModelRequestFields.anthropic_beta).toContain("thinking-binding-controls-2026-08-01");
		expect(body.additionalModelResponseFieldPaths).toEqual(["/input_transformations"]);
	}, 10_000);
});
