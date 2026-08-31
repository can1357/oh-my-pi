import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression: gateway sets Responses continuation fields on SimpleStreamOptions,
 * but mapOptionsForApi previously dropped them before provider buildParams().
 */
describe("mapOptionsForApi Responses field forwarding", () => {
	it("forwards previousResponseId, parallelToolCalls, user, and responseFormat onto the Responses wire", async () => {
		let captured: Record<string, unknown> | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			captured = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const model = buildModel({
			api: "openai-responses",
			name: "gpt-test",
			id: "gpt-test",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const events = streamSimple(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			previousResponseId: "resp_client_123",
			parallelToolCalls: false,
			user: "user-1",
			responseFormat: { type: "json_object" },
			seed: 7,
			logitBias: { "42": -1 },
			statefulResponses: false,
		});
		for await (const _ of events) {
			/* drain */
		}
		expect(captured).toBeDefined();
		expect(captured?.previous_response_id).toBe("resp_client_123");
		expect(captured?.parallel_tool_calls).toBe(false);
		expect(captured?.user).toBe("user-1");
		expect((captured?.text as { format?: unknown } | undefined)?.format).toEqual({ type: "json_object" });
		// Responses API has no seed/logit_bias; mapper may forward options but wire omits them.
		expect("seed" in (captured ?? {})).toBe(false);
		expect("logit_bias" in (captured ?? {})).toBe(false);
	});

	it("does not invent previous_response_id when SimpleStreamOptions omit it (negative)", async () => {
		let captured: Record<string, unknown> | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			captured = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const model = buildModel({
			api: "openai-responses",
			name: "gpt-test",
			id: "gpt-test",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const events = streamSimple(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			statefulResponses: false,
		});
		for await (const _ of events) {
			/* drain */
		}
		expect(captured).toBeDefined();
		expect(captured?.previous_response_id).toBeUndefined();
	});
});
