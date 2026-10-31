/**
 * A streamed request to a gateway chat format route (`stream: true` on
 * `/v1/messages`, `/v1/chat/completions`) whose upstream fails before it
 * accepted the request must answer as an HTTP failure carrying the upstream's
 * header retry wait (`retry-after-ms` / `Retry-After`), not as a `200` whose
 * in-band error text is all the client gets. omp's own providers always stream
 * and read that wait from response headers only, never from error text, so
 * this is the only way the upstream's 9 s reaches them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { STREAM_ACCEPT_HOLD_MAX_MS } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { providerRetryWaitMs } from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** A body that names a shorter wait than the header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";
const MODEL_ID = "claude-sonnet-4-5";
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const ANTHROPIC_SUCCESS_SSE = [
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	clearCustomApis();
});

interface Upstream {
	url: string;
	requests(): number;
}

/** A real local Anthropic Messages upstream that fails 429 `Retry-After: 9`, or streams "hello". */
function anthropicUpstream(outcome: "rate-limited" | "ok"): Upstream {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			await req.text();
			requests++;
			if (outcome === "ok") {
				return new Response(ANTHROPIC_SUCCESS_SSE, { headers: { "content-type": "text/event-stream" } });
			}
			return Response.json(
				{ type: "error", error: { type: "rate_limit_error", message: BODY_TEXT } },
				{ status: 429, headers: { "retry-after": "9" } },
			);
		},
	});
	cleanups.push(() => server.stop(true));
	return { url: `http://127.0.0.1:${server.port}`, requests: () => requests };
}

function anthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: MODEL_ID,
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as ModelSpec<"anthropic-messages">);
}

function openaiChatModel(baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: MODEL_ID,
		name: "Gateway chat",
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as ModelSpec<"openai-completions">);
}

/** A gateway (no bearer, so omp's Anthropic client's `x-api-key` passes) serving `model` with one upstream key. */
async function bootGateway(model: Model<Api>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-streamed-retry-after-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime(model.provider, "upstream-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => model,
		version: "test",
		fetch: (input, init) => fetch(input, init),
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return handle.url;
}

describe("auth-gateway streamed format routes — an upstream failure before it accepted the request", () => {
	it("answers omp's Anthropic client with the upstream's header wait", async () => {
		const upstream = anthropicUpstream("rate-limited");
		const gateway = await bootGateway(anthropicModel(upstream.url));

		const message = await streamSimple(anthropicModel(gateway), context, { apiKey: "client-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
		expect(upstream.requests()).toBe(1);
	});

	it("answers omp's OpenAI chat client with the upstream's header wait", async () => {
		const upstream = anthropicUpstream("rate-limited");
		const gateway = await bootGateway(anthropicModel(upstream.url));

		const message = await streamSimple(openaiChatModel(`${gateway}/v1`), context, {
			apiKey: "client-key",
			maxHttpAttempts: 1,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("openai", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
		expect(upstream.requests()).toBe(1);
	});

	it("streams an accepted upstream turn unchanged", async () => {
		const upstream = anthropicUpstream("ok");
		const gateway = await bootGateway(anthropicModel(upstream.url));

		const message = await streamSimple(anthropicModel(gateway), context, { apiKey: "client-key" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(upstream.requests()).toBe(1);
	});

	it("streams a turn whose upstream never reports its response, released by its first event", async () => {
		registerMockApi();
		const gateway = await bootGateway(
			createMockModel({ provider: "mock", id: MODEL_ID, handler: () => ({ content: ["hello"] }) }),
		);

		const response = await fetch(`${gateway}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(body).toContain('"content":"hello"');
		expect(body).toContain("data: [DONE]");
	});

	it("answers a failure before any content from an upstream that never reports its response, within the hold cap", async () => {
		registerMockApi();
		const gateway = await bootGateway(
			createMockModel({
				provider: "mock",
				id: MODEL_ID,
				handler: () => ({ stopReason: "error", errorMessage: BODY_TEXT, errorRetryAfterMs: 9000 }),
			}),
		);

		const response = await fetch(`${gateway}/v1/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: MODEL_ID,
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			}),
		});
		await response.text();

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.get("retry-after-ms")).toBe("9000");
		expect(response.headers.get("retry-after")).toBe("9");
	});

	it("commits the stream once the hold cap passes while an upstream that never reports its response is silent", async () => {
		registerMockApi();
		const releaseUpstream = Promise.withResolvers<void>();
		cleanups.push(() => releaseUpstream.resolve());
		const gateway = await bootGateway(
			createMockModel({
				provider: "mock",
				id: MODEL_ID,
				handler: async () => {
					await releaseUpstream.promise;
					return { content: ["hello"] };
				},
			}),
		);
		// The hold cap's timer elapses at once; every other timer keeps its delay.
		const realSetTimeout = globalThis.setTimeout;
		const timers = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((handler: (...handlerArgs: unknown[]) => void, delay?: number, ...args: unknown[]) =>
				realSetTimeout(handler, delay === STREAM_ACCEPT_HOLD_MAX_MS ? 0 : delay, ...args)) as typeof setTimeout);

		// Held headers would leave this fetch pending until the test times out.
		const response = await fetch(`${gateway}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		// The status line arrived while the upstream was still silent.
		expect(response.status).toBe(200);
		expect(timers.mock.calls.some(call => call[1] === STREAM_ACCEPT_HOLD_MAX_MS)).toBe(true);
		releaseUpstream.resolve();
		const body = await response.text();

		expect(body).toContain('"content":"hello"');
		expect(body).toContain("data: [DONE]");
	});
});
