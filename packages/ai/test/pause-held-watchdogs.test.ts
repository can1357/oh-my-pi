import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { clearAwsCredentialCache } from "../src/providers/aws-credentials";
import { streamFactoryDroidGemini } from "../src/providers/factory-droid/gemini";
import { pollOpenAIResponsesResultForCompletion } from "../src/providers/openai-responses";
import { readOpenRouterGenerationError } from "../src/providers/openrouter-generation";
import { stream } from "../src/stream";
import type { Api, AssistantMessage, Context, FetchImpl, ModelSpec, OptionsForApi } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import { armPreResponseTimeout, preResponseGuard } from "../src/utils/idle-iterator";
import { transportFetch } from "../src/utils/transport-fetch";

/**
 * Finding 3 of the PR #17399 round-2 review: `/pause` parks a request on its
 * dispatch hold *inside* the transport, after the provider has armed its
 * watchdogs. Only the transport's pre-response guard stopped its clock there.
 * The shared stream watchdog `register-builtins` puts around Bedrock, Google,
 * Ollama, Cursor and Devin, and the plain `setTimeout` first-event timers of
 * Anthropic, the OpenAI providers and Factory's Gemini route, kept running, so
 * a pause longer than the first-event budget failed the request with a
 * timeout and zero wire calls instead of sending it on resume.
 *
 * Each case parks the request well past the budget, checks nothing failed and
 * nothing reached the wire, releases the hold, then lets the provider stall:
 * the request must reach the wire, and the stall must still be timed out.
 * Fake timers (Bun fakes `setTimeout`, `Date` and `AbortSignal.timeout`) drive
 * every watchdog without real waiting; the real `setImmediate` lets the async
 * chains between them run.
 */

const realSetImmediate = globalThis.setImmediate;
const BUDGET_MS = 1_000;

/** Lets every pending async chain run to its next timer or I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/** `/pause` engaged after the first `passes` holds: every later hold parks until `release`. */
function pauseAfter(passes: number) {
	let calls = 0;
	let parks = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		hold: (): Promise<void> | undefined => {
			calls++;
			if (open || calls <= passes) return undefined;
			parks++;
			parked.resolve();
			return gate.promise;
		},
		parked: parked.promise,
		/** Holds that parked; a watchdog firing during the pause shows up as a retry parking again. */
		get parks() {
			return parks;
		},
		release: () => {
			open = true;
			gate.resolve();
		},
	};
}

/** A request the provider accepted and never answers; it rejects only when its signal aborts. */
function stall(signal: AbortSignal | null | undefined): Promise<Response> {
	const pending = Promise.withResolvers<Response>();
	if (signal?.aborted) pending.reject(signal.reason);
	signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	return pending.promise;
}

/** A response whose headers arrived and whose body never sends an event. */
function silentBody(signal: AbortSignal | null | undefined): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
			},
		}),
	);
}

interface TrackedStream {
	/** The stream's final message, once it settles. */
	readonly settled: AssistantMessage | undefined;
}

function track(response: AssistantMessageEventStream): TrackedStream {
	let settled: AssistantMessage | undefined;
	void response.result().then(message => {
		settled = message;
	});
	return {
		get settled() {
			return settled;
		},
	};
}

/** Advances the clock a budget at a time until the stream settles, so retries and backoffs can play out. */
async function advanceUntilSettled(tracked: TrackedStream): Promise<void> {
	for (let step = 0; step < 40 && !tracked.settled; step++) {
		vi.advanceTimersByTime(BUDGET_MS);
		await settle();
	}
}

function urlOf(input: string | URL | Request): string {
	return input instanceof Request ? input.url : String(input);
}

const common = {
	name: "held watchdog fixture",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};
const context: Context = { systemPrompt: ["test"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const devinAuth = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));

interface HeldCase {
	name: string;
	spec: ModelSpec<Api>;
	options: Record<string, unknown>;
	/** Answers traffic that is not the inference request (session tokens, Cursor appends). */
	answer?: (url: string) => Response | undefined;
	/** How the inference request stalls once it is out; defaults to never answering. */
	stalled?: (signal: AbortSignal | null | undefined) => Promise<Response> | Response;
	/** Checked against the inference request's URL. */
	wireUrl?: RegExp;
	/** The provider's own keepalives also park on the hold (Cursor's 5 s heartbeat appends). */
	heartbeats?: boolean;
}

