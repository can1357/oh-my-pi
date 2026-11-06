/**
 * The auth gateway hands an upstream failure to its client over HTTP, so the
 * failed upstream attempt's header retry wait (`AssistantMessage.errorRetryAfterMs`,
 * or a thrown error's own headers) must cross that boundary as something the
 * client reads structured: response headers on an error response, and the
 * pi-native wire's own field on a streamed failure. The error text is never
 * the carrier — a body that says 200 ms while the header said 9 s must read 9 s
 * at the client, and the gateway must not turn body text into a header.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { retryTransientCompletion } from "@oh-my-pi/pi-ai/oneshot-retry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import {
	getHeadersFromError,
	getRetryAfterMsFromHeaders,
	providerRetryWaitMs,
} from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const GATEWAY_TOKEN = "gw-test-token";
const UPSTREAM_KEY = "upstream-key";
/** A body that names a shorter wait than the upstream header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";
const MODEL_ID = "retry-after-model";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	clearCustomApis();
});

interface Gateway {
	url: string;
	storage: AuthStorage;
	store: SqliteAuthCredentialStore;
	credentialId(): number;
}

/** A gateway serving `model` with one stored upstream API key. */
async function bootGateway(model: Model<Api>): Promise<Gateway> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-retry-after-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	const storage = new AuthStorage(store);
	await storage.credentials.set(model.provider, [{ type: "api_key", key: UPSTREAM_KEY }]);
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [GATEWAY_TOKEN],
		storage,
		resolveModel: () => model,
		version: "test",
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return {
		url: handle.url,
		storage,
		store,
		credentialId: () => {
			const row = store.listAuthCredentials(model.provider)[0];
			if (!row) throw new Error("expected a stored upstream credential");
			return row.id;
		},
	};
}

/** An upstream whose every turn fails with `failure`, as a provider's finalized error message. */
function failingUpstream(failure: Partial<MockResponse>): Model<Api> {
	registerMockApi();
	return createMockModel({
		provider: "mock",
		id: MODEL_ID,
		handler: () => ({ stopReason: "error", errorMessage: BODY_TEXT, ...failure }),
	});
}

/**
 * A model the gateway reaches over pi-native through a second gateway hop that
 * answers 429 `Retry-After: 9`: the upstream fails by throwing that response's
 * error, headers attached, instead of returning a message.
 */
function chainedThrowingUpstream(): Model<"anthropic-messages"> {
	const hop = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			await req.text();
			return Response.json(
				{ error: { type: "rate_limit_error", message: BODY_TEXT } },
				{ status: 429, headers: { "retry-after": "9" } },
			);
		},
	});
	cleanups.push(() => hop.stop(true));
	return buildModel({
		id: MODEL_ID,
		name: "Chained",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: `http://127.0.0.1:${hop.port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		transport: "pi-native",
	} as ModelSpec<"anthropic-messages">);
}

type RouteCase = [label: string, route: string, body: (modelId: string) => unknown];

const NON_STREAMING_ROUTES: RouteCase[] = [
	[
		"OpenAI chat completions",
		"/v1/chat/completions",
		model => ({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
	],
	[
		"Anthropic messages",
		"/v1/messages",
		model => ({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: false }),
	],
	["OpenAI responses", "/v1/responses", model => ({ model, input: "hi", stream: false })],
	["pi-native", "/v1/pi/stream", model => ({ modelId: model, context, stream: false })],
];

function postGateway(gateway: Gateway, route: string, body: unknown): Promise<Response> {
	return fetch(`${gateway.url}${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
		body: JSON.stringify(body),
	});
}

/**
 * A non-streaming client of a gateway route that, as the OpenAI and Anthropic
 * SDKs and omp's own HTTP error classes do, keeps a failed response's headers on
 * the error it throws. Counts its requests.
 */
function nonStreamingClient(
	gateway: Gateway,
	route: string,
	body: unknown,
): { run(): Promise<AssistantMessage>; requests(): number } {
	let requests = 0;
	return {
		run: async () => {
			requests++;
			const response = await postGateway(gateway, route, body);
			const text = await response.text();
			if (!response.ok) throw new ProviderHttpError(text, response.status, { headers: response.headers });
			throw new Error(`expected the gateway to fail, got ${response.status}`);
		},
		requests: () => requests,
	};
}

/** One-shot retry under a 1 s cap, returning what it finally threw. */
async function retryUnderOneSecondCap(run: () => Promise<AssistantMessage>): Promise<unknown> {
	try {
		await retryTransientCompletion(run, { provider: "mock", maxAttempts: 2, maxDelayMs: 1000, baseDelayMs: 1 });
	} catch (error) {
		return error;
	}
	throw new Error("expected the one-shot retry to surface the failure");
}

/** omp's pi-native client pointed at the gateway. */
function piNativeClient(gateway: Gateway): Model<"anthropic-messages"> {
	return buildModel({
		id: MODEL_ID,
		name: "Gateway pi-native",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: gateway.url,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		transport: "pi-native",
	} as ModelSpec<"anthropic-messages">);
}

async function readSseFrames(response: Response): Promise<unknown[]> {
	const text = await response.text();
	return text
		.split("\n\n")
		.filter(chunk => chunk.startsWith("data: ") && chunk !== "data: [DONE]")
		.map(chunk => JSON.parse(chunk.slice("data: ".length)) as unknown);
}

