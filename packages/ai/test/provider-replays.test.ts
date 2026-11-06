/**
 * `AssistantMessage.providerReplays` is the count recovery above a provider
 * reads to decide whether a failed request was already re-sent. It has to hold
 * every request the call made, not the rungs one layer happens to own: a replay
 * `fetchWithRetry` made under the provider, the uncompressed resend after a
 * rejected compressed body, the Copilot identity resend, or an attempt that
 * never opened, is a request the model saw, and a caller that cannot see it
 * replays it again.
 *
 * The wire here is the runtime's own `fetch`, replaced for the test: that is
 * the transport the count describes. A caller-supplied `fetch` is opaque to the
 * count, and its own tests below expect `undefined`.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { __resetVertexTokenCache } from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getCodexProviderSessionState } from "@oh-my-pi/pi-ai/providers/openai-codex-state";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { withReplaySafeStreamRetry } from "@oh-my-pi/pi-ai/utils/empty-completion-retry";
import { resetRequestCompressionForTesting } from "@oh-my-pi/pi-ai/utils/request-compression";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;
const originalAgentDir = getAgentDir();

afterEach(() => {
	vi.restoreAllMocks();
	resetRequestCompressionForTesting();
	setAgentDir(originalAgentDir);
});

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

/** Above the 1 KiB floor, so `wrapFetchForRequestCompression` compresses the body. */
const largeContext: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "a detailed prompt ".repeat(500), timestamp: Date.now() }],
};

/** Replaces the runtime's `fetch` — the wire under every wrapper a provider installs. */
function serveRuntimeFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input instanceof Request ? input.url : input), init)) as typeof fetch);
}

function hasContentEncoding(init: RequestInit | undefined): boolean {
	return new Headers(init?.headers).has("content-encoding");
}

function overloaded() {
	return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }), {
		status: 503,
		headers: { "retry-after": "0", "content-type": "application/json" },
	});
}

function sseResponse(body: string) {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function codexModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	});
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

