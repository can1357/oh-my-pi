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
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resetRequestCompressionForTesting } from "@oh-my-pi/pi-ai/utils/request-compression";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
	providerRetryWait?: (delayMs: number) => Promise<void>;
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
/** Round trips to a local route that closes at once; generous so a loaded CI box does not flake. */
const ROUND_TRIP_SLACK_MS = 400;

describe.each(lanes)("$name against a route that cuts every request before headers", lane => {
	it("keeps today's ceiling and marks nothing when no budget is set", async () => {
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
	});

	it("returns inside the budget, with fewer requests, and says the budget stopped it", async () => {
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
	});

	it("reaches the provider's own ceiling, unmarked, when the budget never runs short", async () => {
		const route = await lane.route();
		try {
			const { providerRetryWait } = recordWaits();
			const result = await lane.call(route.url, { replayBudgetMs: 600_000, providerRetryWait });

			expect(route.requests()).toBe(lane.ceiling);
			expect(result.replayBudgetExhausted).toBeUndefined();
		} finally {
			route.stop();
		}
	});
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
			expect(bounded.requests()).toBe(3);
			expect(elapsedMs).toBeLessThan(2_000);
			expect(held.replayBudgetExhausted).toBe(true);
		} finally {
			unbounded.stop();
			bounded.stop();
		}
	});
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
// end past the budget ends the call at once, with the server's hint kept on the
// error for the caller to honour or fail over from.
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
				expect(result.errorMessage).toContain("retry-after-ms=30000");
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				route.stop();
			}
		},
	);

	it("waits the server's full time when it fits inside the budget", async () => {
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
				return new Response(JSON.stringify(ANTHROPIC_OVERLOADED), {
					status: 529,
					headers: { "content-type": "application/json", "retry-after-ms": "600" },
				});
			},
		});
		try {
			const result = await laneNamed("anthropic").call(`http://127.0.0.1:${server.port}`, {
				replayBudgetMs: 1_000,
			});

			// 600 ms fits in 1 s and is slept in full; the next wait does not fit.
			expect(requests).toBe(2);
			expect(secondAt - firstAt).toBeGreaterThanOrEqual(600);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop(true);
		}
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
