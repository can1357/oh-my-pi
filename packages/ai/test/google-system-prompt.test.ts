import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

async function captureGooglePayload(
	context: Context,
): Promise<{ config: { systemInstruction?: unknown }; contents: unknown[] }> {
	let captured: { config: { systemInstruction?: unknown }; contents: unknown[] } | undefined;
	const fetchMock: FetchImpl = async () =>
		new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });

	await streamGoogle(model, context, {
		apiKey: "test-key",
		onPayload: payload => {
			captured = payload as { config: { systemInstruction?: unknown }; contents: unknown[] };
		},
		fetch: fetchMock,
	}).result();

	expect(captured).toBeDefined();
	return captured!;
}

describe("Google provider system prompts", () => {
	it("sends every system prompt block as systemInstruction text parts", async () => {
		const payload = await captureGooglePayload({
			systemPrompt: ["primary instruction", "secondary instruction"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});

		expect(payload.config.systemInstruction).toEqual({
			parts: [{ text: "primary instruction" }, { text: "secondary instruction" }],
		});
		expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
	});

	it("does not inject extra user turns before signed model history", async () => {
		const payload = await captureGooglePayload({
			systemPrompt: ["stable instruction", "cacheable instruction"],
			messages: [
				{
					role: "assistant",
					api: "google-generative-ai",
					provider: "google",
					model: model.id,
					content: [{ type: "thinking", thinking: "prior thought", thinkingSignature: "QUJDRA==" }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		expect(payload.contents[0]).toEqual({
			role: "model",
			parts: [{ thought: true, text: "prior thought", thoughtSignature: "QUJDRA==" }],
		});
		expect(payload.contents).toHaveLength(1);
	});

	it("demotes same-model unsigned thinking instead of emitting an unsigned thought part", async () => {
		const payload = await captureGooglePayload({
			messages: [
				{
					role: "assistant",
					api: "google-generative-ai",
					provider: "google",
					model: model.id,
					content: [{ type: "thinking", thinking: "unsigned prior thought" }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		expect(payload.contents[0]).toEqual({
			role: "model",
			parts: [{ text: renderDemotedThinking(model.id, "unsigned prior thought") }],
		});
	});
});
