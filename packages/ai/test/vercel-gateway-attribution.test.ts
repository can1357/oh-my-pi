import { describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Api, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

function vercelModel<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api,
		provider: "vercel-ai-gateway",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	} satisfies ModelSpec<TApi>);
}

/** Headers of the first request the provider sends; the stubbed 400 ends the turn. */
async function firstRequestHeaders(model: Model<Api>, headers?: Record<string, string>): Promise<Headers> {
	let captured: Headers | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured ??= new Headers(init?.headers);
		return new Response(JSON.stringify({ error: { message: "stop", type: "invalid_request_error" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	});
	for await (const event of streamSimple(model, context, { apiKey: "test-key", headers, fetch: fetchMock })) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!captured) throw new Error("Expected a captured Vercel AI Gateway request");
	return captured;
}

describe("Vercel AI Gateway app attribution", () => {
	it("credits omp on the Anthropic and OpenAI-compatible routes", async () => {
		for (const model of [
			vercelModel("anthropic-messages", "https://ai-gateway.vercel.sh"),
			vercelModel("openai-completions", "https://ai-gateway.vercel.sh/v1"),
		]) {
			const headers = await firstRequestHeaders(model);
			expect([model.api, headers.get("http-referer"), headers.get("x-title")]).toEqual([
				model.api,
				"https://omp.sh/",
				"omp",
			]);
		}
	});

	it("keeps caller-supplied attribution", async () => {
		const headers = await firstRequestHeaders(vercelModel("anthropic-messages", "https://ai-gateway.vercel.sh"), {
			"HTTP-Referer": "https://myapp.vercel.app",
			"X-Title": "MyApp",
		});
		expect(headers.get("http-referer")).toBe("https://myapp.vercel.app");
		expect(headers.get("x-title")).toBe("MyApp");
	});
});