const cases: HeldCase[] = [
	{
		name: "Bedrock",
		spec: {
			...common,
			id: "amazon.nova-lite-v1:0",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		},
		options: { bearerToken: "fake" },
		wireUrl: /converse-stream$/,
	},
	{
		name: "Bedrock compaction",
		spec: {
			...common,
			id: "anthropic.claude-sonnet-4-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			compat: { supportsServerCompaction: true },
		},
		options: { bearerToken: "fake", anthropicCompaction: {} },
		wireUrl: /invoke-with-response-stream$/,
	},
	{
		name: "Google shared",
		spec: {
			...common,
			id: "gemini-3-flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.example/v1beta",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Google Vertex",
		spec: {
			...common,
			id: "gemini-2.5-flash",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://vertex.example",
		},
		options: { apiKey: "fake", project: "p", location: "us-central1" },
	},
	{
		name: "Ollama",
		spec: {
			...common,
			id: "llama-local",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Anthropic",
		spec: {
			...common,
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.example",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "OpenAI completions",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.example/v1",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "OpenAI responses",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.example/v1",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Azure OpenAI responses",
		spec: {
			...common,
			id: "gpt-4o-mini",
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://held.openai.azure.com/openai/v1",
		},
		options: { apiKey: "fake" },
	},
	{
		name: "Devin",
		spec: {
			...common,
			id: "devin-test",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.example",
		},
		options: { apiKey: "fake" },
		answer: url => (url.includes("GetUserJwt") ? new Response(devinAuth) : undefined),
	},
	{
		name: "Cursor HTTP/1",
		spec: {
			...common,
			id: "claude-sonnet-4",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "http://cursor.example",
		},
		options: { apiKey: "fake", transport: "http1" },
		answer: url => (url.includes("BidiAppend") ? new Response(null) : undefined),
		stalled: silentBody,
		wireUrl: /RunSSE$/,
		heartbeats: true,
	},
];

describe("held time is excluded from every watchdog before the wire", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	for (const entry of cases) {
		it(`${entry.name}: a pause past the first-event budget sends the request on resume, and a stall after it still times out`, async () => {
			const pause = pauseAfter(1);
			const wireUrls: string[] = [];
			let abortedAtWire = false;
			const wired = Promise.withResolvers<void>();
			const fetch: FetchImpl = async (input, init) => {
				const url = urlOf(input);
				const answered = entry.answer?.(url);
				if (answered) return answered;
				wireUrls.push(url);
				abortedAtWire ||= init?.signal?.aborted ?? false;
				wired.resolve();
				return (entry.stalled ?? stall)(init?.signal);
			};
			const tracked = track(
				stream(buildModel(entry.spec), context, {
					...entry.options,
					streamFirstEventTimeoutMs: BUDGET_MS,
					streamIdleTimeoutMs: BUDGET_MS,
					maxHttpAttempts: 1,
					maxRetryDelayMs: 1,
					providerRetryWait: async () => {},
					beforeDispatch: pause.hold,
					fetch,
				} as OptionsForApi<Api>),
			);

			await pause.parked;
			vi.advanceTimersByTime(BUDGET_MS * 10);
			await settle();
			const parks = pause.parks;
			vi.advanceTimersByTime(BUDGET_MS * 10);
			await settle();
			expect(tracked.settled?.errorMessage).toBeUndefined();
			expect(wireUrls).toEqual([]);
			// A watchdog that fired during the pause would have re-dispatched a retry.
			if (!entry.heartbeats) expect(pause.parks).toBe(parks);

			pause.release();
			await wired.promise;
			expect(abortedAtWire).toBe(false);
			if (entry.wireUrl) expect(wireUrls[0]).toMatch(entry.wireUrl);

			await advanceUntilSettled(tracked);
			expect(tracked.settled?.stopReason).toBe("error");
			expect(tracked.settled?.errorMessage).toMatch(/timed out|stalled/i);
		});
	}

	it("Factory Gemini: the end-to-end first-event budget skips the hold and still bounds the first chunk", async () => {
		const pause = pauseAfter(0);
		let wires = 0;
		const wired = Promise.withResolvers<void>();
		const model = buildModel({
			...common,
			id: "gemini-3-pro",
			api: "factory-droid-agent",
			provider: "factory-droid",
			baseUrl: "https://factory.example",
		});
		const fetch = transportFetch(
			model,
			async (_input, init) => {
				wires++;
				wired.resolve();
				return silentBody(init?.signal);
			},
			pause.hold,
		);
		const tracked = track(
			streamFactoryDroidGemini(model, context, {
				baseUrl: "https://factory.example/api/llm/g/v1",
				headers: {},
				streamFirstEventTimeoutMs: BUDGET_MS,
				streamIdleTimeoutMs: BUDGET_MS,
				fetch,
			}),
		);

		await pause.parked;
		vi.advanceTimersByTime(BUDGET_MS * 10);
		await settle();
		expect(tracked.settled?.errorMessage).toBeUndefined();
		expect(wires).toBe(0);

		pause.release();
		await wired.promise;
		await advanceUntilSettled(tracked);
		expect(tracked.settled?.stopReason).toBe("error");
		expect(tracked.settled?.errorMessage).toMatch(/stalled/i);
	});
});

/** Cursor's HTTP/2 transport holds by itself, just before `client.request` puts the turn's HEADERS on the wire. */
describe("Cursor HTTP/2: held time is excluded from the stream watchdog", () => {
	let server: http2.Http2Server | undefined;
	const sessions = new Set<http2.Http2Session>();

	afterEach(async () => {
		vi.useRealTimers();
		for (const session of sessions) session.destroy();
		sessions.clear();
		const closing = server;
		server = undefined;
		if (!closing) return;
		const closed = Promise.withResolvers<void>();
		closing.close(() => closed.resolve());
		await closed.promise;
	});

	it("sends the turn on resume and still times out a server that then goes silent", async () => {
		let requests = 0;
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (providerStream: http2.ServerHttp2Stream) => {
			requests++;
			providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected an HTTP/2 fixture address");

		vi.useFakeTimers();
		const pause = pauseAfter(1);
		const tracked = track(
			stream(
				buildModel({
					...common,
					id: "claude-sonnet-4",
					api: "cursor-agent",
					provider: "cursor",
					baseUrl: `http://127.0.0.1:${address.port}`,
				}),
				context,
				{
					apiKey: "fake",
					transport: "http2",
					streamFirstEventTimeoutMs: BUDGET_MS,
					streamIdleTimeoutMs: BUDGET_MS,
					providerRetryWait: async () => {},
					beforeDispatch: pause.hold,
				} as OptionsForApi<Api>,
			),
		);

		await pause.parked;
		vi.advanceTimersByTime(BUDGET_MS * 10);
		await settle();
		expect(tracked.settled?.errorMessage).toBeUndefined();
		expect(requests).toBe(0);

		pause.release();
		while (requests === 0) await settle();
		await advanceUntilSettled(tracked);
		expect(tracked.settled?.stopReason).toBe("error");
		expect(tracked.settled?.errorMessage).toMatch(/timed out/i);
	});
});

/** Held follow-up requests whose own absolute budgets used to run through the hold. */
describe("held follow-up requests keep their budgets off the hold", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const responsesModel = buildModel({
		...common,
		id: "gpt-4o-mini",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.example/api/v1",
	});

	it("a stored-result poll held past its attempt timeout and the recovery deadline still adopts the result", async () => {
		const pause = pauseAfter(0);
		const fetchImpl = transportFetch(
			responsesModel,
			async () => new Response(JSON.stringify({ id: "resp_held", status: "completed", output: [] })),
			pause.hold,
		);
		let adopted: Record<string, unknown> | undefined;
		let done = false;
		void pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url: "https://openrouter.example/api/v1/responses/resp_held",
			headers: {},
			responseId: "resp_held",
			wait: async () => {},
		}).then(result => {
			adopted = result;
			done = true;
		});

		await pause.parked;
		vi.advanceTimersByTime(10 * 60_000);
		await settle();
		pause.release();
		while (!done) await settle();
		expect(adopted).toMatchObject({ id: "resp_held", status: "completed" });
	});

	it("an OpenRouter generation lookup held past its 2 s budget still reads the native failure", async () => {
		const pause = pauseAfter(0);
		const fetch = transportFetch(
			responsesModel,
			async () =>
				new Response(JSON.stringify({ data: { id: "gen_held", native_finish_reason: "MALFORMED_FUNCTION_CALL" } })),
			pause.hold,
		);
		let found: string | undefined;
		let done = false;
		void readOpenRouterGenerationError({
			baseUrl: "https://openrouter.example/api/v1",
			headers: {},
			responseId: "gen_held",
			fetch,
			signal: new AbortController().signal,
		}).then(result => {
			found = result;
			done = true;
		});

		await pause.parked;
		vi.advanceTimersByTime(10_000);
		await settle();
		pause.release();
		while (!done) await settle();
		expect(found).toContain("gen_held");
	});
});

