import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Synthetic so the transport contract is pinned independently of the bundled
 * roster. `baseUrl` is the variable under test: the attribution headers are
 * scoped to the provider's own origin, not merely to its id.
 */
function aimlapiModel(baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "openai/gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "aimlapi",
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}) as Model<"openai-completions">;
}

const context: Context = {
	systemPrompt: ["Be brief."],
	messages: [{ role: "user", content: "Say ok", timestamp: 0 }],
	tools: [],
};

function completionResponse(model: string): Response {
	const events = [
		{ id: "aimlapi-test", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "aimlapi-test", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function captureHeaders(baseUrl: string): Promise<Record<string, string>> {
	const model = aimlapiModel(baseUrl);
	let headers: Record<string, string> = {};
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			return completionResponse(model.id);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock, maxTokens: 64 }).result();
	return headers;
}

describe("AI/ML API OpenAI transport", () => {
	it("sends the client-identity headers on a request to the provider's own origin", async () => {
		const headers = await captureHeaders("https://api.aimlapi.com/v1");

		expect(headers["http-referer"]).toBe("https://github.com/can1357/oh-my-pi");
		expect(headers["x-title"]).toBe("oh-my-pi");
		expect(headers["x-aimlapi-source"]).toBe("agent/oh-my-pi");
		expect(headers["x-aimlapi-partner-id"]).toBe("part_esrFuB5coroCvy4ri4dDqbCX");
	});

	it("sends no client identity when the base URL points somewhere else", async () => {
		// The gateway serves an unattributed request identically, so absence never
		// surfaces at runtime — this assertion is the only thing that catches it.
		for (const baseUrl of ["https://api.openai.com/v1", "https://api.aimlapi.com.example.net/v1", "http://api.aimlapi.com/v1"]) {
			const headers = await captureHeaders(baseUrl);
			expect(headers["x-aimlapi-partner-id"]).toBeUndefined();
			expect(headers["x-aimlapi-source"]).toBeUndefined();
			expect(headers["http-referer"]).toBeUndefined();
		}
	});
});
