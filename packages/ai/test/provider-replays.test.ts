/**
 * `AssistantMessage.providerReplays` is the count recovery above a provider
 * reads to decide whether a failed request was already re-sent. It has to hold
 * every request the call made, not the rungs one layer happens to own: a replay
 * `fetchWithRetry` made under the provider, or an attempt that never opened, is
 * a request the model saw, and a caller that cannot see it replays it again.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;
const originalAgentDir = getAgentDir();

afterEach(() => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
});

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

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
	const fetchMock = vi.fn(async (input: string | URL) => {
		if (String(input) !== "https://chatgpt.com/backend-api/codex/responses") {
			return new Response("not found", { status: 404 });
		}
		requests += 1;
		return requests === 1 ? overloaded() : sseResponse(CODEX_THINKING_THEN_CUT);
	});

	const result = await streamOpenAICodexResponses(codexModel(), context, {
		apiKey: codexToken(),
		preferWebsockets: false,
		fetch: fetchMock as FetchImpl,
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
	const fetchMock = vi.fn(async (input: string | URL) => {
		if (String(input) !== "https://chatgpt.com/backend-api/codex/responses") {
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
		fetch: fetchMock as FetchImpl,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(requests).toBeGreaterThan(1);
	expect(result.providerReplays).toBe(requests - 1);
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
	const fetchMock = vi.fn(async () => {
		requests += 1;
		return requests === 1 ? overloaded() : sseResponse(ANTHROPIC_THINKING_THEN_CUT);
	});

	const model: Model<"anthropic-messages"> = buildModel({
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

	const result = await streamAnthropic(model, context, {
		apiKey: "test-key",
		providerRetryWait: async () => {},
		fetch: fetchMock as FetchImpl,
	}).result();

	expect(requests).toBe(2);
	expect(result.stopReason).toBe("error");
	expect(result.content.some(block => block.type === "thinking")).toBe(true);
	expect(result.providerReplays).toBe(1);
	tempDir.removeSync();
});