/**
 * Credential and token lookups are a request's prerequisites, not inference
 * traffic: they go out unheld under their own absolute budgets, and only the
 * inference request holds at the wire.
 */
describe("credential lookups are not held", () => {
	const AWS_ENV = {
		AWS_ACCESS_KEY_ID: undefined,
		AWS_SECRET_ACCESS_KEY: undefined,
		AWS_SESSION_TOKEN: undefined,
		AWS_PROFILE: undefined,
		AWS_BEARER_TOKEN_BEDROCK: undefined,
		AWS_BEDROCK_SKIP_AUTH: undefined,
		AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
		AWS_ROLE_ARN: undefined,
		AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
		AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
		AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
		AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/pause-held-watchdogs/credentials",
		AWS_CONFIG_FILE: "/nonexistent/pause-held-watchdogs/config",
		AWS_EC2_METADATA_DISABLED: "true",
		AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9911/credentials",
	};
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const [key, value] of Object.entries(AWS_ENV)) {
			saved.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearAwsCredentialCache();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		clearAwsCredentialCache();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
	});

	it("a pause longer than the credential budget does not fail Bedrock's credential lookup", async () => {
		const pause = pauseAfter(1);
		let credentialLookups = 0;
		const authorizations: string[] = [];
		const wired = Promise.withResolvers<void>();
		const fetch: FetchImpl = async (input, init) => {
			if (urlOf(input).endsWith("/credentials")) {
				credentialLookups++;
				return Response.json({
					AccessKeyId: "AKIDHELD",
					SecretAccessKey: "secret",
					Token: "session",
					Expiration: new Date(Date.now() + 3_600_000).toISOString(),
				});
			}
			authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
			wired.resolve();
			return new Response("probe terminal", { status: 400 });
		};
		const tracked = track(
			stream(
				buildModel({
					...common,
					id: "amazon.nova-lite-v1:0",
					api: "bedrock-converse-stream",
					provider: "amazon-bedrock",
					baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				}),
				context,
				{
					streamFirstEventTimeoutMs: 600_000,
					maxHttpAttempts: 1,
					beforeDispatch: pause.hold,
					fetch,
				} as OptionsForApi<Api>,
			),
		);

		await pause.parked;
		// Past the 30 s shared credential budget, with the gate still closed.
		vi.advanceTimersByTime(60_000);
		await settle();
		expect(credentialLookups).toBe(1);
		expect(authorizations).toEqual([]);
		expect(tracked.settled?.errorMessage).toBeUndefined();

		pause.release();
		await wired.promise;
		expect(authorizations[0]).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDHELD/");
	});
});

