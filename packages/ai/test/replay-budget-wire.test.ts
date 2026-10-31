/**
 * `StreamOptions.replayBudgetMs` against a real local route that cuts every
 * request before a response header, the way the finding was measured: request
 * counts and elapsed time, with and without a budget, on each lane that replays.
 *
 * The no-budget arm is today's ceiling and must not move. Its waits are
 * recorded instead of slept — with no budget nothing reads the clock, so the
 * count is exact and the recorded waits are the elapsed time minus round trips.
 * The budget arm sleeps for real, because the budget is a wall-clock promise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { scheduler } from "node:timers/promises";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	pollOpenAIResponsesResultForCompletion,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ReplayBudget } from "@oh-my-pi/pi-ai/utils/replay-budget";
import { resetRequestCompressionForTesting } from "@oh-my-pi/pi-ai/utils/request-compression";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface Route {
	url: string;
	requests(): number;
	stop(): void;
}

/** A TCP endpoint that reads each request and closes the connection before writing a byte. */
function cutBeforeHeaders(): Route {
	let requests = 0;
	const server = Bun.listen<{ counted: boolean }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { counted: false };
			},
			data(socket) {
				if (!socket.data.counted) {
					socket.data.counted = true;
					requests += 1;
				}
				socket.end();
			},
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests: () => requests, stop: () => server.stop(true) };
}

/** The HTTP/2 equivalent for Cursor: every stream is reset before a response header. */
async function resetBeforeHeaders(): Promise<Route> {
	let requests = 0;
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", stream => {
		requests += 1;
		// Closing with an error code makes the fixture's own stream emit it.
		stream.on("error", () => {});
		stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected an HTTP/2 fixture address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests: () => requests,
		stop: () => {
			for (const session of sessions) session.destroy();
			server.close();
		},
	};
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

interface CallOptions {
	replayBudgetMs?: number;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	onPayload?: (payload: unknown) => unknown;
	signal?: AbortSignal;
	maxHttpAttempts?: number;
}

interface Lane {
	name: string;
	/** Requests one call makes against the cutting route with no budget: today's ceiling. */
	ceiling: number;
	route(): Route | Promise<Route>;
	call(url: string, options: CallOptions): Promise<AssistantMessage>;
}