describe("auth-gateway — a failed upstream message's header retry wait", () => {
	it.each(NON_STREAMING_ROUTES)(
		"answers a failed non-streaming %s turn with the wait as retry headers",
		async (_label, route, body) => {
			const gateway = await bootGateway(failingUpstream({ errorRetryAfterMs: 9000 }));

			const response = await postGateway(gateway, route, body(MODEL_ID));
			await response.text();

			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.get("retry-after-ms")).toBe("9000");
			expect(response.headers.get("retry-after")).toBe("9");
		},
	);

	it.each(NON_STREAMING_ROUTES)(
		"names no wait on %s when the upstream headers named none, whatever the body says",
		async (_label, route, body) => {
			const gateway = await bootGateway(failingUpstream({}));

			const response = await postGateway(gateway, route, body(MODEL_ID));
			await response.text();

			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.get("retry-after-ms")).toBeNull();
			expect(response.headers.get("retry-after")).toBeNull();
		},
	);

	it("rounds Retry-After up to whole seconds and keeps the exact milliseconds", async () => {
		const gateway = await bootGateway(failingUpstream({ errorRetryAfterMs: 8500 }));

		const response = await postGateway(gateway, "/v1/chat/completions", NON_STREAMING_ROUTES[0][2](MODEL_ID));
		await response.text();

		expect(response.headers.get("retry-after-ms")).toBe("8500");
		expect(response.headers.get("retry-after")).toBe("9");
	});

	it.each(NON_STREAMING_ROUTES)(
		"lets a non-streaming %s client read the wait from the headers, so a 1 s one-shot cap refuses it",
		async (_label, route, body) => {
			const gateway = await bootGateway(failingUpstream({ errorRetryAfterMs: 9000 }));
			const client = nonStreamingClient(gateway, route, body(MODEL_ID));

			const failure = await retryUnderOneSecondCap(client.run);
			if (!(failure instanceof ProviderHttpError))
				throw new Error(`expected a ProviderHttpError, got ${String(failure)}`);
			const headerWaitMs = getRetryAfterMsFromHeaders(getHeadersFromError(failure));

			expect(headerWaitMs).toBe(9000);
			expect(providerRetryWaitMs("mock", failure.message, headerWaitMs)).toBe(9000);
			expect(client.requests()).toBe(1);
		},
	);

	it("leaves a non-streaming client the body's wait when the upstream headers named none, so it retries", async () => {
		const gateway = await bootGateway(failingUpstream({}));
		const client = nonStreamingClient(gateway, "/v1/chat/completions", NON_STREAMING_ROUTES[0][2](MODEL_ID));

		const failure = await retryUnderOneSecondCap(client.run);

		expect(getRetryAfterMsFromHeaders(getHeadersFromError(failure))).toBeUndefined();
		expect(client.requests()).toBe(2);
	});

	it("streams the whole failed message over pi-native, so omp's pi-native client reads the wait", async () => {
		const gateway = await bootGateway(failingUpstream({ errorRetryAfterMs: 9000 }));

		const message = await streamSimple(piNativeClient(gateway), context, { apiKey: GATEWAY_TOKEN }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
	});

	it("blocks the failed upstream credential for the header wait, not the body's", async () => {
		const gateway = await bootGateway(failingUpstream({ errorRetryAfterMs: 9000 }));
		const markReached = spyOn(gateway.storage.limits, "markReached");
		cleanups.push(() => markReached.mockRestore());

		const before = Date.now();
		const response = await postGateway(gateway, "/v1/chat/completions", NON_STREAMING_ROUTES[0][2](MODEL_ID));
		await response.text();
		const after = Date.now();

		expect(markReached.mock.calls.map(call => call[2]?.retryAfterMs)).toEqual([9000]);
		const blocks = gateway.store.listCredentialBlocks([gateway.credentialId()]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 9000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(after + 9000);
	});
});

describe("auth-gateway — a thrown upstream failure's header retry wait", () => {
	it.each(NON_STREAMING_ROUTES)(
		"answers a thrown non-streaming %s failure with its headers' wait",
		async (_label, route, body) => {
			const gateway = await bootGateway(chainedThrowingUpstream());

			const response = await postGateway(gateway, route, body(MODEL_ID));
			await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after-ms")).toBe("9000");
			expect(response.headers.get("retry-after")).toBe("9");
		},
	);

	it("puts the thrown failure's wait on the pi-native failure frame", async () => {
		const gateway = await bootGateway(chainedThrowingUpstream());

		const response = await postGateway(gateway, "/v1/pi/stream", { modelId: MODEL_ID, context, stream: true });
		const frames = await readSseFrames(response);

		expect(response.status).toBe(200);
		expect(frames.at(-1)).toEqual({
			type: "error",
			reason: "error",
			errorMessage: BODY_TEXT,
			errorRetryAfterMs: 9000,
		});
	});

	it("lets omp's pi-native client read a thrown failure's wait from the failure frame", async () => {
		const gateway = await bootGateway(chainedThrowingUpstream());

		const message = await streamSimple(piNativeClient(gateway), context, { apiKey: GATEWAY_TOKEN }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(BODY_TEXT);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(providerRetryWaitMs("anthropic", message.errorMessage, message.errorRetryAfterMs)).toBe(9000);
	});
});
