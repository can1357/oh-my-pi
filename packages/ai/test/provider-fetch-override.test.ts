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
	it("authenticates through the provider transport while explicit overrides take precedence", async () => {
		let requiredTransport = "provider";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.headers.get("x-required-transport") !== requiredTransport) {
					return Response.json({ error: { message: "Required transport was bypassed" } }, { status: 403 });
				}
				const body = (await request.json()) as { request: { contents: { parts: { text?: string }[] }[] } };
				const input = body.request.contents
					.flatMap(content => content.parts)
					.map(part => part.text ?? "")
					.join("");
				return createSseResponse([
					{
						response: {
							candidates: [
								{ content: { role: "model", parts: [{ text: input.toUpperCase() }] }, finishReason: "STOP" },
							],
						},
					},
				]);
			},
		});
		const model = buildModel({
			id: "gemini-2.5-flash",
			name: "Local transport fixture",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: server.url.origin,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		});
		const authenticatedFetch =
			(transport: string): FetchImpl =>
			async (input, init) => {
				const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
				request.headers.set("x-required-transport", transport);
				return fetch(request);
			};
		const lookup = providerRegistry.getProviderDefinition;
		const original = lookup(model.provider);
		if (!original) throw new Error("Gemini CLI provider is not registered");
		const definition = { ...original, fetch: authenticatedFetch("provider") };
		const lookupSpy = spyOn(providerRegistry, "getProviderDefinition").mockImplementation(id =>
			id === model.provider ? definition : lookup(id),
		);
		try {
			const apiKey = JSON.stringify({ token: "fixture-only", projectId: "fixture-project" });
			for (const send of [stream<"google-gemini-cli">, streamSimple<"google-gemini-cli">]) {
				requiredTransport = "provider";
				const normal = await send(model, baseContext(), { apiKey }).result();
				expect(normal.stopReason).toBe("stop");
				expect(normal.content).toEqual([{ type: "text", text: "SAY HELLO" }]);
				requiredTransport = "explicit";
				const overridden = await send(model, baseContext(), {
					apiKey,
					fetch: authenticatedFetch("explicit"),
				}).result();
				expect(overridden.stopReason).toBe("stop");
				expect(overridden.content).toEqual([{ type: "text", text: "SAY HELLO" }]);
			}
		} finally {
			lookupSpy.mockRestore();
			server.stop(true);
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