const lanes: Lane[] = [
	{
		name: "anthropic",
		// The provider loop's ten replays; its client's own budget is pinned to zero.
		ceiling: 11,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamAnthropic(
				buildModel({
					id: "claude-sonnet-4-5",
					name: "Claude Sonnet 4.5",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 200_000,
					maxTokens: 8_192,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
	{
		name: "openai-completions",
		// Six `fetchWithRetry` attempts, twice: the replay-safe wrapper replays the failure once.
		ceiling: 12,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamOpenAICompletions(
				buildModel({
					id: "wire-model",
					name: "Wire model",
					api: "openai-completions",
					provider: "wire",
					baseUrl: `${url}/v1`,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
	{
		name: "openai-responses",
		// Six `fetchWithRetry` attempts; the wrapper replays only empty completions here.
		ceiling: 6,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamOpenAIResponses(
				buildModel({
					id: "gpt-5-mini",
					name: "GPT-5 Mini",
					api: "openai-responses",
					provider: "wire",
					baseUrl: `${url}/v1`,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 400_000,
					maxTokens: 128_000,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
	{
		name: "azure-openai-responses",
		ceiling: 12,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamAzureOpenAIResponses(
				buildModel({
					id: "gpt-5-mini",
					name: "GPT-5 Mini",
					api: "azure-openai-responses",
					provider: "azure",
					baseUrl: `${url}/openai/v1`,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 400_000,
					maxTokens: 128_000,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
	{
		name: "ollama",
		// Five `fetchWithRetry` attempts; the wrapper replays only empty completions here.
		ceiling: 5,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamOllama(
				buildModel({
					id: "qwen3:8b",
					name: "Qwen 3 8B",
					api: "ollama-chat",
					provider: "ollama",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 32_768,
					maxTokens: 8_192,
				}),
				context,
				{ apiKey: "ollama", ...options },
			).result(),
	},
	{
		name: "bedrock",
		ceiling: 5,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamBedrock(
				buildModel({
					id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
					name: "Haiku",
					api: "bedrock-converse-stream",
					provider: "amazon-bedrock",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 200_000,
					maxTokens: 8_192,
				}),
				context,
				{ bearerToken: "test-token", ...options },
			).result(),
	},
	{
		name: "google-gemini-cli",
		ceiling: 4,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamGoogleGeminiCli(
				buildModel({
					id: "gemini-2.5-pro",
					name: "Gemini 2.5 Pro",
					api: "google-gemini-cli",
					provider: "google-gemini-cli",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 1_000_000,
					maxTokens: 8_192,
				}),
				context,
				{ apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }), ...options },
			).result(),
	},
	{
		name: "openai-codex-responses",
		// Six pre-response attempts; the failure never reaches the stream loop's own rungs.
		ceiling: 6,
		route: cutBeforeHeaders,
		call: (url, options) =>
			streamOpenAICodexResponses(
				buildModel({
					id: "gpt-5.1-codex",
					name: "GPT-5.1 Codex",
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: url,
					reasoning: true,
					preferWebsockets: false,
					input: ["text"],
					cost,
					contextWindow: 400_000,
					maxTokens: 128_000,
				}),
				context,
				{ apiKey: codexToken(), preferWebsockets: false, ...options },
			).result(),
	},
	{
		name: "cursor",
		// The first request and five checkpoint replays.
		ceiling: 6,
		route: resetBeforeHeaders,
		call: (url, options) =>
			streamCursor(
				buildModel({
					id: "cursor-wire-fixture",
					name: "Cursor wire fixture",
					api: "cursor-agent",
					provider: "cursor",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 1,
					maxTokens: 1,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
];

let agentDir: TempDir | undefined;
const originalAgentDir = getAgentDir();

beforeEach(() => {
	agentDir = TempDir.createSync("@pi-replay-budget-");
	setAgentDir(agentDir.path());
});

afterEach(() => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	agentDir?.removeSync();
	agentDir = undefined;
});

/** Records every retry wait a call asks for and returns at once. */
function recordWaits(): { waits: number[]; providerRetryWait: (delayMs: number) => Promise<void> } {
	const waits: number[] = [];
	vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs?: number) => {
		waits.push(delayMs ?? 0);
	});
	return {
		waits,
		providerRetryWait: async delayMs => {
			waits.push(delayMs);
		},
	};
}

const BUDGET_MS = 1_000;
/**
 * Slack on top of a budget for the time a loaded machine adds to one call (event-loop
 * stalls, connection setup). The alternative each bound separates from is the provider's
 * own ceiling or a server's 30 s wait, so a few seconds of slack keeps the property decisive.
 */
const ROUND_TRIP_SLACK_MS = 3_000;
/** Per-test timeout for a test that makes a dozen real requests. */
const LOADED_TEST_TIMEOUT_MS = 60_000;

describe.each(lanes)("$name against a route that cuts every request before headers", lane => {
	it(
		"keeps today's ceiling and marks nothing when no budget is set",
		async () => {
			const route = await lane.route();
			try {
				const { waits, providerRetryWait } = recordWaits();
				const result = await lane.call(route.url, { providerRetryWait });

				expect(result.stopReason).toBe("error");
				expect(route.requests()).toBe(lane.ceiling);
				expect(waits.length).toBeGreaterThan(0);
				expect(result.replayBudgetExhausted).toBeUndefined();
			} finally {
				route.stop();
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);

	it(
		"returns inside the budget, with fewer requests, and says the budget stopped it",
		async () => {
			const route = await lane.route();
			try {
				const started = performance.now();
				const result = await lane.call(route.url, { replayBudgetMs: BUDGET_MS });
				const elapsedMs = performance.now() - started;

				expect(result.stopReason).toBe("error");
				expect(route.requests()).toBeGreaterThan(0);
				expect(route.requests()).toBeLessThan(lane.ceiling);
				expect(elapsedMs).toBeLessThan(BUDGET_MS + ROUND_TRIP_SLACK_MS);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);

	it(
		"reaches the provider's own ceiling, unmarked, when the budget never runs short",
		async () => {
			const route = await lane.route();
			try {
				const { providerRetryWait } = recordWaits();
				const result = await lane.call(route.url, { replayBudgetMs: 600_000, providerRetryWait });

				expect(route.requests()).toBe(lane.ceiling);
				expect(result.replayBudgetExhausted).toBeUndefined();
			} finally {
				route.stop();
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);

	// A replay is admitted before its wait; a wait that wakes late — a busy event
	// loop, a slow wait hook — must not launch the request past the deadline.
	// Each wait here advances the clock five seconds beyond what it asked for.
	it(
		"does not send the next request when its wait overran the budget, and says so",
		async () => {
			const route = await lane.route();
			const realNow = performance.now.bind(performance);
			let lateBy = 0;
			vi.spyOn(performance, "now").mockImplementation(() => realNow() + lateBy);
			const overrun = async (delayMs?: number): Promise<void> => {
				lateBy += (delayMs ?? 0) + 5_000;
			};
			vi.spyOn(scheduler, "wait").mockImplementation(overrun);
			try {
				const result = await lane.call(route.url, { replayBudgetMs: 3_000, providerRetryWait: overrun });

				expect(route.requests()).toBe(1);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);
});

function laneNamed(name: string): Lane {
	const found = lanes.find(lane => lane.name === name);
	if (!found) throw new Error(`no lane named ${name}`);
	return found;
}

// The finding: a held retry against Anthropic paid the provider's whole ceiling
// before the caller's fallback chain could run.
describe("a held retry's 2 s budget against the Anthropic provider's ceiling", () => {
	it("spends 11 requests and over 41 s of backoff without it, and 3 requests inside 2 s with it", async () => {
		const anthropic = laneNamed("anthropic");
		const unbounded = cutBeforeHeaders();
		const bounded = cutBeforeHeaders();
		try {
			const { waits, providerRetryWait } = recordWaits();
			const ceiling = await anthropic.call(unbounded.url, { providerRetryWait });
			vi.restoreAllMocks();

			const started = performance.now();
			const held = await anthropic.call(bounded.url, { replayBudgetMs: 2_000 });
			const elapsedMs = performance.now() - started;

			expect(unbounded.requests()).toBe(11);
			// Ten waits of min(0.5 s × 2ⁿ, 8 s), less up to 25% jitter: 41.6 s to 55.5 s.
			expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(41_000);
			expect(ceiling.replayBudgetExhausted).toBeUndefined();
			// Waits of about 0.5 s and 1 s fit inside 2 s; the 2 s wait after them does not.
			// A loaded machine can use up the second wait before it is decided, so two
			// requests also count: either way the call stops a long way short of 11.
			expect(bounded.requests()).toBeGreaterThanOrEqual(2);
			expect(bounded.requests()).toBeLessThanOrEqual(3);
			expect(elapsedMs).toBeLessThan(2_000 + ROUND_TRIP_SLACK_MS);
			expect(held.replayBudgetExhausted).toBe(true);
		} finally {
			unbounded.stop();
			bounded.stop();
		}
	}, 120_000);
});

/** A route that answers every request with `status` and the given retry headers. */
function askingToWait(status: number, body: unknown, retryHeaders: Record<string, string>): Route {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			requests += 1;
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json", ...retryHeaders },
			});
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests: () => requests, stop: () => server.stop(true) };
}

const ANTHROPIC_OVERLOADED = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
const OPENAI_UNAVAILABLE = { error: { message: "The server is overloaded", type: "server_error" } };

// The resolution: a server wait is never shortened to fit the budget, because a
// retry sooner than the server asked is a guaranteed failure. A wait that would
// end past the budget ends the call at once, with the server's wait kept on the
// result (`errorRetryAfterMs`) for the caller to honour or fail over from.
describe("a server retry-after against the budget", () => {
	it.each([
		{ lane: "anthropic", status: 529, body: ANTHROPIC_OVERLOADED },
		{ lane: "openai-completions", status: 503, body: OPENAI_UNAVAILABLE },
	])(
		"$lane ends the call at once when the server's 30 s wait would end past a 2 s budget",
		async ({ lane, status, body }) => {
			const route = askingToWait(status, body, { "retry-after": "30" });
			try {
				const started = performance.now();
				const result = await laneNamed(lane).call(route.url, { replayBudgetMs: 2_000 });
				const elapsedMs = performance.now() - started;

				expect(route.requests()).toBe(1);
				expect(elapsedMs).toBeLessThan(ROUND_TRIP_SLACK_MS);
				expect(result.errorStatus).toBe(status);
				expect(result.errorRetryAfterMs).toBe(30_000);
				expect(result.errorMessage).not.toContain("retry-after");
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);

	it(
		"waits the server's full time when it fits inside the budget",
		async () => {
			let firstAt = 0;
			let secondAt = 0;
			let requests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async request => {
					await request.arrayBuffer();
					requests += 1;
					if (requests === 1) firstAt = performance.now();
					if (requests === 2) secondAt = performance.now();
					// The first answer asks for 2 s; the second asks for 60 s, which no
					// budget below a minute can hold.
					return new Response(JSON.stringify(ANTHROPIC_OVERLOADED), {
						status: 529,
						headers: {
							"content-type": "application/json",
							"retry-after-ms": requests === 1 ? "2000" : "60000",
						},
					});
				},
			});
			try {
				const result = await laneNamed("anthropic").call(`http://127.0.0.1:${server.port}`, {
					replayBudgetMs: 20_000,
				});

				// 2 s fits in 20 s and is slept in full; the 60 s that follows cannot fit.
				expect(requests).toBe(2);
				expect(secondAt - firstAt).toBeGreaterThanOrEqual(2_000);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				server.stop(true);
			}
		},
		LOADED_TEST_TIMEOUT_MS,
	);

	// A header that says zero must not beat a body that says thirty seconds.
	it.each([
		{ lane: "anthropic", status: 529 },
		{ lane: "openai-completions", status: 503 },
	])("$lane takes the body's 30 s over a header asking for none", async ({ lane, status }) => {
		const body =
			lane === "anthropic"
				? { type: "error", error: { type: "overloaded_error", message: "Please retry in 30s" } }
				: { error: { message: "Please retry in 30s", type: "server_error" } };
		const route = askingToWait(status, body, { "retry-after-ms": "0" });
		try {
			const result = await laneNamed(lane).call(route.url, { replayBudgetMs: 2_000 });

			expect(route.requests()).toBe(1);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			route.stop();
		}
	});

	// The transport refuses a 90 s wait as over its own cap; the outer replay
	// must not then retry after half a second and bury the hint under a later error.
	it("keeps a hint the transport refused as over its cap instead of replaying around it", async () => {
		const route = askingToWait(503, OPENAI_UNAVAILABLE, { "retry-after-ms": "90000" });
		try {
			const result = await laneNamed("openai-completions").call(route.url, { replayBudgetMs: 2_000 });

			expect(route.requests()).toBe(1);
			expect(result.errorRetryAfterMs).toBe(90_000);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			route.stop();
		}
	});

	// Antigravity's alternate endpoint is a replay of the same request.
	describe("at a Gemini endpoint switch", () => {
		const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
		beforeEach(() => {
			process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
		});
		afterEach(() => {
			if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
			else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
		});
		function antigravity(budget: number | undefined): { calls: string[]; result: Promise<AssistantMessage> } {
			const calls: string[] = [];
			const result = streamGoogleGeminiCli(
				buildModel({
					id: "gemini-3-flash",
					name: "Gemini 3 Flash",
					api: "google-gemini-cli",
					provider: "google-antigravity",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
					reasoning: true,
					input: ["text"],
					cost,
					contextWindow: 1_000_000,
					maxTokens: 8_192,
				}),
				context,
				{
					apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
					...(budget === undefined ? {} : { replayBudgetMs: budget }),
					fetch: async input => {
						calls.push(String(input));
						return calls.length === 1
							? Response.json(
									{ error: { message: "server overloaded" } },
									{ status: 503, headers: { "retry-after": "30" } },
								)
							: Response.json({ error: { message: "bad request" } }, { status: 400 });
					},
				},
			).result();
			return { calls, result };
		}

		it("switches at once when no budget is set", async () => {
			const call = antigravity(undefined);
			await call.result;

			expect(call.calls).toHaveLength(2);
		});

		it("does not switch sooner than the first endpoint's server asked when that wait does not fit", async () => {
			const call = antigravity(2_000);
			const result = await call.result;

			expect(call.calls).toHaveLength(1);
			expect(result.errorStatus).toBe(503);
			expect(result.replayBudgetExhausted).toBe(true);
		});
	});
});

// Resends the repository makes below the provider loop, inside one call, that
// nothing above can see: the uncompressed resend after an encoding rejection,
// and the Copilot identity retry. Their hosts are fixed by catalog rules, so the
// wire is a `fetch` that answers as those hosts do.
describe("repository-owned resends below the provider", () => {
	afterEach(() => resetRequestCompressionForTesting());

	const largeContext: Context = {
		messages: [{ role: "user", content: "hello world ".repeat(500), timestamp: 1 }],
	};
	const anthropicSuccess = (): Response =>
		new Response(
			[
				{
					type: "message_start",
					message: {
						id: "msg_ok",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 1 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			]
				.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join(""),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	const encodingRejection = (): Response =>
		new Response(
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

	function compressedAnthropic(budget: number | undefined): {
		requests: () => number;
		result: Promise<AssistantMessage>;
	} {
		let requests = 0;
		const fetch: FetchImpl = async () => {
			requests += 1;
			return requests === 1 ? encodingRejection() : anthropicSuccess();
		};
		const result = streamAnthropic(
			buildModel({
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				cost,
				contextWindow: 200_000,
				maxTokens: 8_192,
			}),
			largeContext,
			{ apiKey: "test-key", fetch, ...(budget === undefined ? {} : { replayBudgetMs: budget }) },
		).result();
		return { requests: () => requests, result };
	}

	it("resends uncompressed after an encoding rejection when no budget is set", async () => {
		const call = compressedAnthropic(undefined);
		const result = await call.result;

		expect(call.requests()).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("does not resend uncompressed once the budget is spent, and says so", async () => {
		const call = compressedAnthropic(0);
		const result = await call.result;

		expect(call.requests()).toBe(1);
		expect(result.errorStatus).toBe(400);
		expect(result.replayBudgetExhausted).toBe(true);
	});

	function copilotCompletions(budget: number | undefined): {
		requests: () => number;
		result: Promise<AssistantMessage>;
	} {
		let requests = 0;
		const fetch: FetchImpl = async () => {
			requests += 1;
			if (requests === 1) return new Response("{}", { status: 403 });
			return new Response(
				`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const result = streamOpenAICompletions(
			buildModel({
				id: "gpt-4o",
				name: "GPT-4o",
				api: "openai-completions",
				provider: "github-copilot",
				baseUrl: "https://api.individual.githubcopilot.com",
				reasoning: false,
				input: ["text"],
				cost,
				contextWindow: 128_000,
				maxTokens: 8_192,
			}),
			context,
			{ apiKey: "ghu_test", fetch, ...(budget === undefined ? {} : { replayBudgetMs: budget }) },
		).result();
		return { requests: () => requests, result };
	}

	it("retries a denied Copilot identity once when no budget is set", async () => {
		const call = copilotCompletions(undefined);
		const result = await call.result;

		expect(call.requests()).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("does not retry a denied Copilot identity once the budget is spent, and says so", async () => {
		const call = copilotCompletions(0);
		const result = await call.result;

		expect(call.requests()).toBe(1);
		expect(result.errorStatus).toBe(403);
		expect(result.replayBudgetExhausted).toBe(true);
	});
});

/** A route that answers every request with a STOP carrying no content. */
function answersEmpty(body: string): Route {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			requests += 1;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests: () => requests, stop: () => server.stop(true) };
}

const EMPTY_GEMINI = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] })}\n\n`;
const EMPTY_CLOUD_CODE = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] } })}\n\n`;

describe.each([
	{
		name: "google-generative-ai",
		body: EMPTY_GEMINI,
		call: (url: string, options: CallOptions) =>
			streamGoogle(
				buildModel({
					id: "gemini-2.5-flash",
					name: "Gemini 2.5 Flash",
					api: "google-generative-ai",
					provider: "google",
					baseUrl: url,
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 1_000_000,
					maxTokens: 8_192,
				}),
				context,
				{ apiKey: "test-key", ...options },
			).result(),
	},
	{
		name: "google-gemini-cli",
		body: EMPTY_CLOUD_CODE,
		call: (url: string, options: CallOptions) => laneNamed("google-gemini-cli").call(url, options),
	},
])("$name against a route that answers every request empty", ({ body, call }) => {
	it("replays the empty answer twice and marks nothing when no budget is set", async () => {
		const route = answersEmpty(body);
		try {
			recordWaits();
			const result = await call(route.url, {});

			expect(route.requests()).toBe(3);
			expect(result.stopReason).toBe("error");
			expect(result.replayBudgetExhausted).toBeUndefined();
		} finally {
			route.stop();
		}
	});

	it("returns the first empty answer when the replay would not fit, and says so", async () => {
		const route = answersEmpty(body);
		try {
			const result = await call(route.url, { replayBudgetMs: 100 });

			expect(route.requests()).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			route.stop();
		}
	});
});

// A correction the provider already tried ends the call on its own terms; the
// marker must not blame a budget that happened to expire meanwhile.
describe("the marker after a correction the provider already tried", () => {
	it.each([10_000, 100])("stays unset with a %i ms budget", async budget => {
		const realNow = performance.now.bind(performance);
		let lateBy = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + lateBy);
		const efforts: Array<string | undefined> = [];
		const result = await streamOpenAIResponses(
			buildModel({
				id: "fallback-responses-reasoner",
				name: "Reasoner",
				api: "openai-responses",
				provider: "custom-responses",
				baseUrl: "https://responses.example.test/v1",
				reasoning: true,
				compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
				input: ["text"],
				cost,
				contextWindow: 128_000,
				maxTokens: 16_384,
			}),
			context,
			{
				apiKey: "test-key",
				reasoning: Effort.High,
				replayBudgetMs: budget,
				fetch: async (_input, init) => {
					const effort = (JSON.parse(String(init?.body)) as { reasoning?: { effort?: string } }).reasoning?.effort;
					efforts.push(effort);
					// The third rejection arrives after the short budget has run out.
					if (efforts.length === 3) lateBy += 1_000;
					const allowed = effort === "high" ? "low" : "high";
					return Response.json(
						{
							error: {
								message: `invalid reasoning value: '${effort}' (must be "${allowed}")`,
								type: "invalid_request_error",
								param: "reasoning.effort",
							},
						},
						{ status: 400 },
					);
				},
			},
		).result();

		expect(efforts).toEqual(["high", "low", "high"]);
		expect(result.replayBudgetExhausted).toBeUndefined();
	});
});

// Reading back a stored result avoids a duplicate generation, which justifies
// preferring the poll — not starting it once the caller's budget is gone.
describe("the stored-result poll", () => {
	const stored = { id: "resp_stored", status: "completed", output: [] };

	it("sends its first check when no budget governs the call", async () => {
		let fetches = 0;
		const result = await pollOpenAIResponsesResultForCompletion({
			url: "https://muse.example.test/responses/resp_stored",
			headers: {},
			responseId: "resp_stored",
			fetchImpl: async () => {
				fetches += 1;
				return Response.json(stored);
			},
		});

		expect(fetches).toBe(1);
		expect(result).toBeDefined();
	});

	it("sends nothing once the caller's budget is spent", async () => {
		let fetches = 0;
		const budget = ReplayBudget.from(0);
		const result = await pollOpenAIResponsesResultForCompletion({
			url: "https://muse.example.test/responses/resp_stored",
			headers: {},
			responseId: "resp_stored",
			admits: budget?.admits,
			fetchImpl: async () => {
				fetches += 1;
				return Response.json(stored);
			},
		});

		expect(fetches).toBe(0);
		expect(result).toBeUndefined();
	});
});

/** A route that answers request `n` (from 1) with `respond(n)` and records when each arrived. */
function scripted(respond: (n: number) => Response): Route & { times: number[] } {
	const times: number[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			times.push(performance.now());
			return respond(times.length);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		times,
		requests: () => times.length,
		stop: () => server.stop(true),
	};
}

/** A JSON error every HTTP lane parses: `overloaded_error` when retryable, `invalid_request_error` for a 400. */
function failure(status: number, headers: Record<string, string> = {}, message = "The server is overloaded"): Response {
	return Response.json(
		{ type: "error", error: { type: status === 400 ? "invalid_request_error" : "overloaded_error", message } },
		{ status, headers },
	);
}

const HTTP_LANES = lanes.filter(lane => lane.name !== "cursor");

interface HintScenario {
	name: string;
	headers?: Record<string, string>;
	/** The failure's text; a function builds it when the test runs, for a time-relative HTTP date. */
	message?: string | (() => string);
}

/** An HTTP date 30 s ahead of now: inside the transport's own cap, so only the caller's budget stops it. */
const dateIn30s = (): string => new Date(Date.now() + 30_000).toUTCString();

/**
 * An RFC 850 date with a two-digit year 34 years ahead: inside RFC 9110's
 * fifty-year window, so it names a wait decades long. Read with JavaScript's
 * fixed two-digit-year cutoff it would be in the past.
 */
const rfc850DecadesAhead = (): string => {
	const date = new Date(Date.now());
	date.setUTCFullYear(date.getUTCFullYear() + 34);
	const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
		date.getUTCMonth()
	];
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${day}, ${pad(date.getUTCDate())}-${month}-${pad(date.getUTCFullYear() % 100)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
};

// Every wait the server names counts, however many there are and whatever
// malformed or shorter hint sits beside them: a retry sent inside a window the
// server said is closed is a guaranteed failure.
describe.each<HintScenario>([
	{
		name: "a short retry-after-ms beside a long retry-after",
		headers: { "retry-after-ms": "1", "retry-after": "30" },
	},
	{
		name: "a long x-ratelimit-reset-after beside shorter headers",
		headers: { "retry-after-ms": "1", "retry-after": "0.002", "x-ratelimit-reset-after": "30" },
	},
	{ name: "a phrase repeated with a longer wait", message: "Please retry in 1ms. Please retry in 30s." },
	{ name: "a malformed phrase before a valid one", message: "Please retry in ...s. Please retry in 30s." },
	{ name: "two different phrases", message: "Please retry in 1ms; try again in 30s" },
	{ name: "a malformed header beside a valid one", headers: { "retry-after-ms": "bad", "retry-after": "30" } },
	{ name: "an HTTP date beside a short phrase", message: () => `retry-after: ${dateIn30s()}; Please retry in 1ms` },
	{ name: "an HTTP date alone", message: () => `retry-after=${dateIn30s()}` },
])("a retryable failure naming $name", ({ headers, message }) => {
	it.each(HTTP_LANES.map(lane => [lane.name, lane] as const))(
		"%s ends the call on the 30 s wait against a 2 s budget",
		async (_name, lane) => {
			const text = typeof message === "function" ? message() : message;
			const route = scripted(n => (n === 1 ? failure(503, headers, text) : failure(400)));
			try {
				const result = await lane.call(route.url, { replayBudgetMs: 2_000 });

				expect(route.requests()).toBe(1);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
	);
});

// RFC 9110 reads a two-digit year as at most fifty years ahead, so this date is
// decades away; read with JavaScript's fixed cutoff it would be in the past and
// retried at once. No lane may send it again. Whether the call is marked follows
// the provider's own policy: a lane whose own cap declines a wait that long gives
// up by itself, before the budget is asked.
describe("a retryable failure naming an RFC 850 date whose two-digit year is decades ahead", () => {
	it.each(HTTP_LANES.map(lane => [lane.name, lane] as const))(
		"%s does not send the request again under a 2 s budget",
		async (_name, lane) => {
			const text = `retry-after: ${rfc850DecadesAhead()}; Please retry in 1ms`;
			const route = scripted(n => (n === 1 ? failure(503, {}, text) : failure(400)));
			try {
				await lane.call(route.url, { replayBudgetMs: 2_000 });

				expect(route.requests()).toBe(1);
			} finally {
				route.stop();
			}
		},
	);
});

/** Spellings of a date 30 s ahead that servers send in a `Retry-After` header. */
const DATE_SPELLINGS_30S: ReadonlyArray<[string, (at: Date) => string]> = [
	["with a trailing comment", at => `${at.toUTCString()} (UTC)`],
	[
		"with long weekday and month names",
		at => {
			const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(at);
			const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(at);
			const time = at.toISOString().slice(11, 19);
			return `${day}, ${at.getUTCDate()} ${month} ${at.getUTCFullYear()} ${time} GMT`;
		},
	],
	["as an RFC 3339 timestamp", at => at.toISOString()],
	[
		"in JavaScript's Date#toString shape with a GMT offset",
		at =>
			`${at.toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/, "$1 $3 $2 $4 $5")} GMT+0000 (Coordinated Universal Time)`,
	],
	["without a zone", at => at.toUTCString().replace(/ GMT$/, "")],
	["with doubled spaces", at => at.toUTCString().replaceAll(" ", "  ")],
];

// Each spelling names the same 30 s wait, so each ends the call at once under
// a 2 s budget: one request, marked.
describe.each(DATE_SPELLINGS_30S)("a retryable failure whose Retry-After date is written %s", (_name, spell) => {
	it.each(HTTP_LANES.map(lane => [lane.name, lane] as const))(
		"%s ends the call on the 30 s wait against a 2 s budget",
		async (_lane, lane) => {
			const route = scripted(n =>
				n === 1
					? failure(503, { "retry-after": spell(new Date(Math.ceil((Date.now() + 30_000) / 1000) * 1000)) })
					: failure(400),
			);
			try {
				const result = await lane.call(route.url, { replayBudgetMs: 2_000 });

				expect(route.requests()).toBe(1);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
	);
});

describe("the no-budget reading of conflicting hints", () => {
	// Without a budget nothing changes: the retry loop still sleeps on the first
	// header it recognizes, so the conflicting pair is retried after 1 ms.
	it("still retries on the first recognized header", async () => {
		const route = scripted(n =>
			n === 1 ? failure(503, { "retry-after-ms": "1", "retry-after": "30" }) : failure(400),
		);
		try {
			const result = await laneNamed("openai-completions").call(route.url, {});

			expect(route.requests()).toBe(2);
			expect(result.replayBudgetExhausted).toBeUndefined();
		} finally {
			route.stop();
		}
	});
});

// A Vertex regional endpoint that 404s is retried at the global endpoint: the
// same request again, so the budget governs it.
describe("the Vertex global fallback", () => {
	const savedLocation = process.env.GOOGLE_CLOUD_LOCATION;
	beforeEach(() => {
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
	});
	afterEach(() => {
		if (savedLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
		else process.env.GOOGLE_CLOUD_LOCATION = savedLocation;
	});

	async function vertex(budget: number | undefined): Promise<{ urls: string[]; result: AssistantMessage }> {
		const route = scripted(n => failure(n === 1 ? 404 : 400));
		const urls: string[] = [];
		try {
			const result = await streamGoogleVertex(
				buildModel({
					id: "gemini-2.5-pro",
					name: "Gemini 2.5 Pro",
					api: "google-vertex",
					provider: "google-vertex",
					// The request URL comes from GOOGLE_CLOUD_LOCATION, not from this.
					baseUrl: "https://us-central1-aiplatform.googleapis.com",
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 1_000_000,
					maxTokens: 8_192,
				}),
				context,
				{
					apiKey: "test-key",
					...(budget === undefined ? {} : { replayBudgetMs: budget }),
					fetch: async (input, init) => {
						urls.push(String(input));
						return fetch(route.url, init);
					},
				},
			).result();
			return { urls, result };
		} finally {
			route.stop();
		}
	}

	it("retries the global endpoint when no budget is set", async () => {
		const { urls, result } = await vertex(undefined);

		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain("us-central1");
		expect(urls[1]).not.toContain("us-central1");
		expect(result.replayBudgetExhausted).toBeUndefined();
	});

	it("keeps the regional failure, marked, once the budget is spent", async () => {
		const { urls, result } = await vertex(0);

		expect(urls).toHaveLength(1);
		expect(result.errorStatus).toBe(404);
		expect(result.replayBudgetExhausted).toBe(true);
	});
});

// A replay is admitted before its request is prepared. A payload hook that
// outlives the deadline must not get the request sent: the check that counts is
// the one adjacent to the send.
describe("preparation that outlives the deadline", () => {
	/**
	 * The monotonic clock plus an offset the test advances to stand in for preparation
	 * that outlasts the deadline. The budgets here are far larger than any start-up
	 * delay a loaded machine adds, so the replay is admitted however slow the run is,
	 * and the skew alone carries it past the deadline before its request is handed off.
	 */
	function skewedClock(): { lateBy(ms: number): void } {
		const realNow = performance.now.bind(performance);
		let skew = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
		return {
			lateBy(ms) {
				skew += ms;
			},
		};
	}

	// Azure's replay-safe wrapper replays a 503 once its six HTTP attempts are
	// spent: seven requests with no budget.
	it("keeps the replaced 503 when the replay-safe retry's request is ready only after the deadline", async () => {
		const respond = (n: number): Response => (n <= 6 ? failure(503, { "retry-after-ms": "0" }) : failure(400));
		const unbudgeted = scripted(respond);
		const budgeted = scripted(respond);
		let prepares = 0;
		try {
			const today = await laneNamed("azure-openai-responses").call(unbudgeted.url, {
				providerRetryWait: async () => {},
			});
			const clock = skewedClock();
			const result = await laneNamed("azure-openai-responses").call(budgeted.url, {
				replayBudgetMs: 20_000,
				onPayload: async () => {
					prepares++;
					if (prepares === 2) clock.lateBy(30_000);
				},
			});

			expect(unbudgeted.requests()).toBe(7);
			expect(today.replayBudgetExhausted).toBeUndefined();
			expect(prepares).toBe(2);
			expect(budgeted.requests()).toBe(6);
			expect(result.errorStatus).toBe(503);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			unbudgeted.stop();
			budgeted.stop();
		}
	});

	it("keeps the empty completion when its replay's request is ready only after the deadline", async () => {
		const emptyStop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const route = scripted(() => new Response(emptyStop, { headers: { "content-type": "text/event-stream" } }));
		let prepares = 0;
		try {
			const clock = skewedClock();
			const result = await laneNamed("openai-completions").call(route.url, {
				replayBudgetMs: 20_000,
				onPayload: async () => {
					prepares++;
					if (prepares === 2) clock.lateBy(30_000);
				},
			});

			expect(prepares).toBe(2);
			expect(route.requests()).toBe(1);
			// The empty completion stands, not the refused replay's error.
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			route.stop();
		}
	});

	// The Codex WebSocket generator writes the frame after its debug work and
	// the outgoing diagnostic observer; the budget is asked after both.
	it("does not write the Codex WebSocket frame after a slow outgoing observer passes the deadline", async () => {
		const frames: number[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, srv) {
				if (srv.upgrade(request)) return undefined;
				return new Response("bad request", { status: 400 });
			},
			websocket: {
				message(ws) {
					frames.push(performance.now());
					ws.close(1011, "retry");
				},
			},
		});
		let outgoing = 0;
		const clock = skewedClock();
		try {
			const result = await streamOpenAICodexResponses(
				buildModel({
					id: "gpt-5.3-codex-spark",
					name: "Codex",
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: `http://127.0.0.1:${server.port}`,
					reasoning: true,
					preferWebsockets: true,
					input: ["text"],
					cost,
					contextWindow: 128_000,
					maxTokens: 8_192,
				}),
				context,
				{
					apiKey: codexToken(),
					sessionId: "replay-budget-ws-observer",
					providerSessionState: new Map(),
					preferWebsockets: true,
					replayBudgetMs: 20_000,
					onSseEvent(event) {
						if (!event.raw.some(line => line.startsWith(": ws →"))) return;
						outgoing++;
						// A slow outgoing observer: the skew stands in for the time it holds the frame.
						if (outgoing === 2) clock.lateBy(30_000);
					},
				},
			).result();

			expect(outgoing).toBe(2);
			expect(frames).toHaveLength(1);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});

// A wait hook that never settles must not hold failover: the wait is raced
// against the deadline and against the caller's signal.
describe("a retry wait that never settles", () => {
	/** The call's result, or `undefined` when it is still pending after `ms`: a regression fails here, not at the runner's timeout. */
	function resultWithin(call: Promise<AssistantMessage>, ms: number): Promise<AssistantMessage | undefined> {
		return Promise.race([call, Bun.sleep(ms).then(() => undefined)]);
	}

	it("ends the call at the deadline", async () => {
		const route = cutBeforeHeaders();
		let entered = 0;
		try {
			const started = performance.now();
			const result = await resultWithin(
				laneNamed("anthropic").call(route.url, {
					replayBudgetMs: 600,
					providerRetryWait: () => {
						entered++;
						return new Promise<void>(() => {});
					},
				}),
				600 + ROUND_TRIP_SLACK_MS,
			);
			const elapsedMs = performance.now() - started;

			expect(entered).toBe(1);
			expect(result).toBeDefined();
			expect(route.requests()).toBe(1);
			expect(elapsedMs).toBeLessThan(600 + ROUND_TRIP_SLACK_MS);
			expect(result?.replayBudgetExhausted).toBe(true);
		} finally {
			route.stop();
		}
	});

	it("ends the call when the caller aborts", async () => {
		const route = cutBeforeHeaders();
		const controller = new AbortController();
		let entered = 0;
		try {
			const call = laneNamed("anthropic").call(route.url, {
				replayBudgetMs: 60_000,
				signal: controller.signal,
				providerRetryWait: () => {
					entered++;
					return new Promise<void>(() => {});
				},
			});
			await Bun.sleep(200);
			controller.abort();
			const result = await resultWithin(call, ROUND_TRIP_SLACK_MS);

			expect(entered).toBe(1);
			expect(result?.stopReason).toBe("aborted");
			expect(route.requests()).toBe(1);
		} finally {
			route.stop();
		}
	});
});

// A correction re-sends a rejected request. A server that named a wait on the
// rejection is answered the same way as on any retryable failure.
describe("a correction the server asked to delay", () => {
	it("is not sent sooner than the server asked when that wait does not fit", async () => {
		const times: number[] = [];
		const result = await streamOpenAIResponses(
			buildModel({
				id: "fallback-responses-reasoner",
				name: "Reasoner",
				api: "openai-responses",
				provider: "custom-responses",
				baseUrl: "https://responses.example.test/v1",
				reasoning: true,
				compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
				input: ["text"],
				cost,
				contextWindow: 128_000,
				maxTokens: 16_384,
			}),
			context,
			{
				apiKey: "test-key",
				reasoning: Effort.High,
				replayBudgetMs: 2_000,
				fetch: async () => {
					times.push(performance.now());
					return Response.json(
						{
							error: {
								message: `invalid reasoning value: 'high' (must be "low")`,
								type: "invalid_request_error",
								param: "reasoning.effort",
							},
						},
						{ status: 400, headers: { "retry-after": "30" } },
					);
				},
			},
		).result();

		expect(times).toHaveLength(1);
		expect(result.replayBudgetExhausted).toBe(true);
	});
});
