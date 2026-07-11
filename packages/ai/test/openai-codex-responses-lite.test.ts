import { describe, expect, it } from "bun:test";
import {
	type InputItem,
	type RequestBody,
	transformRequestBody,
} from "@pk-nerdsaver-ai/pi-ai/providers/openai-codex/request-transformer";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@pk-nerdsaver-ai/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { createCodexModel } from "./helpers";

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCodexSse(events: Array<Record<string, unknown>>): string {
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

const COMPLETED_CODEX_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

interface CapturedCodexRequest {
	headers: Headers;
	body: Record<string, unknown>;
}

function createCodexFetchMock(sse: string, onRequest: (captured: CapturedCodexRequest) => void): FetchImpl {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		if (url.endsWith("/responses")) {
			onRequest({
				headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
				body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
			});
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
}

describe("openai-codex reasoning.context", () => {
	it("forwards an explicit reasoning.context and defaults to all_turns", async () => {
		const model = createCodexModel("gpt-5.1-codex");

		const explicit = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "medium",
			reasoningContext: "current_turn",
		});
		expect(explicit.reasoning?.context).toBe("current_turn");

		const defaulted = await transformRequestBody({ model: model.id }, model, { reasoningEffort: "medium" });
		expect(defaulted.reasoning?.context).toBe("all_turns");
	});

	it("defaults reasoning.context to all_turns under Responses Lite unless overridden", async () => {
		const model = createCodexModel("gpt-5.1-codex");

		const lite = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "medium",
			responsesLite: true,
		});
		expect(lite.reasoning?.context).toBe("all_turns");

		const overridden = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "medium",
			responsesLite: true,
			reasoningContext: "auto",
		});
		expect(overridden.reasoning?.context).toBe("auto");
	});
});

describe("openai-codex Responses Lite input shaping", () => {
	it("keeps full Responses image details when a requested lite body contains images", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const makeInput = (): InputItem[] => [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
			{ type: "function_call", call_id: "call_1", name: "shot", arguments: "{}" },
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [{ type: "input_image", detail: "high", image_url: "data:image/png;base64,BBBB" }],
			},
		];

		const lite = await transformRequestBody({ model: model.id, input: makeInput() }, model, { responsesLite: true });
		const liteMessage = lite.input?.[0]?.content as Array<Record<string, unknown>>;
		const liteOutput = lite.input?.[2]?.output as Array<Record<string, unknown>>;
		expect(liteMessage[1]).toEqual({ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" });
		expect(liteOutput[0]).toEqual({ type: "input_image", detail: "high", image_url: "data:image/png;base64,BBBB" });

		const plain = await transformRequestBody({ model: model.id, input: makeInput() }, model, {});
		const plainMessage = plain.input?.[0]?.content as Array<Record<string, unknown>>;
		expect(plainMessage[1]?.detail).toBe("auto");
	});

	it("clamps original image detail when Codex compat disables it", () => {
		const model = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "cc-switch",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 100_000,
			compat: { supportsImageDetailOriginal: false },
		});
		const messages = convertCodexResponsesMessages(model, {
			messages: [
				{
					role: "user",
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "look" },
						{ type: "image", mimeType: "image/png", data: "AAAA", detail: "original" },
					],
				},
			],
		});
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "input_text" }, { type: "input_image", detail: "auto" }],
		});
	});

	it("forces parallel_tool_calls off under lite when tools are present", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const tools = [{ type: "function", name: "shot", parameters: { type: "object" } }];

		const lite = await transformRequestBody({ model: model.id, tools, parallel_tool_calls: true }, model, {
			responsesLite: true,
		});
		expect(lite.parallel_tool_calls).toBe(false);

		const plain = await transformRequestBody({ model: model.id, tools, parallel_tool_calls: true }, model, {});
		expect(plain.parallel_tool_calls).toBe(true);

		const noTools = await transformRequestBody({ model: model.id }, model, { responsesLite: true });
		expect(noTools.parallel_tool_calls).toBeUndefined();
	});
});

describe("openai-codex Responses Lite and client metadata wire format", () => {
	it("sends the lite header and client_metadata body field over SSE", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const clientMetadata = { "x-codex-turn-metadata": '{"thread_id":"thread_1","turn_id":"turn_1"}' };
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured = request;
		});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			responsesLite: true,
			clientMetadata,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured?.body.client_metadata).toEqual(clientMetadata);
	});
	it("falls back to full Responses when a lite request contains images", async () => {
		const model = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured = request;
		});

		const result = await streamOpenAICodexResponses(
			model,
			{
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [
							{ type: "text", text: "read this image" },
							{ type: "image", mimeType: "image/png", data: "AAAA" },
						],
					},
				],
			},
			{
				apiKey: createCodexTestToken(),
				fetch: fetchMock,
				responsesLite: true,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBeNull();
		expect(captured?.body.input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "read this image" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
		]);
	});

	it("omits the lite header and client_metadata when not requested", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured = request;
		});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBeNull();
		expect(captured?.body.client_metadata).toBeUndefined();
	});
});

describe("openai-codex response.metadata moderation", () => {
	const moderation = { decision: "flagged", categories: ["sensitive"] };
	const eventsWithModeration: Array<Record<string, unknown>> = [
		{ type: "response.metadata", metadata: { openai_chatgpt_moderation_metadata: moderation } },
		...COMPLETED_CODEX_EVENTS,
	];

	it("surfaces openai_chatgpt_moderation_metadata to onModerationMetadata", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const seen: unknown[] = [];
		const fetchMock = createCodexFetchMock(createCodexSse(eventsWithModeration), () => {});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			onModerationMetadata: metadata => {
				seen.push(metadata);
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
		expect(seen).toEqual([moderation]);
	});

	it("keeps the stream alive when the moderation observer throws", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const fetchMock = createCodexFetchMock(createCodexSse(eventsWithModeration), () => {});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			onModerationMetadata: () => {
				throw new Error("observer exploded");
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
	});
});

describe("openai-codex websocket append with client metadata", () => {
	it("does not break append equality when client_metadata rotates between turns", async () => {
		// buildAppendInput contract proxied through the transformer-produced body:
		// two turns differing only in client_metadata must still compare equal
		// once input/client_metadata are excluded. Exercised at the unit level in
		// the websocket delta test; here we pin the body-shape invariant the
		// comparison relies on (client_metadata is a top-level body key).
		const model = createCodexModel("gpt-5.1-codex");
		const body: RequestBody = { model: model.id, client_metadata: { "x-codex-turn-metadata": "{}" } };
		const transformed = await transformRequestBody(body, model, {});
		expect(transformed.client_metadata).toEqual({ "x-codex-turn-metadata": "{}" });
	});
});