/** Reasoning streams, then the stream dies with no status line of its own. */
const CODEX_THINKING_THEN_CUT = [
	{ type: "response.created", response: { id: "resp_probe" } },
	{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_probe", summary: [] } },
	{ type: "response.reasoning_summary_text.delta", item_id: "rs_probe", output_index: 0, delta: "partial plan" },
	{ type: "error", error: { code: "api_error", message: "read ECONNRESET" } },
]
	.map(event => `data: ${JSON.stringify(event)}\n\n`)
	.join("");

it("counts a Codex replay that fetchWithRetry made before the attempt that streamed", async () => {
	// The 503 is replayed inside `fetchWithRetry`, so the attempt that reaches
	// the provider loop is the second request. Its reasoning block is content the
	// first request never produced, which is exactly what a content test reads as
	// "made once".
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async url => {
		if (url !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		requests += 1;
		return requests === 1 ? overloaded() : sseResponse(CODEX_THINKING_THEN_CUT);
	});

	const result = await streamOpenAICodexResponses(codexModel(), context, {
		apiKey: codexToken(),
		preferWebsockets: false,
	}).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("error");
	expect(result.content.some(block => block.type === "thinking")).toBe(true);
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("counts a Codex replacement request that was refused on the way out", async () => {
	// The replacement never opens, so a count taken after the transport is in
	// hand misses it — while the request still went out and still failed.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async url => {
		if (url !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		requests += 1;
		if (requests > 1) throw new Error("read ECONNRESET");
		return sseResponse(
			[
				{ type: "response.created", response: { id: "resp_probe" } },
				{ type: "error", error: { code: "model_error", message: "upstream closed the connection" } },
			]
				.map(event => `data: ${JSON.stringify(event)}\n\n`)
				.join(""),
		);
	});

	const result = await streamOpenAICodexResponses(codexModel(), context, {
		apiKey: codexToken(),
		preferWebsockets: false,
		// One attempt per open, so every re-send is the provider loop's own.
		codexSseMaxAttempts: 1,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(requests).toBeGreaterThan(1);
	expect(result.providerReplays).toBe(requests - 1);
	tempDir.removeSync();
});

it("counts the uncompressed resend after a Codex endpoint refused the compressed body", async () => {
	// `wrapFetchForRequestCompression` resends a refused compressed body
	// uncompressed, below `fetchWithRetry`. A counter above that wrapper saw one
	// call and reported `0` for two requests.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const encodings: boolean[] = [];
	serveRuntimeFetch(async (url, init) => {
		if (url !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		encodings.push(hasContentEncoding(init));
		return hasContentEncoding(init)
			? new Response("unsupported content encoding", { status: 415, headers: { "content-type": "text/plain" } })
			: sseResponse(CODEX_THINKING_THEN_CUT);
	});

	const result = await streamOpenAICodexResponses(codexModel(), largeContext, {
		apiKey: codexToken(),
		preferWebsockets: false,
	}).result();

	expect(encodings).toEqual([true, false]);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("reports nothing for a Codex call made through a caller-supplied fetch", async () => {
	// The caller's `fetch` sits below the counter and may resend inside itself,
	// so a count taken above it cannot say the request went out once.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	const callerFetch: FetchImpl = async input => {
		if (String(input) !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		requests += 1;
		return sseResponse(CODEX_THINKING_THEN_CUT);
	};

	const result = await streamOpenAICodexResponses(codexModel(), context, {
		apiKey: codexToken(),
		preferWebsockets: false,
		fetch: callerFetch,
	}).result();

	expect(requests).toBe(1);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBeUndefined();
	tempDir.removeSync();
});

it("counts the uncompressed resend on the stream() path, where transportFetch issues the request", async () => {
	// Sessions reach a provider through `stream()`, which hands it
	// `transportFetch` as its `fetch`. That is the call every request is issued
	// through, so it carries the counter; compression wraps it from above.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const encodings: boolean[] = [];
	serveRuntimeFetch(async (url, init) => {
		if (url !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		encodings.push(hasContentEncoding(init));
		return hasContentEncoding(init)
			? new Response("unsupported content encoding", { status: 415, headers: { "content-type": "text/plain" } })
			: sseResponse(CODEX_THINKING_THEN_CUT);
	});

	const result = await stream(codexModel(), largeContext, {
		apiKey: codexToken(),
		preferWebsockets: false,
	}).result();

	expect(encodings).toEqual([true, false]);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("reports nothing on the stream() path when the caller supplied the fetch under transportFetch", async () => {
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const callerFetch: FetchImpl = async input =>
		String(input) === "https://chatgpt.com/backend-api/codex/responses"
			? sseResponse(CODEX_THINKING_THEN_CUT)
			: new Response("not found", { status: 404 });

	const result = await stream(codexModel(), context, {
		apiKey: codexToken(),
		preferWebsockets: false,
		fetch: callerFetch,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBeUndefined();
	tempDir.removeSync();
});

const ANTHROPIC_THINKING_THEN_CUT = [
	{
		type: "message_start",
		message: {
			id: "msg_probe",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial plan" } },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

it("counts an Anthropic replay that preceded the attempt that streamed", async () => {
	// Same shape on the other loop: the 503 is replayed below, the next response
	// streams reasoning and ends before its terminal event. Anthropic's own
	// commitment checks describe the attempt in hand, never the ones before it.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async () => {
		requests += 1;
		return requests === 1 ? overloaded() : sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});

	const result = await streamAnthropic(anthropicModel(), context, {
		apiKey: "test-key",
		providerRetryWait: async () => {},
	}).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("error");
	expect(result.content.some(block => block.type === "thinking")).toBe(true);
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("counts the uncompressed resend after Anthropic refused the compressed body", async () => {
	// The resend happens inside `wrapFetchForRequestCompression`, below the
	// client's own loop. A count taken at the client's attempts saw one request
	// where the wire saw two, and the reported `0` earned a hold that repeated
	// both.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const encodings: boolean[] = [];
	serveRuntimeFetch(async (_url, init) => {
		encodings.push(hasContentEncoding(init));
		if (!hasContentEncoding(init)) return sseResponse(ANTHROPIC_THINKING_THEN_CUT);
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Request body is not valid gzip.",
					details: { error_code: "request_body_encoding_invalid" },
				},
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	});

	const result = await streamAnthropic(anthropicModel(), largeContext, {
		apiKey: "test-key",
		providerRetryWait: async () => {},
	}).result();

	expect(encodings).toEqual([true, false]);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("counts the Copilot identity resend under an Anthropic model", async () => {
	// `wrapFetchForCopilotFallback` resends a denied chat identity as the
	// Copilot CLI, below the client. The first call made two requests and
	// reported `0`.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const identities: (string | null)[] = [];
	serveRuntimeFetch(async (_url, init) => {
		identities.push(new Headers(init?.headers).get("copilot-integration-id"));
		return identities.length === 1
			? new Response('{"error":{"message":"client identity denied"}}', {
					status: 403,
					headers: { "content-type": "application/json" },
				})
			: sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});

	const result = await streamAnthropic(
		getBundledModel("github-copilot", "claude-opus-4.6") as Model<"anthropic-messages">,
		context,
		{ apiKey: "test-key", providerRetryWait: async () => {} },
	).result();

	expect(identities).toEqual(["copilot-chat", "copilot-developer-cli"]);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

function anthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const ANTHROPIC_EMPTY_STOP = [
	{
		type: "message_start",
		message: {
			id: "msg_probe",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

it.each<[string, () => AnthropicMessagesClientLike]>([
	[
		"its own AnthropicMessagesClient over its own fetch",
		() =>
			new AnthropicMessagesClient({
				apiKey: "test-key",
				baseURL: "https://api.anthropic.com",
				fetch: (async () => sseResponse(ANTHROPIC_THINKING_THEN_CUT)) as FetchImpl,
			}),
	],
	[
		"a client of its own making",
		() =>
			({
				messages: { create: async () => sseResponse(ANTHROPIC_THINKING_THEN_CUT) },
			}) as unknown as AnthropicMessagesClientLike,
	],
])("reports nothing for a caller-owned Anthropic client: %s", async (_label, makeClient) => {
	// The caller's client issues the requests through a transport this module
	// cannot see into, so it cannot say how often a request went out. `0` would
	// be a claim it cannot support.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

	const result = await streamAnthropic(anthropicModel(), context, {
		client: makeClient(),
		providerRetryWait: async () => {},
	}).result();

	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBeUndefined();
	tempDir.removeSync();
});

it("reports nothing for an Anthropic call made through a caller-supplied fetch", async () => {
	// A caller `fetch` sits below the counter: a resend inside it is invisible,
	// so a single counted call through it is not evidence of a single request.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	const callerFetch: FetchImpl = async () => {
		requests += 1;
		return sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	};

	const result = await streamAnthropic(anthropicModel(), context, {
		apiKey: "test-key",
		providerRetryWait: async () => {},
		fetch: callerFetch,
	}).result();

	expect(requests).toBe(1);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBeUndefined();
	tempDir.removeSync();
});

it("carries the count on a successful Anthropic response the caller may discard", async () => {
	// An empty completion is retried above this provider, so the attempts the
	// discarded response already spent have to travel with it.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async () => {
		requests += 1;
		return requests === 1 ? overloaded() : sseResponse(ANTHROPIC_EMPTY_STOP);
	});

	const result = await streamAnthropic(anthropicModel(), context, {
		apiKey: "test-key",
		acceptEmptyResponse: true,
		providerRetryWait: async () => {},
	}).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("stop");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

/** The request body's SHA-256; the bodies here sit under the compression floor, so they are sent as is. */
function bodyHash(init: RequestInit | undefined): string {
	return new Bun.CryptoHasher("sha256").update(String(init?.body ?? "")).digest("hex");
}

it("counts the request the authentication retry sent again under another key", async () => {
	// `streamSimple` resolves a second key after a 401 and calls the provider
	// again with the same request. Each call used to take its own snapshot of
	// the counter, so the second reported `0` for the second request of one
	// body — and earned a hold that sent the pair again.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const requests: { key: string | null; hash: string }[] = [];
	serveRuntimeFetch(async (_url, init) => {
		const key = new Headers(init?.headers).get("x-api-key");
		requests.push({ key, hash: bodyHash(init) });
		return key === "old-key"
			? new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}', {
					status: 401,
					headers: { "content-type": "application/json" },
				})
			: sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});

	const result = await streamSimple(localAnthropicModel(), context, {
		apiKey: ({ error }) => (error === undefined ? "old-key" : "new-key"),
		providerRetryWait: async () => {},
	}).result();

	expect(requests.map(request => request.key)).toEqual(["old-key", "new-key"]);
	expect(new Set(requests.map(request => request.hash)).size).toBe(1);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("counts the attempts an empty-completion retry discarded on the stream() path", async () => {
	// The replay-safe wrapper calls the provider again with the same options, so
	// the retried call counts into the request's counter and reports both.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async () => {
		requests += 1;
		return sseResponse(requests === 1 ? ANTHROPIC_EMPTY_STOP : ANTHROPIC_THINKING_THEN_CUT);
	});

	const result = await stream(localAnthropicModel(), context, {
		apiKey: "test-key",
		providerRetryWait: async () => {},
	}).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

/**
 * The same model at a plain-HTTP origin. On the `stream()` path `transportFetch`
 * sends `anthropic` requests to an `https:` origin through the Cowork transport
 * (`node:https`), past the replaced runtime `fetch`; at `http:` it hands them to
 * the runtime `fetch`, so the test answers them and nothing leaves the machine.
 */
function localAnthropicModel(): Model<"anthropic-messages"> {
	return { ...anthropicModel(), baseUrl: "http://anthropic.invalid" };
}

it("starts a new count for each call that reuses one built transport", async () => {
	// A transport is built once and handed to many calls; the count belongs to
	// the call. Kept on the transport, the second call reported the first
	// call's request as its own replay: [0, 1] for one request each.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const hashes: string[] = [];
	serveRuntimeFetch(async (_url, init) => {
		hashes.push(bodyHash(init));
		return sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});
	const model = localAnthropicModel();
	const shared = transportFetch(model, undefined);
	const ask = (content: string) =>
		stream(
			model,
			{ ...context, messages: [{ role: "user", content, timestamp: Date.now() }] },
			{ apiKey: "test-key", providerRetryWait: async () => {}, fetch: shared },
		).result();

	const first = await ask("first prompt");
	const second = await ask("second prompt");

	expect(hashes).toHaveLength(2);
	expect(new Set(hashes).size).toBe(2);
	expect([first.providerReplays, second.providerReplays]).toEqual([0, 0]);
	tempDir.removeSync();
});

it("keeps one count when a replay-safe wrapper calls stream() again", async () => {
	// The wrapper's counted fetch reaches `stream()`, whose transport keeps that
	// counter instead of treating it as a caller's opaque fetch: two requests of
	// one body report one replay, not unknown.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	serveRuntimeFetch(async () => {
		requests += 1;
		return sseResponse(requests === 1 ? ANTHROPIC_EMPTY_STOP : ANTHROPIC_THINKING_THEN_CUT);
	});
	const model = localAnthropicModel();

	const result = await withReplaySafeStreamRetry(
		model,
		context,
		{ apiKey: "test-key", providerRetryWait: async () => {}, acceptEmptyResponse: false },
		(attemptModel, attemptContext, attemptOptions) =>
			stream(attemptModel, attemptContext, { ...attemptOptions, acceptEmptyResponse: true }),
		{ retryEmptyCompletion: true },
	).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("error");
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});

it("does not count the Vertex OAuth token request as an attempt at the model request", async () => {
	// The token is minted over the same transport as the model request. Counted
	// with it, one model request reported one replay, and the hold never applied
	// on this route — on a process's first call and at every token refresh.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	const adcPath = `${tempDir.path()}/adc.json`;
	await Bun.write(
		adcPath,
		JSON.stringify({
			type: "authorized_user",
			client_id: "client-id",
			client_secret: "client-secret",
			refresh_token: "refresh-token",
		}),
	);
	const saved = Object.fromEntries(VERTEX_ENV.map(name => [name, Bun.env[name]]));
	for (const name of VERTEX_ENV) delete Bun.env[name];
	Bun.env.GOOGLE_CLOUD_PROJECT = "vertex-project";
	Bun.env.GOOGLE_VERTEX_LOCATION = "global";
	Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
	const calls: string[] = [];
	serveRuntimeFetch(async url => {
		if (url === "https://oauth2.googleapis.com/token") {
			calls.push("token");
			return new Response(JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }));
		}
		calls.push("model");
		return sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});
	try {
		__resetVertexTokenCache();
		const result = await stream(
			buildModel({
				id: "claude-sonnet-4@20250514",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "google-vertex",
				baseUrl:
					"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			}),
			context,
			{ apiKey: "<authenticated>", providerRetryWait: async () => {} },
		).result();

		expect(calls).toEqual(["token", "model"]);
		expect(result.stopReason).toBe("error");
		expect(result.providerReplays).toBe(0);
	} finally {
		__resetVertexTokenCache();
		for (const name of VERTEX_ENV) {
			if (saved[name] === undefined) delete Bun.env[name];
			else Bun.env[name] = saved[name];
		}
		tempDir.removeSync();
	}
});

const VERTEX_ENV = [
	"GOOGLE_CLOUD_PROJECT",
	"GCP_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_VERTEX_LOCATION",
	"GOOGLE_CLOUD_LOCATION",
	"VERTEX_LOCATION",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_ACCESS_TOKEN",
	"CLOUDSDK_AUTH_ACCESS_TOKEN",
] as const;

it("does not count a websocket request a busy socket sent the call away from", async () => {
	// One socket carries one request at a time, so a call that finds it busy is
	// routed to SSE without ever attempting a websocket request. Counting that
	// routing step told the concurrent call a replay had happened and suppressed
	// the hold its single request had earned.
	const tempDir = TempDir.createSync("@pi-provider-replays-");
	setAgentDir(tempDir.path());
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let websocketRequests = 0;
	let sseRequests = 0;
	const firstStreaming = Promise.withResolvers<void>();
	const wire = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request, server) => {
			if (server.upgrade(request)) return;
			await request.arrayBuffer();
			sseRequests += 1;
			return sseResponse(CODEX_THINKING_THEN_CUT);
		},
		websocket: {
			message(ws) {
				websocketRequests += 1;
				ws.send(JSON.stringify({ type: "response.created", response: { id: "busy" } }));
				firstStreaming.resolve();
			},
		},
	});
	const providerSessionState = new Map<string, ProviderSessionState>();
	const abort = new AbortController();
	const model = { ...codexModel(), baseUrl: `http://127.0.0.1:${wire.port}`, preferWebsockets: true };
	const shared = {
		apiKey: codexToken(),
		sessionId: crypto.randomUUID(),
		providerSessionState,
		preferWebsockets: true,
	};
	const first = streamOpenAICodexResponses(model, context, { ...shared, signal: abort.signal });
	try {
		await firstStreaming.promise;
		const second = await streamOpenAICodexResponses(model, context, shared).result();

		expect([websocketRequests, sseRequests]).toEqual([1, 1]);
		expect(second.stopReason).toBe("error");
		expect(second.providerReplays).toBe(0);
	} finally {
		abort.abort();
		await first.result();
		getCodexProviderSessionState(providerSessionState)?.close();
		wire.stop(true);
		tempDir.removeSync();
	}
}, 20_000);
