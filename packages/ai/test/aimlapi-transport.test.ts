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
	return buildModel<"openai-completions">({
		id: "openai/gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "aimlapi",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

const context: Context = {
	systemPrompt: ["Be brief."],
	messages: [{ role: "user", content: "Say ok", timestamp: 0 }],
	tools: [],
};

function completionResponse(model: string): Response {
	const events = [
		{
			id: "aimlapi-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "aimlapi-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

/**
 * Runs one completion and records every request that reaches the network.
 * `redirects` maps a URL to the `Location` it answers with a 307. Unless the
 * request opts out with `redirect: "manual"`, the mock follows a redirect the
 * way Bun's fetch does: custom headers are kept on a cross-origin hop and only
 * credentials are dropped.
 */
async function captureRequests(
	baseUrl: string,
	options: { headers?: Record<string, string>; redirects?: Record<string, string> } = {},
): Promise<CapturedRequest[]> {
	const model = aimlapiModel(baseUrl);
	const requests: CapturedRequest[] = [];
	const network = (url: string, headers: Headers): Response => {
		requests.push({ url, headers: Object.fromEntries(headers.entries()) });
		const location = options.redirects?.[url];
		return location ? new Response(null, { status: 307, headers: { location } }) : completionResponse(model.id);
	};
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			let url = String(input);
			const headers = new Headers(init?.headers);
			let response = network(url, headers);
			while (init?.redirect !== "manual" && response.status === 307) {
				const next = new URL(response.headers.get("location") ?? "", url);
				if (next.origin !== new URL(url).origin) headers.delete("authorization");
				url = next.href;
				response = network(url, headers);
			}
			return response;
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		maxTokens: 64,
		headers: options.headers,
	}).result();
	return requests;
}

async function captureHeaders(baseUrl: string, headers?: Record<string, string>): Promise<Record<string, string>> {
	const requests = await captureRequests(baseUrl, { headers });
	expect(requests).toHaveLength(1);
	return requests[0]!.headers;
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
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"https://api.aimlapi.com.example.net/v1",
			"http://api.aimlapi.com/v1",
		]) {
			const headers = await captureHeaders(baseUrl);
			expect(headers["x-aimlapi-partner-id"]).toBeUndefined();
			expect(headers["x-aimlapi-source"]).toBeUndefined();
			expect(headers["http-referer"]).toBeUndefined();
		}
	});

	it("lets a caller header replace a default spelled in another case", async () => {
		// A case-sensitive merge sent both values, which `Headers` joins into
		// `part_esr…, part_caller`: neither the caller's id nor a valid one.
		const headers = await captureHeaders("https://api.aimlapi.com/v1", { "x-aimlapi-partner-id": "part_caller" });

		expect(headers["x-aimlapi-partner-id"]).toBe("part_caller");
		expect(headers["x-aimlapi-source"]).toBe("agent/oh-my-pi");
	});

	it("drops the client identity when the gateway redirects to another origin", async () => {
		const requests = await captureRequests("https://api.aimlapi.com/v1", {
			redirects: { "https://api.aimlapi.com/v1/chat/completions": "http://mirror.example.net/v1/chat/completions" },
		});

		expect(requests.map(request => request.url)).toEqual([
			"https://api.aimlapi.com/v1/chat/completions",
			"http://mirror.example.net/v1/chat/completions",
		]);
		expect(requests[0]!.headers["x-aimlapi-partner-id"]).toBe("part_esrFuB5coroCvy4ri4dDqbCX");
		const redirected = requests[1]!.headers;
		expect(redirected["x-aimlapi-partner-id"]).toBeUndefined();
		expect(redirected["x-aimlapi-source"]).toBeUndefined();
		expect(redirected["x-title"]).toBeUndefined();
		expect(redirected["http-referer"]).toBeUndefined();
		expect(redirected.authorization).toBeUndefined();
	});
});
