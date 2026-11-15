import { describe, expect, it, spyOn } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import * as providerRegistry from "@oh-my-pi/pi-ai/registry/registry";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ResponsesWebSocketConnection } from "../src/providers/responses-websocket-connection";

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("StreamOptions.fetch override", () => {
	it("uses a provider default through stream and streamSimple while explicit fetch overrides win", async () => {
		const model = buildModel({
			id: "gemini-2.5-flash",
			name: "Gemini",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://provider-fetch.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 1024,
		});
		const selected: string[] = [];
		const responder =
			(name: string): FetchImpl =>
			async () => {
				selected.push(name);
				return createSseResponse([
					{
						response: {
							candidates: [{ content: { role: "model", parts: [{ text: name }] }, finishReason: "STOP" }],
						},
					},
				]);
			};
		const defaultFetch = responder("provider-default");
		const override = responder("explicit-override");
		const lookup = providerRegistry.getProviderDefinition;
		const original = lookup(model.provider);
		if (!original) throw new Error("Gemini CLI provider is not registered");
		const definition = { ...original, fetch: defaultFetch };
		const lookupSpy = spyOn(providerRegistry, "getProviderDefinition").mockImplementation(id =>
			id === model.provider ? definition : lookup(id),
		);
		try {
			const apiKey = JSON.stringify({ token: "fixture-only", projectId: "fixture-project" });
			for (const send of [stream<"google-gemini-cli">, streamSimple<"google-gemini-cli">]) {
				const fromDefault = await send(model, baseContext(), { apiKey }).result();
				const fromOverride = await send(model, baseContext(), { apiKey, fetch: override }).result();
				expect(fromDefault.content).toEqual([{ type: "text", text: "provider-default" }]);
				expect(fromOverride.content).toEqual([{ type: "text", text: "explicit-override" }]);
			}
			expect(selected).toEqual(["provider-default", "explicit-override", "provider-default", "explicit-override"]);
		} finally {
			lookupSpy.mockRestore();
		}
	});

	it("routes openai-completions requests through the override", async () => {
		const calls: Array<{ url: string }> = [];

		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: { content: "hi" } }],
					},
					{
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
					"[DONE]",
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: customFetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]?.url).toContain("/chat/completions");
	});

	it("routes openai-responses requests through the override", async () => {
		const calls: Array<{ url: string }> = [];

		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{ type: "response.created", response: { id: "resp_test" } },
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "hi" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_test",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "hi" }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const connect = spyOn(ResponsesWebSocketConnection.prototype, "connect").mockImplementation(() => {
			throw new Error("A custom fetch without WS opt-in must not open a socket");
		});
		try {
			const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				fetch: customFetch,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "hi" }));
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toContain("/responses");
			expect(connect).not.toHaveBeenCalled();
		} finally {
			connect.mockRestore();
		}
	});
});
