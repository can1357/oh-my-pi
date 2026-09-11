import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type InputItem,
	type RequestBody,
	transformRequestBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	resetOpenAICodexHistoryAfterCompaction,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { isOpenAIResponsesProgressEvent } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type {
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	ModelSpec,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

beforeAll(() => configureCredentialRedaction(true));
afterAll(() => configureCredentialRedaction(false));

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`expected ${label} to be an object`);
	}
	return value;
}

/**
 * Decode a captured Codex SSE request body. The provider zstd-compresses the
 * body by default, so a binary payload is decompressed before JSON parsing.
 */
function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

function parseTurnMetadata(clientMetadata: Record<string, unknown>): Record<string, unknown> {
	const encoded = clientMetadata["x-codex-turn-metadata"];
	if (typeof encoded !== "string") throw new Error("expected x-codex-turn-metadata");
	const decoded: unknown = JSON.parse(encoded);
	return requireRecord(decoded, "x-codex-turn-metadata");
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
				body: JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>,
			});
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
}

describe("openai-codex optional response controls", () => {
	it("defaults reasoning.summary on and forwards explicit controls", async () => {
		const model = createCodexModel("gpt-5.5");

		// The backend emits no reasoning summaries at all unless `summary` is
		// sent, so an unset `reasoningSummary` must still request one.
		const defaulted = await transformRequestBody({ model: model.id }, model, { reasoningEffort: "medium" });
		expect(defaulted.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect("context" in (defaulted.reasoning ?? {})).toBe(false);
		expect("text" in defaulted).toBe(false);
		expect("stream_options" in defaulted).toBe(false);

		const explicit = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "medium",
			reasoningSummary: "concise",
			reasoningContext: "all_turns",
			textVerbosity: "low",
		});
		expect(explicit.reasoning).toEqual({
			effort: "medium",
			summary: "concise",
			context: "all_turns",
		});
		expect(explicit.text).toEqual({ verbosity: "low" });
		expect("stream_options" in explicit).toBe(false);
	});

	it("omits reasoning.summary when explicitly suppressed", async () => {
		const model = createCodexModel("gpt-5.5");
		const suppressed = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "medium",
			reasoningSummary: null,
		});
		expect(suppressed.reasoning).toEqual({ effort: "medium" });
		expect("summary" in (suppressed.reasoning ?? {})).toBe(false);
		expect("stream_options" in suppressed).toBe(false);
	});

	it("removes inherited reasoning summaries when model compatibility disables them", async () => {
		const base = createCodexModel("gpt-5.5");
		const model = buildModel({
			...base,
			compat: { ...base.compatConfig, supportsReasoningSummary: false },
		} as ModelSpec<"openai-codex-responses">);

		const body = await transformRequestBody({ model: model.id, reasoning: { summary: "auto" } }, model, {
			reasoningEffort: "medium",
			reasoningSummary: "detailed",
		});

		expect(body.reasoning).toEqual({ effort: "medium" });
		expect("stream_options" in body).toBe(false);
	});

	it("disables native reasoning with effort none when an external scratchpad replaces it", async () => {
		const model = createCodexModel("gpt-5.5");
		const body = await buildTransformedCodexRequestBody(model, createCodexTestContext(), {
			forceReasoningOff: true,
		});
		expect(body.reasoning).toEqual({ effort: "none" });
	});

	it("forces reasoning.context to all_turns for Responses Lite", async () => {
		const model = createCodexModel("gpt-5.5");

		const missingEffort = await transformRequestBody({ model: model.id }, model, {
			responsesLite: true,
		});
		expect(missingEffort.reasoning).toEqual({ context: "all_turns" });

		const noneEffort = await transformRequestBody({ model: model.id }, model, {
			reasoningEffort: "none",
			responsesLite: true,
			reasoningContext: "current_turn",
		});
		expect(noneEffort.reasoning).toEqual({ effort: "none", summary: "auto", context: "all_turns" });

		const plainRequest = await transformRequestBody({ model: model.id }, model, {
			responsesLite: false,
		});
		expect(plainRequest.reasoning).toBeUndefined();
	});

	// gpt-5.1-codex / gpt-5.3-codex / gpt-5.3-codex-spark reject `all_turns`
	// ("Unsupported value: 'all_turns' is not supported with this model").
	it.each(["gpt-5.1-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark"])(
		"omits unsupported all_turns context for pre-5.4 model %s",
		async modelId => {
			const model = createCodexModel(modelId);
			const forced = await transformRequestBody({ model: model.id }, model, {
				reasoningEffort: "medium",
				reasoningContext: "all_turns",
			});
			expect(forced.reasoning).toEqual({ effort: "medium" });

			const overridden = await transformRequestBody({ model: model.id }, model, {
				reasoningEffort: "medium",
				reasoningContext: "current_turn",
			});
			expect(overridden.reasoning).toEqual({ effort: "medium", context: "current_turn" });
		},
	);

	// gpt-5.1-codex / gpt-5.3-codex / gpt-5.3-codex-spark reject `reasoning.summary`
	// ("Unsupported parameter: 'reasoning.summary' is not supported with this model").
	it.each(["gpt-5.1-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark"])(
		"omits reasoning.summary for pre-5.4 model %s",
		async modelId => {
			const model = createCodexModel(modelId);
			const forced = await transformRequestBody({ model: model.id }, model, {
				reasoningEffort: "medium",
				reasoningSummary: "detailed",
			});
			expect(forced.reasoning).toEqual({ effort: "medium" });
			expect("stream_options" in forced).toBe(false);
		},
	);
});

