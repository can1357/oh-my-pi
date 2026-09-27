import { describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

/** The transport may hand the JSON body over as a string or as encoded bytes. */
function parseRequestBody(raw: unknown): Record<string, unknown> {
	if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
	if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
	if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
	return {};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/** Terminal `response.completed` SSE frame; captures the exact request body sent. */
function mockResponsesFetch(): { fetchMock: FetchImpl; captured: Record<string, unknown> } {
	const captured: Record<string, unknown> = {};
	const fetchMock: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		Object.assign(captured, parseRequestBody(init?.body));
		const event = {
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetchMock, captured };
}

/** Built from a spec so `compat.extraBody` travels the real resolve path. */
function responsesModel(extraBody: Record<string, unknown>): Model<"openai-responses"> {
	return buildModel({
		id: "compat-extra-body",
		name: "Compat Extra Body",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: COST,
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: { extraBody },
	} satisfies ModelSpec<"openai-responses">);
}

function azureResponsesModel(extraBody: Record<string, unknown>): Model<"azure-openai-responses"> {
	return buildModel({
		id: "compat-extra-body",
		name: "Compat Extra Body",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
		compat: { extraBody },
	} satisfies ModelSpec<"azure-openai-responses">);
}

function anthropicModel(extraBody: Record<string, unknown>): Model<"anthropic-messages"> {
	return buildModel({
		id: "compat-extra-body",
		name: "Compat Extra Body",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat: { extraBody },
	} satisfies ModelSpec<"anthropic-messages">);
}

async function captureResponsesBody(
	model: Model<"openai-responses">,
	options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const { fetchMock, captured } = mockResponsesFetch();
	const stream = streamOpenAIResponses(model, ctx, { apiKey: "k", fetch: fetchMock, ...options });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

function captureAzurePayload(model: Model<"azure-openai-responses">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, ctx, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as Record<string, unknown>);
			return payload;
		},
	});
	return promise;
}

function captureAnthropicPayload(model: Model<"anthropic-messages">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAnthropic(model, ctx, {
		apiKey: "sk-ant-test",
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as Record<string, unknown>);
			return payload;
		},
	});
	return promise;
}

describe("compat.extraBody reaches the wire (#12087)", () => {
	it("merges compat.extraBody into the Responses request body", async () => {
		const body = await captureResponsesBody(responsesModel({ gateway: "gw-1", controller: "mlx" }));

		expect(body.gateway).toBe("gw-1");
		expect(body.controller).toBe("mlx");
	});

	it("lets a per-call extraBody option override compat.extraBody on key conflicts", async () => {
		const body = await captureResponsesBody(responsesModel({ mark: "compat", keep: 1 }), {
			extraBody: { mark: "call" },
		});

		expect(body.mark).toBe("call");
		expect(body.keep).toBe(1);
	});

	it("merges compat.extraBody into the Azure Responses request body", async () => {
		const payload = await captureAzurePayload(azureResponsesModel({ gateway: "azure-gw" }));

		expect(payload.gateway).toBe("azure-gw");
	});

	it("merges compat.extraBody into the Anthropic /v1/messages params", async () => {
		const payload = await captureAnthropicPayload(anthropicModel({ gateway: "anthropic-gw", route: "eu" }));

		expect(payload.gateway).toBe("anthropic-gw");
		expect(payload.route).toBe("eu");
		// The merge must not disturb the model id the request builder produced.
		expect(payload.model).toBe("compat-extra-body");
	});
});
