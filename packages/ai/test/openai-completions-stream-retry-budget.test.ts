import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("issue #19729 - nested retry layers multiply HTTP 500 retries", () => {
	let server: ReturnType<typeof Bun.serve>;
	let postCount: number;

	beforeEach(() => {
		postCount = 0;
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				postCount += 1;
				const body = (await request.json()) as { reasoning_effort?: string };
				if (body.reasoning_effort === "high") {
					// retry-after 0 keeps the transport's backoff sleeps out of the test.
					return new Response(
						'{"error":{"code":500,"message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.","type":"server_error"}}',
						{
							status: 500,
							headers: { "content-type": "application/json", "retry-after": "0" },
						},
					);
				}
				const chunks = [
					{
						id: "chatcmpl-19729",
						object: "chat.completion.chunk",
						created: 0,
						model: "deepseek-v4-flash",
						choices: [{ index: 0, delta: { content: "hello" } }],
					},
					{
						id: "chatcmpl-19729",
						object: "chat.completion.chunk",
						created: 0,
						model: "deepseek-v4-flash",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
				];
				const payload = [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].join("\n\n");
				return new Response(`${payload}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
	});

	afterEach(() => {
		server.stop(true);
	});

	it("sends one stream's HTTP 500 retries once, not twice", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("deepseek", "deepseek-v4-flash"),
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		};

		const stream = streamSimple(model, context, {
			apiKey: "dummy",
			reasoning: Effort.High,
			providerRetryWait: async () => {},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		// the transport owns the HTTP retry budget for one stream, so an outer replay must not multiply it.
		expect(postCount).toBe(6);
	}, 30000);
});
