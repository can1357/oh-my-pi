/**
 * `streamProxy` rebuilds the AssistantMessage field by field from the proxy's
 * frames, so a field the proxy wire does not carry never reaches a consumer.
 * The failed attempt's response-header retry wait is read structured
 * (`errorRetryAfterMs`), never out of the error text, so a proxied failure
 * whose body says 200 ms while its upstream `Retry-After` said 9 s must still
 * read 9 s at every consumer: the message, `providerRetryWaitMs`, and a
 * one-shot retry whose cap is shorter than the wait.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import { type AssistantMessage, type Context, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { providerRetryWaitMs } from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A body that names a shorter wait than the header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";

interface ProxyServer {
	url: string;
	requests(): number;
	stop(): void;
}

const servers: ProxyServer[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

/** A real local proxy endpoint answering every `POST /api/stream` with `respond()`. */
function startProxy(respond: () => Response): ProxyServer {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			await req.text();
			requests++;
			return respond();
		},
	});
	const proxy = {
		url: `http://127.0.0.1:${server.port}`,
		requests: () => requests,
		stop: () => server.stop(true),
	};
	servers.push(proxy);
	return proxy;
}

function sse(frames: readonly unknown[]): Response {
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** The proxy server's terminal frame for an upstream failure, its wait given as `errorRetryAfterMs`. */
function failedTurn(errorRetryAfterMs: unknown): Response {
	return sse([
		{ type: "start" },
		{ type: "error", reason: "error", errorMessage: BODY_TEXT, errorRetryAfterMs, usage },
	]);
}

function runProxy(proxy: ProxyServer): Promise<AssistantMessage> {
	return streamProxy(model, context, { authToken: "proxy-token", proxyUrl: proxy.url }).result();
}

/** One-shot retry under a 1 s cap: a 9 s wait must end it after the first request. */
function retryUnderOneSecondCap(proxy: ProxyServer): Promise<AssistantMessage> {
	return retryTransientCompletion(() => runProxy(proxy), {
		provider: "anthropic",
		maxAttempts: 2,
		maxDelayMs: 1000,
		baseDelayMs: 1,
	});
}

describe("streamProxy — the failed attempt's header retry wait", () => {
	it("carries the terminal error frame's errorRetryAfterMs onto the message consumers read", async () => {
		const proxy = startProxy(() => failedTurn(9000));

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(BODY_TEXT);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
	});

	it("lets a one-shot retry capped below the proxied wait refuse to retry", async () => {
		const proxy = startProxy(() => failedTurn(9000));

		const message = await retryUnderOneSecondCap(proxy);

		expect(message.errorRetryAfterMs).toBe(9000);
		expect(proxy.requests()).toBe(1);
	});

	it("carries a zero wait as zero", async () => {
		const proxy = startProxy(() => failedTurn(0));

		const message = await runProxy(proxy);

		expect(message.errorRetryAfterMs).toBe(0);
	});

	it.each<[string, unknown]>([
		["a numeric string", "9000"],
		["a negative number", -1],
		["null, which JSON makes of NaN and Infinity", null],
		["an object", { ms: 9000 }],
		["a boolean", true],
	])("ignores %s in errorRetryAfterMs and reads only the text", async (_label, value) => {
		const proxy = startProxy(() => failedTurn(value));

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBeUndefined();
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(200);
	});

	it("reads the wait from a non-2xx proxy response's own Retry-After header", async () => {
		const proxy = startProxy(
			() =>
				new Response(JSON.stringify({ error: BODY_TEXT }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "9" },
				}),
		);

		const message = await retryUnderOneSecondCap(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(`Proxy error: ${BODY_TEXT}`);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
		expect(proxy.requests()).toBe(1);
	});

	it("leaves the wait unset for a non-2xx proxy response without a retry header", async () => {
		const proxy = startProxy(
			() =>
				new Response(JSON.stringify({ error: BODY_TEXT }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const message = await runProxy(proxy);

		expect(message.errorRetryAfterMs).toBeUndefined();
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(200);
	});
});
