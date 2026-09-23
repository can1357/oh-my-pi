import { describe, expect, it } from "bun:test";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import { type Context, Effort, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai",
	provider: "test",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("WHEN streamProxy serializes provider thinking controls", () => {
	it("SHOULD forward each control to the proxy request", async () => {
		for (const controls of [{ anthropicThinkingMode: "adaptive" as const }, { forceReasoningOff: true }]) {
			let requestBody: string | undefined;
			const fetchMock: FetchImpl = (_input, init) => {
				requestBody = typeof init?.body === "string" ? init.body : undefined;
				const event = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`;
				return Promise.resolve(new Response(event, { status: 200 }));
			};

			await streamProxy(model, context, {
				proxyUrl: "http://localhost:0",
				authToken: "test",
				fetch: fetchMock,
				reasoning: Effort.High,
				...controls,
			}).result();

			if (!requestBody) throw new Error("Proxy request body was not captured");
			const payload = JSON.parse(requestBody) as {
				options?: { anthropicThinkingMode?: string; forceReasoningOff?: boolean };
			};
			expect(payload.options).toMatchObject(controls);
		}
	});
});