describe("openai-codex Responses Lite input shaping", () => {
	it("strips image detail and keeps lite when the input contains images", async () => {
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
		expect(lite.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools: [] });
		const liteMessage = lite.input?.[1]?.content as Array<Record<string, unknown>>;
		const liteOutput = lite.input?.[3]?.output as Array<Record<string, unknown>>;
		expect(liteMessage[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
		expect(liteOutput[0]).toEqual({ type: "input_image", image_url: "data:image/png;base64,BBBB" });

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

	it("forces parallel_tool_calls off and moves tools into input under lite", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const tools = [{ type: "function", name: "shot", parameters: { type: "object" } }];

		const lite = await transformRequestBody({ model: model.id, tools, parallel_tool_calls: true }, model, {
			responsesLite: true,
		});
		expect(lite.parallel_tool_calls).toBe(false);
		expect(lite.tools).toBeUndefined();
		expect(lite.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools });

		const plain = await transformRequestBody({ model: model.id, tools, parallel_tool_calls: true }, model, {});
		expect(plain.parallel_tool_calls).toBe(true);
		expect(plain.tools).toEqual(tools);

		const noTools = await transformRequestBody({ model: model.id }, model, { responsesLite: true });
		expect(noTools.parallel_tool_calls).toBe(false);
	});

	it("falls back from forced hosted tool choices without weakening explicit tool-use constraints", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const tools = [{ type: "function", name: "handoff", parameters: { type: "object" } }];

		const forced = await transformRequestBody(
			{ model: model.id, tools, tool_choice: { type: "web_search" } },
			model,
			{ responsesLite: true },
		);
		expect(forced.tool_choice).toBe("auto");
		expect(forced.tools).toBeUndefined();

		const disabled = await transformRequestBody({ model: model.id, tools, tool_choice: "none" }, model, {
			responsesLite: true,
		});
		expect(disabled.tool_choice).toBe("none");
		expect(disabled.tools).toBeUndefined();
	});

	it.each(["gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])(
		"preserves a forced computer function through Lite for %s",
		async modelId => {
			const model = createCodexModel(modelId);
			const computer = { type: "function", name: "computer", parameters: { type: "object" } };
			const other = { type: "function", name: "read", parameters: { type: "object" } };
			const body = await transformRequestBody(
				{ model: model.id, tools: [computer, other], tool_choice: { type: "function", name: "computer" } },
				model,
				{ responsesLite: true },
			);
			expect(body.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools: [computer] });
			expect(body.tool_choice).toBe("required");
		},
	);

	it("moves instructions and tools into input items under lite", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const tools = [{ type: "function", name: "shot", parameters: { type: "object" } }];
		const body = await transformRequestBody(
			{
				model: model.id,
				instructions: "test instructions",
				tools,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
			},
			model,
			{ responsesLite: true },
		);

		expect(body.instructions).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(body.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools });
		expect(body.input?.[1]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "test instructions" }],
		});
		expect(body.input?.[2]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "hello" }],
		});
	});

	it("defaults normal inference to full Responses and keeps explicit options above the environment", async () => {
		const previous = Bun.env.PI_CODEX_RESPONSES_LITE;
		const model = createCodexModel("gpt-5.6-terra", { useResponsesLite: true });
		try {
			delete Bun.env.PI_CODEX_RESPONSES_LITE;
			const defaultRequest = await transformRequestBody({ model: model.id, instructions: "sys" }, model, {});
			expect(defaultRequest.instructions).toBe("sys");
			expect(defaultRequest.input?.some(item => item.type === "additional_tools")).toBe(false);

			Bun.env.PI_CODEX_RESPONSES_LITE = "true";
			const envOptIn = await transformRequestBody({ model: model.id, instructions: "sys" }, model, {});
			expect(envOptIn.instructions).toBeUndefined();
			expect(envOptIn.input?.[0]?.type).toBe("additional_tools");

			const explicitOptOut = await transformRequestBody({ model: model.id, instructions: "sys" }, model, {
				responsesLite: false,
			});
			expect(explicitOptOut.instructions).toBe("sys");
			expect(explicitOptOut.input?.some(item => item.type === "additional_tools")).toBe(false);
		} finally {
			if (previous === undefined) delete Bun.env.PI_CODEX_RESPONSES_LITE;
			else Bun.env.PI_CODEX_RESPONSES_LITE = previous;
		}
	});
});

