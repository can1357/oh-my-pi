import { describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	ToolResultMessage,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
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
	compat: resolveModelPolicy({
		...openAI56CompletionsSpec,
		api: "openai-completions",
	}).compat,
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
		expect(messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "stable history", prompt_cache_breakpoint: { mode: "explicit" } }],
			},
			expect.objectContaining({ role: "assistant", content: "previous answer" }),
			{
				role: "user",
				content: [{ type: "text", text: "current prompt", prompt_cache_breakpoint: { mode: "explicit" } }],
			},
		]);
	});

	describe("explicit boundaries in a tool loop", () => {
		const toolRound = (round: number): [AssistantMessage, ToolResultMessage, ToolResultMessage] => [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: `call_${round}a`, name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: `call_${round}b`, name: "read", arguments: { path: "b" } },
				],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-5.6",
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: round,
			},
			{
				role: "toolResult",
				toolCallId: `call_${round}a`,
				toolName: "read",
				content: [{ type: "text", text: `round ${round} a` }],
				isError: false,
				timestamp: round,
			},
			{
				role: "toolResult",
				toolCallId: `call_${round}b`,
				toolName: "read",
				content: [{ type: "text", text: `round ${round} b` }],
				isError: false,
				timestamp: round,
			},
		];
		const loop = (rounds: number): Context => ({
			systemPrompt: ["stable instructions"],
			messages: [
				{ role: "user", content: "read both files", timestamp: 0 },
				...Array.from({ length: rounds }, (_, index) => toolRound(index + 1)).flat(),
			],
		});
		const markedTexts = (messages: unknown) =>
			[...JSON.stringify(messages).matchAll(/"text":"([^"]*)","prompt_cache_breakpoint"/g)].map(match => match[1]);
		const send = async (context: Context) => {
			const { body } = await captureSimpleRequest(
				{ promptCache: { mode: "explicit" } },
				openAI56CompletionsModel,
				context,
			);
			if (!Array.isArray(body.messages)) throw new Error("Expected Chat Completions messages");
			return body.messages;
		};

		it("marks the instructions, each user message and the end of each tool-result run", async () => {
			const context = loop(2);
			context.messages.push({ role: "user", content: "summarize", timestamp: 9 });

			expect(markedTexts(await send(context))).toEqual([
				"stable instructions",
				"read both files",
				"round 1 b",
				"round 2 b",
				"summarize",
			]);
		});

		// Chat Completions resends the whole history: request N+1 must still mark
		// every boundary request N wrote, or explicit mode never reads a cached prefix.
		it("keeps every earlier marker byte-identical as the loop grows", async () => {
			const first = await send(loop(1));
			const next = await send(loop(2));

			expect(next.slice(0, first.length)).toEqual(first);
			expect(markedTexts(next)).toEqual([...markedTexts(first), "round 2 b"]);
		});
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

	it("rejects the Responses-only 12h lifetime before sending a request", async () => {
		let sent = false;
		const fetchMock: FetchImpl = async () => {
			sent = true;
			return chatCompletionsSse();
		};
		const result = await streamOpenAICompletions(openAI56CompletionsModel, context, {
			apiKey: "test-key",
			promptCache: { mode: "implicit", ttl: "12h" },
			fetch: fetchMock,
		}).result();

		expect(sent).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("12h prompt caching is only available on the Responses API");
	});

	it("places no markers when the caller opts out", async () => {
		const { body } = await captureRequest(
			{ promptCache: { mode: "explicit", breakpoint: "none" } },
			openAI56CompletionsModel,
			historicalContext,
		);

		expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(JSON.stringify(body.messages)).not.toContain("prompt_cache_breakpoint");
	});
});
