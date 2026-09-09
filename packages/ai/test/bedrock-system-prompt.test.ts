import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface Payload {
	system?: Array<{ text: string } | { cachePoint: unknown }>;
}

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

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

// Capture the request payload the provider would send, without a network call:
// an already-aborted signal short-circuits after `onPayload` fires.
async function capturePayload(systemPrompt: Context["systemPrompt"]): Promise<Payload> {
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
	const { promise, resolve } = Promise.withResolvers<Payload | undefined>();
	const stream = streamBedrock(model(), context, {
		bearerToken: "test-token",
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as Payload);
		},
	});
	// Drain the stream so the request-building path (and thus onPayload) runs.
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events; we only care about the captured payload
			}
		} finally {
			resolve(undefined);
		}
	})();
	const payload = await promise;
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

function textBlocks(payload: Payload): string[] {
	return (payload.system ?? []).filter((block): block is { text: string } => "text" in block).map(block => block.text);
}

describe("Bedrock system prompt normalization", () => {
	// Regression for #7037: legacy pi extensions remapped onto the fork pass
	// Context.systemPrompt as a bare string, which crashed buildSystemPrompt's
	// unguarded `.map()`. It must normalize to a single-element system block.
	test("accepts a bare-string systemPrompt", async () => {
		const payload = await capturePayload("You are a test." as unknown as string[]);
		expect(textBlocks(payload)).toEqual(["You are a test."]);
	});

	test("string and single-element array produce identical system blocks", async () => {
		const fromString = await capturePayload("You are a test." as unknown as string[]);
		const fromArray = await capturePayload(["You are a test."]);
		expect(textBlocks(fromString)).toEqual(textBlocks(fromArray));
	});
});