describe("openai-codex fresh execution input shaping", () => {
	it("adds a user continuation when only instructions would be sent", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const body = await buildTransformedCodexRequestBody(
			model,
			{
				systemPrompt: ["You are a helpful assistant.", "Read local://approved-plan.md and execute it."],
				messages: [],
			},
			undefined,
		);

		expect(body.instructions).toBe("You are a helpful assistant.");
		expect(body.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Read local://approved-plan.md and execute it." }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Read local://approved-plan.md and execute it." }],
			},
		]);
	});

	it("does not add a continuation when user input is present", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const body = await buildTransformedCodexRequestBody(
			model,
			{
				systemPrompt: ["You are a helpful assistant.", "Read local://approved-plan.md and execute it."],
				messages: [{ role: "user", content: "Start execution", timestamp: Date.now() }],
			},
			undefined,
		);

		expect(body.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Read local://approved-plan.md and execute it." }],
			},
			{
				role: "user",
				content: [{ type: "input_text", text: "Start execution" }],
			},
		]);
	});
});

describe("openai-codex Responses Lite and client metadata wire format", () => {
	it("sends canonical Codex metadata and protects reserved fields over SSE", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const context = createCodexTestContext();
		const clientMetadata = {
			workspace_kind: "repo",
			workspace_path: "東京/🚀",
			session_id: "caller-session",
			"x-codex-turn-metadata": '{"turn_id":"caller-turn"}',
		};
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured = request;
		});

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			responsesLite: true,
			clientMetadata,
		}).result();

		expect(result.stopReason).toBe("stop");
		if (!captured) throw new Error("expected a captured Codex request");
		expect(captured.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured.headers.get("x-codex-installation-id")).toBeNull();

		const metadata = requireRecord(captured.body.client_metadata, "client_metadata");
		const turnMetadata = parseTurnMetadata(metadata);
		expect(metadata.workspace_kind).toBeUndefined();
		expect(metadata.workspace_path).toBeUndefined();
		expect(metadata.session_id).not.toBe("caller-session");
		expect(turnMetadata.request_kind).toBe("turn");
		expect(turnMetadata.turn_started_at_unix_ms).toBe(context.messages[0]?.timestamp);
		expect(turnMetadata.workspace_kind).toBe("repo");
		expect(turnMetadata.workspace_path).toBe("東京/🚀");
		expect(metadata["x-codex-installation-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(metadata.session_id).toBe(turnMetadata.session_id);
		expect(metadata.thread_id).toBe(turnMetadata.thread_id);
		expect(metadata.turn_id).toBe(turnMetadata.turn_id);
		expect(metadata["x-codex-window-id"]).toBe(turnMetadata.window_id);
		expect(metadata.session_id).toBe(captured.headers.get("session-id"));
		expect(metadata.thread_id).toBe(captured.headers.get("thread-id"));
		expect(metadata["x-codex-window-id"]).toBe(captured.headers.get("x-codex-window-id"));
		expect(metadata["x-codex-turn-metadata"]).toBe(captured.headers.get("x-codex-turn-metadata"));
		const turnMetadataHeader = captured.headers.get("x-codex-turn-metadata");
		expect(turnMetadataHeader).toMatch(/^[\x20-\x7e]+$/);
		const reparsedTurnMetadata: unknown = turnMetadataHeader ? JSON.parse(turnMetadataHeader) : undefined;
		expect(requireRecord(reparsedTurnMetadata, "round-tripped turn metadata").workspace_path).toBe("東京/🚀");
	});

	it("keeps the installation identity stable across provider sessions", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const captured: CapturedCodexRequest[] = [];
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured.push(request);
		});

		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			sessionId: "metadata-session-one",
		}).result();
		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			sessionId: "metadata-session-two",
		}).result();

		const firstMetadata = requireRecord(captured[0]?.body.client_metadata, "first client_metadata");
		const secondMetadata = requireRecord(captured[1]?.body.client_metadata, "second client_metadata");
		expect(firstMetadata["x-codex-installation-id"]).toBe(secondMetadata["x-codex-installation-id"]);
		expect(firstMetadata.session_id).toBe("metadata-session-one");
		expect(secondMetadata.session_id).toBe("metadata-session-two");
		expect(firstMetadata.thread_id).not.toBe(secondMetadata.thread_id);
	});

	it("rotates compaction turns by phase and reuses one operation across fan-out calls", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const captured: CapturedCodexRequest[] = [];
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured.push(request);
		});
		const send = async (codexCompaction?: CodexCompactionRequestContext): Promise<void> => {
			await streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				fetch: fetchMock,
				sessionId: "compaction-lifecycle-session",
				providerSessionState,
				codexCompaction,
			}).result();
		};
		const preTurn: CodexCompactionRequestContext = {
			operationId: "pre-turn-operation",
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses",
			phase: "pre_turn",
			strategy: "memento",
		};
		const midTurn: CodexCompactionRequestContext = {
			...preTurn,
			operationId: "mid-turn-operation",
			phase: "mid_turn",
		};
		const standalone: CodexCompactionRequestContext = {
			...preTurn,
			operationId: "standalone-operation",
			trigger: "manual",
			reason: "user_requested",
			phase: "standalone_turn",
		};

		await send();
		await send(preTurn);
		await send(preTurn);
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState,
			sessionId: "compaction-lifecycle-session",
			compaction: preTurn,
		});
		await send();
		await send(midTurn);
		await send(standalone);

		const turns = captured.map((request, index) =>
			parseTurnMetadata(requireRecord(request.body.client_metadata, `client_metadata ${index}`)),
		);
		expect(turns[0]?.request_kind).toBe("turn");
		expect(turns[1]?.turn_id).not.toBe(turns[0]?.turn_id);
		expect(turns[2]?.turn_id).toBe(turns[1]?.turn_id);
		expect(turns[2]?.turn_started_at_unix_ms).toBe(turns[1]?.turn_started_at_unix_ms);
		expect(turns[3]?.request_kind).toBe("turn");
		expect(turns[3]?.turn_id).toBe(turns[1]?.turn_id);
		expect(turns[3]?.window_id).not.toBe(turns[2]?.window_id);
		expect(turns[4]?.turn_id).toBe(turns[1]?.turn_id);
		expect(turns[5]?.turn_id).not.toBe(turns[4]?.turn_id);
		expect(turns[1]?.thread_id).toBe(turns[5]?.thread_id);
		expect(turns[1]?.compaction).toEqual({
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses",
			phase: "pre_turn",
			strategy: "memento",
		});
		const nestedCompaction = requireRecord(turns[1]?.compaction, "nested compaction metadata");
		expect(nestedCompaction.operationId).toBeUndefined();
		expect(nestedCompaction.operation_id).toBeUndefined();
		expect(turns[5]?.compaction).toEqual({
			trigger: "manual",
			reason: "user_requested",
			implementation: "responses",
			phase: "standalone_turn",
			strategy: "memento",
		});
	});
	it("keeps lite and strips image detail when a lite request contains images", async () => {
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
		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured?.body.reasoning).toEqual({ context: "all_turns" });
		expect(captured?.body.input).toEqual([
			{ type: "additional_tools", role: "developer", tools: [] },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "read this image" },
					{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
				],
			},
		]);
	});

	it("sends required lite context for opaque model codenames", async () => {
		const model = createCodexModel("gpt-daybreak-blue-latest", { useResponsesLite: true });
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), request => {
			captured = request;
		});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			responsesLite: true,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured!.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured!.headers.get("version")).toBe("0.153.0");
		const body = captured!.body;
		expect(body.reasoning).toEqual({ context: "all_turns" });
		expect(body.instructions).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect((body.input as Array<Record<string, unknown>>)[0]?.type).toBe("additional_tools");
	});

	it("uses full Responses for normal inference when the model advertises Lite", async () => {
		const model = createCodexModel("gpt-5.6-terra", { useResponsesLite: true });
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
		expect(captured?.body.instructions).toBe("You are a helpful assistant.");
		expect(captured?.body.parallel_tool_calls).toBeUndefined();
		expect(captured?.body.client_metadata).toBeDefined();
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

describe("openai-codex concurrent reasoning summaries", () => {
	// Sequential-cutoff delivery is opt-in (it cancels in-flight summary
	// sections), so the response-side contract is exercised with it enabled.
	let previousConcurrent: string | undefined;
	beforeEach(() => {
		previousConcurrent = Bun.env.PI_CODEX_CONCURRENT_SUMMARIES;
		Bun.env.PI_CODEX_CONCURRENT_SUMMARIES = "1";
	});
	afterEach(() => {
		if (previousConcurrent === undefined) delete Bun.env.PI_CODEX_CONCURRENT_SUMMARIES;
		else Bun.env.PI_CODEX_CONCURRENT_SUMMARIES = previousConcurrent;
	});

	it("counts atomic summary dones as websocket watchdog progress", () => {
		expect(isOpenAIResponsesProgressEvent({ type: "response.reasoning_summary_text.done" })).toBe(true);
	});

	it("sends stream_options only when opted in, with a supported summary requested", async () => {
		const terra = createCodexModel("gpt-5.6-terra");
		const summaryRequest = { reasoningEffort: "medium", reasoningSummary: "detailed" } as const;

		const withSummary = await transformRequestBody({ model: terra.id }, terra, summaryRequest);
		expect(withSummary.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
		expect(withSummary.reasoning?.summary).toBe("detailed");

		// Opted out: the summary is still requested, only the delivery mode drops.
		delete Bun.env.PI_CODEX_CONCURRENT_SUMMARIES;
		const optedOut = await transformRequestBody({ model: terra.id }, terra, summaryRequest);
		expect(optedOut.stream_options).toBeUndefined();
		expect(optedOut.reasoning?.summary).toBe("detailed");
		Bun.env.PI_CODEX_CONCURRENT_SUMMARIES = "1";

		const suppressed = await transformRequestBody({ model: terra.id }, terra, {
			reasoningEffort: "medium",
			reasoningSummary: null,
		});
		expect(suppressed.stream_options).toBeUndefined();

		const noReasoning = await transformRequestBody({ model: terra.id }, terra, {});
		expect(noReasoning.stream_options).toBeUndefined();

		const legacy = createCodexModel("gpt-5.1-codex");
		const unsupported = await transformRequestBody({ model: legacy.id }, legacy, {
			reasoningEffort: "medium",
			reasoningSummary: "detailed",
		});
		expect(unsupported.stream_options).toBeUndefined();
	});

	it("renders summary deltas when sequential-cutoff omits atomic done events", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "reason_delta", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				item_id: "reason_delta",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "reason_delta",
				output_index: 0,
				summary_index: 0,
				delta: "Streaming ",
			},
			{
				type: "response.reasoning_summary_part.done",
				item_id: "reason_delta",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "Streaming " },
			},
			{
				type: "response.reasoning_summary_part.added",
				item_id: "reason_delta",
				output_index: 0,
				summary_index: 1,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "reason_delta",
				output_index: 0,
				summary_index: 0,
				delta: "fallback",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "reason_delta", summary: [] },
			},
			...COMPLETED_CODEX_EVENTS,
		];
		const fetchMock = createCodexFetchMock(createCodexSse(events), () => {});
		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			reasoning: "medium",
			reasoningSummary: "detailed",
		});
		const thinkingDeltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
		}
		const result = await stream.result();

		expect(thinkingDeltas).toEqual(["Streaming ", "\n\n", "fallback"]);
		expect(result.content.find(block => block.type === "thinking")?.thinking).toBe("Streaming \n\nfallback");
	});

	it("deduplicates cumulative atomic summaries and ignores legacy deltas under sequential cutoff", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "reason_1", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 0,
				delta: "IGNORED",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 0,
				text: "Plan",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 1,
				text: "Planning details",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 1,
				text: "Planning details",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 2,
				text: "Plan\n\nPlanning details\n\nInspect",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 2,
				text: "Plan\n\nPlanning details\n\nInspect details",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 2,
				text: "Plan\n\nPlanning details\n\nInspect details",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 3,
				text: "Plan\n\nPlanning details\n\nInspect details",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 2,
				text: "Plan\n\nPlanning details\n\nReview",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 2,
				text: "Plan\n\nPlanning details\n\nReview output",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 3,
				text: "Plan\n\nPlanning details\n\nReview output",
			},
			{
				type: "response.reasoning_summary_part.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 3,
				part: { type: "summary_text", text: "Plan\n\nPlanning details\n\nInspect details" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "reason_1",
					summary: [
						{ type: "summary_text", text: "Plan" },
						{ type: "summary_text", text: "Planning details" },
						{ type: "summary_text", text: "Plan\n\nPlanning details\n\nInspect details\n\nUnseen final" },
						{ type: "summary_text", text: "Plan\n\nPlanning details\n\nInspect details\n\nUnseen final" },
					],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "Hello" },
			{
				type: "response.reasoning_summary_text.done",
				item_id: "reason_1",
				output_index: 0,
				summary_index: 4,
				text: "STALE",
			},
			{
				type: "response.output_item.done",
				output_index: 1,
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
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		let captured: CapturedCodexRequest | undefined;
		const fetchMock = createCodexFetchMock(createCodexSse(events), request => {
			captured = request;
		});

		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			reasoning: "medium",
			reasoningSummary: "detailed",
		});
		const thinkingDeltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
		}
		const result = await stream.result();

		expect(captured?.body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
		expect(thinkingDeltas).toEqual(["Plan", "\n\nPlanning details", "\n\nInspect", " details"]);
		expect(result.stopReason).toBe("stop");
		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking?.thinking).toBe("Plan\n\nPlanning details\n\nInspect details");
		expect(thinking?.thinking).toBe(thinkingDeltas.join(""));
		const text = result.content.find(block => block.type === "text");
		expect(text?.text).toBe("Hello");
	});

	it("does not replay earlier sections across reasoning items under sequential cutoff", async () => {
		// Real gpt-5.6 sessions send response-GLOBAL summary indices: each new
		// reasoning item replays the previous item's last completed section
		// (`.done` at index N-1) before streaming its own, replay-only items add
		// nothing, and every `output_item.done` payload carries the cumulative
		// summary array. Folding per item duplicated every section header.
		const model = createCodexModel("gpt-5.6-terra");
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				text: "Planning refactor",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Planning refactor" }] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "reasoning", id: "rs_2", summary: [] },
			},
			// Replay of the previous item's section, then the new one.
			{
				type: "response.reasoning_summary_text.done",
				item_id: "rs_2",
				output_index: 1,
				summary_index: 0,
				text: "Planning refactor",
			},
			{
				type: "response.reasoning_summary_text.done",
				item_id: "rs_2",
				output_index: 1,
				summary_index: 1,
				text: "Designing resolution",
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "reasoning",
					id: "rs_2",
					summary: [
						{ type: "summary_text", text: "Planning refactor" },
						{ type: "summary_text", text: "Designing resolution" },
					],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				item: { type: "reasoning", id: "rs_3", summary: [] },
			},
			// Replay-only item: no new section arrives before it closes.
			{
				type: "response.reasoning_summary_text.done",
				item_id: "rs_3",
				output_index: 2,
				summary_index: 1,
				text: "Designing resolution",
			},
			{
				type: "response.output_item.done",
				output_index: 2,
				item: {
					type: "reasoning",
					id: "rs_3",
					summary: [
						{ type: "summary_text", text: "Planning refactor" },
						{ type: "summary_text", text: "Designing resolution" },
					],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 3,
				item: { type: "reasoning", id: "rs_4", summary: [] },
			},
			// Payload-only item: its new section never streams a `.done` event.
			{
				type: "response.output_item.done",
				output_index: 3,
				item: {
					type: "reasoning",
					id: "rs_4",
					summary: [
						{ type: "summary_text", text: "Planning refactor" },
						{ type: "summary_text", text: "Designing resolution" },
						{ type: "summary_text", text: "Enhancing caching" },
					],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 4,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 4, delta: "Hello" },
			{
				type: "response.output_item.done",
				output_index: 4,
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
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const fetchMock = createCodexFetchMock(createCodexSse(events), () => {});

		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			reasoning: "medium",
			reasoningSummary: "detailed",
		});
		const deltasByBlock = new Map<number, string>();
		for await (const event of stream) {
			if (event.type === "thinking_delta") {
				deltasByBlock.set(event.contentIndex, (deltasByBlock.get(event.contentIndex) ?? "") + event.delta);
			}
		}
		const result = await stream.result();

		const thinkingBlocks = result.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks.map(block => block.thinking)).toEqual([
			"Planning refactor",
			"Designing resolution",
			"",
			"Enhancing caching",
		]);
		// Streamed deltas match each block that streamed; the payload-only block
		// surfaces its unseen suffix at finalization without a delta.
		expect([...deltasByBlock.entries()]).toEqual([
			[0, "Planning refactor"],
			[1, "Designing resolution"],
		]);
		// The replay-only block keeps its signed reasoning item so history replay
		// still round-trips encrypted reasoning.
		const replayOnly = thinkingBlocks[2];
		expect(replayOnly?.thinkingSignature).toBeDefined();
		expect(JSON.parse(replayOnly?.thinkingSignature ?? "{}").id).toBe("rs_3");
		const text = result.content.find(block => block.type === "text");
		expect(text?.text).toBe("Hello");
	});
});

describe("openai-codex native history redaction", () => {
	it("redacts credentials from user provider history before replaying it", () => {
		const model = createCodexModel("gpt-5.1-codex");
		const credential = "sk-ABCdef1234567890ABCdef1234567890ABCdef1234567890ABCdef123456";
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "fallback",
					timestamp: Date.now(),
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: model.provider,
						items: [{ type: "message", role: "user", content: [{ type: "input_text", text: credential }] }],
					},
				} as Context["messages"][number],
			],
		};

		const messages = convertCodexResponsesMessages(model, context);

		expect(messages).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "[openai_token_redacted]" }],
			},
		]);
	});
});
