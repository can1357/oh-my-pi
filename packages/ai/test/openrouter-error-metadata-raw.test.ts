import { describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

/**
 * OpenRouter's own 403 for a request its routing/data policy rejected. The
 * top-level `error.message` is a generic policy sentence; the routed upstream
 * provider's actual explanation, and its name, live in `error.metadata.raw`.
 */
const UPSTREAM_RAW =
	"Anthropic (claude-sonnet-4.5) returned 403: content flagged by the account's data-retention policy. See https://openrouter.ai/activity";

function create403Fetch(body: unknown): FetchImpl {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as FetchImpl;
	return Object.assign(fetchMock, { preconnect: fetch.preconnect });
}

async function runToTerminal(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return stream.finalResultPromise;
}

function buildOpenRouterModel(api: "openrouter" | "openai-responses"): Model<"openrouter"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 via OpenRouter",
		api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
	} as ModelSpec<"openrouter">);
}

describe("OpenRouter error metadata.raw (#10906)", () => {
	it("surfaces the routed upstream's explanation alongside the generic 403 on chat completions", async () => {
		const message = await runToTerminal(
			streamOpenAICompletions(
				buildOpenRouterModel("openrouter") as unknown as Model<"openai-completions">,
				context,
				{
					apiKey: "test-key",
					fetch: create403Fetch({
						error: {
							message: "Access denied by security policy",
							code: 403,
							metadata: { raw: UPSTREAM_RAW, provider_name: "Anthropic" },
						},
					}),
				},
			),
		);

		expect(message.errorStatus).toBe(403);
		// The provider's own headline survives.
		expect(message.errorMessage).toContain("Access denied by security policy");
		// ...and so does the only field naming the routed upstream and the real reason.
		expect(message.errorMessage).toContain(UPSTREAM_RAW);
	});

	it("surfaces the routed upstream's explanation on the responses API too", async () => {
		const message = await runToTerminal(
			streamOpenAIResponses(
				buildOpenRouterModel("openai-responses") as unknown as Model<"openai-responses">,
				context,
				{
					apiKey: "test-key",
					fetch: create403Fetch({
						error: {
							message: "Access denied by security policy",
							code: 403,
							metadata: { raw: UPSTREAM_RAW, provider_name: "Anthropic" },
						},
					}),
				},
			),
		);

		expect(message.errorStatus).toBe(403);
		expect(message.errorMessage).toContain("Access denied by security policy");
		expect(message.errorMessage).toContain(UPSTREAM_RAW);
	});

	it("does not append a bare status line when the 403 carries no upstream detail", async () => {
		const message = await runToTerminal(
			streamOpenAICompletions(
				buildOpenRouterModel("openrouter") as unknown as Model<"openai-completions">,
				context,
				{
					apiKey: "test-key",
					fetch: create403Fetch({
						error: { message: "Access denied by security policy", code: 403 },
					}),
				},
			),
		);

		expect(message.errorMessage).toContain("Access denied by security policy");
		expect(
			message.errorMessage
				?.trim()
				.split("\n")
				.filter(line => line.trim().length > 0),
		).toHaveLength(1);
	});
});
