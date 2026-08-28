import { describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

const openAI56ResponsesModel = getBundledModel<"openai-responses">("openai", "gpt-5.6");
if (!openAI56ResponsesModel) throw new Error("Expected bundled OpenAI GPT-5.6 model");
if (openAI56ResponsesModel.api !== "openai-responses") {
	throw new Error(`Expected OpenAI Responses model, received ${openAI56ResponsesModel.api}`);
}
const {
	compat: _responsesCompat,
	remoteCompaction: _responsesRemoteCompaction,
	...openAI56CompletionsSpec
} = openAI56ResponsesModel;
const openAI56CompletionsModel: Model<"openai-completions"> = {
	...openAI56CompletionsSpec,
	api: "openai-completions",
	compat: buildOpenAICompat({
		...openAI56CompletionsSpec,
		api: "openai-completions",
	}),
};

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function chatCompletionsSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "chatcmpl-affinity",
			object: "chat.completion.chunk",
			created: 0,
			model: openAI56CompletionsModel.id,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});

	return new Response(
		`data: ${chunk({ role: "assistant", content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureRequest(
	options: OpenAICompletionsOptions,
	requestModel: Model<"openai-completions"> = openAI56CompletionsModel,
	requestContext: Context = context,
): Promise<{ headers: Headers; body: Record<string, unknown> }> {
	let requestHeaders: Headers | undefined;
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		requestHeaders = request.headers;
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		return chatCompletionsSse();
	};

	await streamOpenAICompletions(requestModel, requestContext, {
		apiKey: "test-key",
		...options,
		fetch: fetchMock,
	}).result();

	if (!requestHeaders || !body) throw new Error("Expected a serialized Chat Completions request");
	return { headers: requestHeaders, body };
}

async function captureSimpleRequest(
	options: SimpleStreamOptions,
	requestModel: Model<"openai-completions"> = openAI56CompletionsModel,
	requestContext: Context = context,
): Promise<{ headers: Headers; body: Record<string, unknown> }> {
	let requestHeaders: Headers | undefined;
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		requestHeaders = request.headers;
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		return chatCompletionsSse();
	};

	await streamSimple(requestModel, requestContext, { apiKey: "test-key", ...options, fetch: fetchMock }).result();

	if (!requestHeaders || !body) throw new Error("Expected a serialized Chat Completions request");
	return { headers: requestHeaders, body };
}

describe("OpenAI Chat Completions explicit prompt cache policy", () => {
	const historicalContext: Context = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "stable history" }], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "current prompt" }], timestamp: 1 },
		],
	};

	it("leaves the wire shape unchanged when the policy is unset", async () => {
		const { body } = await captureRequest({ sessionId: "cache-key" }, openAI56CompletionsModel, historicalContext);

		expect(body).not.toHaveProperty("prompt_cache_options");
		expect(body).not.toHaveProperty("prompt_cache_key");
	});

	it("routes explicit policy through streamSimple and marks existing text-only history", async () => {
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-5.6",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
		};
		const textOnlyHistory: Context = {
			messages: [
				{ role: "user", content: "stable history", timestamp: 0 },
				previousAssistant,
				{ role: "user", content: "current prompt", timestamp: 2 },
			],
		};
		const { body } = await captureSimpleRequest(
			{ sessionId: "cache-key", promptCache: { mode: "explicit" } },
			openAI56CompletionsModel,
			textOnlyHistory,
		);

		expect(body.prompt_cache_key).toBe("cache-key");
		expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		const messages = body.messages;
		if (!Array.isArray(messages)) throw new Error("Expected Chat Completions messages");
		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({
			content: [{ type: "text", text: "stable history", prompt_cache_breakpoint: { mode: "explicit" } }],
		});
		expect(messages[1]).toMatchObject({ content: "previous answer" });
		expect(messages[2]).toMatchObject({ content: "current prompt" });
	});

	it("leaves boundary selection automatic in implicit mode", async () => {
		const { body } = await captureRequest(
			{ sessionId: "cache-key", promptCache: { mode: "implicit" } },
			openAI56CompletionsModel,
			historicalContext,
		);

		expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(JSON.stringify(body.messages)).not.toContain("prompt_cache_breakpoint");
	});

	it("does not synthesize first-turn content or a caller-disabled breakpoint", async () => {
		const firstTurn: Context = {
			messages: [{ role: "user", content: "only prompt", timestamp: 0 }],
		};
		const first = await captureRequest({ promptCache: { mode: "explicit" } }, openAI56CompletionsModel, firstTurn);
		const none = await captureRequest(
			{ promptCache: { mode: "explicit", breakpoint: "none" } },
			openAI56CompletionsModel,
			historicalContext,
		);

		for (const body of [first.body, none.body]) {
			const messages = body.messages;
			if (!Array.isArray(messages)) throw new Error("Expected Chat Completions messages");
			for (const message of messages) {
				expect(message).not.toMatchObject({ content: [{ prompt_cache_breakpoint: { mode: "explicit" } }] });
			}
		}
	});
});
