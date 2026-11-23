import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("issue #19729 - in-band throttle frames keep their one replay", () => {
	it("replays a 429 error frame sent inside an HTTP 200 stream once", async () => {
		let postCount = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				postCount += 1;
				// The transport saw HTTP 200, so it never retried this frame; only the outer replay can.
				const frame = { error: { code: 429, message: "rate limited", type: "rate_limit_error" } };
				return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
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
			// one attempt plus the single outer replay
			expect(postCount).toBe(2);
		} finally {
			server.stop(true);
		}
	}, 60000);
});
