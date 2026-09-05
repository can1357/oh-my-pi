import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { withEnv } from "./helpers";

// Nebius Token Factory is a pure OpenAI-compatible endpoint. These tests pin
// the routing contract: nebius models must reach the OpenAI chat-completions
// transport at the model's own base URL with plain Bearer auth, so a
// `NEBIUS_BASE_URL` region override steers discovery and inference together.
const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const NEBIUS_REGION_BASE_URL = "https://api.tokenfactory.us-central1.nebius.com/v1";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function nebiusModel(baseUrl: string = NEBIUS_BASE_URL): Model<"openai-completions"> {
	return buildModel({
		id: "zai-org/GLM-5.3-Flash",
		name: "GLM-5.3-Flash",
		api: "openai-completions",
		provider: "nebius",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
	} satisfies ModelSpec<"openai-completions">);
}

async function captureRequest(
	model: Model<"openai-completions">,
): Promise<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> {
	let url = "";
	let headers: Record<string, string> = {};
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (input, init) => {
		url = String(input);
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(
			new Response(
				'data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
	};
	const stream = streamSimple(model, context, { apiKey: "nebius-test-key", fetch: fetchMock });
	await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return { url, headers, body: JSON.parse(requestBody) };
}

describe("Nebius Token Factory routing", () => {
	it("routes nebius models to the OpenAI chat-completions transport at the Token Factory base URL", async () => {
		const request = await captureRequest(nebiusModel());
		expect(request.url).toBe(`${NEBIUS_BASE_URL}/chat/completions`);
		expect(request.body.model).toBe("zai-org/GLM-5.3-Flash");
		expect(request.body.messages).toBeArrayOfSize(1);
	});

	it("honors a region base URL instead of rerouting to the global endpoint", async () => {
		const request = await captureRequest(nebiusModel(NEBIUS_REGION_BASE_URL));
		expect(request.url).toBe(`${NEBIUS_REGION_BASE_URL}/chat/completions`);
	});

	it("authenticates with a plain Bearer token and no custom headers", async () => {
		const request = await captureRequest(nebiusModel());
		expect(request.headers.authorization).toBe("Bearer nebius-test-key");
	});

	it("floors omitted thinking to the lowest supported effort on requiresEffort routes", async () => {
		const k3 = buildModel({
			id: "moonshotai/Kimi-K3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "nebius",
			baseUrl: NEBIUS_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_024_000,
			maxTokens: 131_072,
		} satisfies ModelSpec<"openai-completions">);
		const request = await captureRequest(k3);
		expect(request.body.reasoning_effort).toBe("low");
	});

	it("applies NEBIUS_BASE_URL to bundled rows that keep the global endpoint", async () => {
		await withEnv({ NEBIUS_BASE_URL: NEBIUS_REGION_BASE_URL }, async () => {
			const request = await captureRequest(nebiusModel());
			expect(request.url).toBe(`${NEBIUS_REGION_BASE_URL}/chat/completions`);
		});
	});
	it("honors per-request first-event timeout overrides", async () => {
		const hangingFetch: FetchImpl = () =>
			Promise.resolve(
				new Response(new ReadableStream<Uint8Array>(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
		const stream = streamSimple(nebiusModel(), context, {
			apiKey: "nebius-test-key",
			fetch: hangingFetch,
			streamFirstEventTimeoutMs: 100,
		});
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
	}, 15000);
});
