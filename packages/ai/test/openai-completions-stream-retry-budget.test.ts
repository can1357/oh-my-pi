import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

/** Streams one request against a stub that answers every POST with `respond`; returns how many POSTs it took. */
async function countPosts(respond: () => Response): Promise<number> {
	let posts = 0;
	using server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			posts += 1;
			return respond();
		},
	});
	const model: Model<"openai-completions"> = {
		...getBundledModel("deepseek", "deepseek-v4-flash"),
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
	const result = await streamSimple(model, context, {
		apiKey: "dummy",
		reasoning: Effort.High,
		providerRetryWait: async () => {},
	}).result();
	expect(result.stopReason).toBe("error");
	return posts;
}

describe("issue #19729 - stream replay vs transport retries", () => {
	it("does not replay an HTTP 500 the transport already retried", async () => {
		// retry-after 0 keeps the transport's backoff sleeps out of the test.
		const posts = await countPosts(
			() =>
				new Response('{"error":{"code":500,"message":"boom","type":"server_error"}}', {
					status: 500,
					headers: { "content-type": "application/json", "retry-after": "0" },
				}),
		);
		// The transport's own budget only, not doubled by the outer replay.
		expect(posts).toBe(6);
	}, 30_000);

	it("still replays an error frame inside an HTTP 200 stream once", async () => {
		// The transport saw HTTP 200, so only the outer replay can retry this frame.
		const frame = { error: { code: 429, message: "rate limited", type: "rate_limit_error" } };
		const posts = await countPosts(
			() =>
				new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect(posts).toBe(2);
	}, 30_000);
});
