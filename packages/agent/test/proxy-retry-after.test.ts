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
import * as http from "node:http";
import type { Socket } from "node:net";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import { type AssistantMessage, type Context, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
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

/** The proxy server's terminal frame for an upstream failure and its structured retry outcome fields. */
function failedTurn(errorRetryAfterMs: unknown, errorRetryWaitRefusal?: unknown): Response {
	return sse([
		{ type: "start" },
		{
			type: "error",
			reason: "error",
			errorMessage: BODY_TEXT,
			errorRetryAfterMs,
			errorRetryWaitRefusal,
			usage,
		},
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

	it("carries a complete refused retry wait and drops malformed relay data", async () => {
		const refusal = {
			waitMs: 15_000,
			limitMs: 10_000,
			option: "providerRetryWaitCeilingMs",
		} as const;
		const valid = await runProxy(startProxy(() => failedTurn(undefined, refusal)));
		const malformed = await runProxy(
			startProxy(() => failedTurn(undefined, { ...refusal, waitMs: refusal.limitMs })),
		);

		expect(valid.errorRetryWaitRefusal).toEqual(refusal);
		expect(malformed.errorRetryWaitRefusal).toBeUndefined();
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

/**
 * A real `node:http` proxy that accepts (`200`) with `headers`, sends the start
 * of a stream with no terminal frame, then destroys the socket: the cut a
 * provider reports with its accepted response's explicit wait.
 */
async function startCuttingProxy(headers: Record<string, string>): Promise<ProxyServer> {
	let requests = 0;
	const sockets = new Set<Socket>();
	const body = [
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: "partial answer" },
	]
		.map(frame => `data: ${JSON.stringify(frame)}\n\n`)
		.join("");
	const server = http.createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream", ...headers });
			response.write(body, () => request.socket.destroy());
		});
	});
	server.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const { promise: listening, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolve);
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("expected a TCP proxy address");
	const proxy = {
		url: `http://127.0.0.1:${address.port}`,
		requests: () => requests,
		stop: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
	servers.push(proxy);
	return proxy;
}

describe("streamProxy — a stream the proxy cut after accepting it", () => {
	it.each<[string, Record<string, string>]>([
		["Retry-After: 9", { "retry-after": "9" }],
		["retry-after-ms: 9000", { "retry-after-ms": "9000" }],
	])("reads the accepted response's %s", async (_label, headers) => {
		const proxy = await startCuttingProxy(headers);

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(proxy.requests()).toBe(1);
	});

	it("never reads an accepted response's x-ratelimit-reset as a wait", async () => {
		const proxy = await startCuttingProxy({ "x-ratelimit-reset-ms": "9000", "x-ratelimit-reset": "9" });

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBeUndefined();
	});

	it("leaves the wait unset when the accepted response named none", async () => {
		const proxy = await startCuttingProxy({});

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBeUndefined();
	});
});

/**
 * The rebuild must keep every outcome field the proxy's terminal frame sends,
 * not only the ones it happens to name: `errorStatus` decides whether a cut is
 * a status failure, `errorId` carries the provider's classification, and
 * `providerReplays` is how recovery and a replay budget learn that a request
 * already went out more than once.
 */
describe("streamProxy — every outcome field on the terminal frame", () => {
	it("keeps a failed turn's status, classification, replay count and other outcome fields", async () => {
		const errorId = AIError.classify(new Error("read ECONNRESET"));
		const proxy = startProxy(() =>
			sse([
				{ type: "start" },
				{
					type: "error",
					reason: "error",
					errorMessage: "read ECONNRESET",
					errorStatus: 429,
					errorId,
					providerReplays: 0,
					errorClassificationMessage: "read ECONNRESET",
					disabledFeatures: ["priority"],
					duration: 12.5,
					usage,
				},
			]),
		);

		const message = await runProxy(proxy);

		expect(message.errorStatus).toBe(429);
		expect(message.errorId).toBe(errorId);
		expect(message.providerReplays).toBe(0);
		expect(message.errorClassificationMessage).toBe("read ECONNRESET");
		expect(message.disabledFeatures).toEqual(["priority"]);
		expect(message.duration).toBe(12.5);
		// A consumer: the upstream's 429 keeps this cut off the connection lane.
		expect(AIError.is(AIError.classifyMessage(message), AIError.Flag.Connection)).toBe(false);
	});

	it("keeps a finished turn's replay count and other outcome fields", async () => {
		const proxy = startProxy(() =>
			sse([
				{ type: "start" },
				{
					type: "done",
					reason: "stop",
					providerReplays: 2,
					duration: 40,
					ttft: 7,
					usage,
					content: [{ type: "text", text: "ok" }],
				},
			]),
		);

		const message = await runProxy(proxy);

		expect(message.stopReason).toBe("stop");
		expect(message.providerReplays).toBe(2);
		expect(message.duration).toBe(40);
		expect(message.ttft).toBe(7);
	});

	it.each<[string, Record<string, unknown>]>([
		["a status that is a string", { errorStatus: "429" }],
		["a status outside 100-599", { errorStatus: 42 }],
		["a negative replay count", { providerReplays: -1 }],
		["a fractional replay count", { providerReplays: 1.5 }],
		["a classification that is a string", { errorId: "7" }],
	])("drops %s", async (_label, fields) => {
		const proxy = startProxy(() =>
			sse([
				{ type: "start" },
				{ type: "error", reason: "error", errorMessage: "read ECONNRESET", usage, ...fields },
			]),
		);

		const message = await runProxy(proxy);

		for (const key of Object.keys(fields)) expect(message[key as keyof AssistantMessage]).toBeUndefined();
	});

	it("keeps the identity the client asked for, whatever the frame says", async () => {
		const proxy = startProxy(() =>
			sse([
				{ type: "start" },
				{
					type: "error",
					reason: "error",
					errorMessage: "read ECONNRESET",
					role: "user",
					model: "another-model",
					provider: "another-provider",
					api: "openai-completions",
					timestamp: 1,
					usage,
				},
			]),
		);

		const message = await runProxy(proxy);

		expect(message.role).toBe("assistant");
		expect(message.model).toBe(model.id);
		expect(message.provider).toBe(model.provider);
		expect(message.api).toBe(model.api);
		expect(message.timestamp).not.toBe(1);
	});
});

describe("streamProxy — the caller's retry bounds", () => {
	it("sends maxRetryDelayMs and providerRetryWaitCeilingMs, so the server's provider retries keep to them", async () => {
		// The server runs the provider, and so every retry sleep: without the
		// bounds on the wire it slept up to its own default, silently.
		const sent: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				sent.push(await req.json());
				return sse([{ type: "start" }, { type: "done", reason: "stop", usage }]);
			},
		});
		try {
			await streamProxy(model, context, {
				authToken: "proxy-token",
				proxyUrl: `http://127.0.0.1:${server.port}`,
				maxRetryDelayMs: 300_000,
				providerRetryWaitCeilingMs: 10_000,
			}).result();
		} finally {
			server.stop(true);
		}

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ options: { maxRetryDelayMs: 300_000, providerRetryWaitCeilingMs: 10_000 } });
	});
});