/** The guard reports the time it excludes to the stream watchdog and to any guard enclosing it. */
describe("armPreResponseTimeout held-time reporting", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports exactly the suspended window to `heldWork`, once, and never leaves it open", async () => {
		vi.useFakeTimers();
		const heldWork = new AssistantMessageEventStream();
		const { signal, clear } = armPreResponseTimeout(undefined, 100, heldWork);
		const guard = preResponseGuard(signal);
		expect(heldWork.hasPendingLocalWork).toBe(false);
		guard?.suspend();
		guard?.suspend();
		expect(heldWork.hasPendingLocalWork).toBe(true);
		vi.advanceTimersByTime(5_000);
		guard?.resume();
		await settle();
		expect(heldWork.hasPendingLocalWork).toBe(false);
		expect(heldWork.localWorkSettledAt).toBe(Date.now());
		// The provider's latency after the wire is not held time.
		vi.advanceTimersByTime(99);
		expect(signal?.aborted).toBe(false);
		expect(heldWork.hasPendingLocalWork).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		clear();
	});

	it("closes the held window when the request fails or is cancelled while held", async () => {
		const failed = new AssistantMessageEventStream();
		const first = armPreResponseTimeout(undefined, 100, failed);
		preResponseGuard(first.signal)?.suspend();
		first.clear();
		await settle();
		expect(failed.hasPendingLocalWork).toBe(false);

		const cancelled = new AssistantMessageEventStream();
		const caller = new AbortController();
		const second = armPreResponseTimeout(caller.signal, 100, cancelled);
		preResponseGuard(second.signal)?.suspend();
		caller.abort();
		await settle();
		expect(cancelled.hasPendingLocalWork).toBe(false);
		second.clear();
	});

	it("stops and restarts an enclosing guard with the one the transport sees", () => {
		vi.useFakeTimers();
		const outer = armPreResponseTimeout(undefined, 100);
		const inner = armPreResponseTimeout(outer.signal, 1_000);
		const innerGuard = preResponseGuard(inner.signal);
		vi.advanceTimersByTime(40);
		innerGuard?.suspend();
		vi.advanceTimersByTime(10_000);
		expect(outer.signal?.aborted).toBe(false);
		innerGuard?.resume();
		vi.advanceTimersByTime(59);
		expect(outer.signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(outer.signal?.aborted).toBe(true);
		expect(inner.signal?.aborted).toBe(true);
		inner.clear();
		outer.clear();
	});

	it("restarts an enclosing guard when an attempt it stopped is cleared without reaching the wire", () => {
		vi.useFakeTimers();
		const outer = armPreResponseTimeout(undefined, 100);
		const inner = armPreResponseTimeout(outer.signal, 1_000);
		preResponseGuard(inner.signal)?.suspend();
		vi.advanceTimersByTime(10_000);
		inner.clear();
		vi.advanceTimersByTime(99);
		expect(outer.signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(outer.signal?.aborted).toBe(true);
		outer.clear();
	});
});
