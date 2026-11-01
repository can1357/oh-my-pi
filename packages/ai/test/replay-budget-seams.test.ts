/**
 * `StreamOptions.replayBudgetMs` at the seams where a dependency sits between a
 * replay's decision and its request: a token fetch, a library fetch wrapper, a
 * correction resend, a delegate. Real local servers and real clocks: the budget
 * is a wall-clock promise, and each case counts the requests that reach the wire.
 *
 * Each budgeted case has an unset control, because the budget changes nothing
 * for a caller that does not set it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { clearCopilotIntegrationCache } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import {
	clearGitLabDuoDirectAccessCache,
	getGitLabDuoModels,
	streamGitLabDuo,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import { __resetVertexTokenCache } from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { resetRequestCompressionForTesting } from "@oh-my-pi/pi-ai/utils/request-compression";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
/** Over the compression floor, so a compressed body is built. */
const largeContext: Context = { messages: [{ role: "user", content: "Hello ".repeat(500), timestamp: 1 }] };

interface Send {
	path: string;
	headers: Headers;
	at: number;
}

interface Route {
	url: string;
	sends: Send[];
	/** `performance.now()` when the route started; each send's `at` counts from it. */
	startedAt: number;
	stop(): void;
}

/** A server that records each request and answers request `n` (from 1) with `respond(n, path)`. */
function route(respond: (n: number, path: string) => Response | Promise<Response>): Route {
	const sends: Send[] = [];
	const started = performance.now();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			sends.push({ path: new URL(request.url).pathname, headers: request.headers, at: performance.now() - started });
			return respond(sends.length, new URL(request.url).pathname);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, sends, startedAt: started, stop: () => server.stop(true) };
}

function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
	return Response.json(
		{ type: "error", error: { type: status === 503 ? "overloaded_error" : "invalid_request_error", message } },
		{ status, headers },
	);
}

/**
 * The monotonic clock plus an offset a test advances to stand in for a dependency that
 * outlasts the deadline. The budgets that use it are far larger than any start-up delay
 * a loaded machine adds, so a replay is admitted however slow the run is, and the skew
 * alone carries it past the deadline before its request is handed off.
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

/**
 * Vertex auth that can only reach the metadata server the test serves: the
 * process's own Google credentials (`GOOGLE_APPLICATION_CREDENTIALS`, an access
 * token in the environment, gcloud's user ADC file under the home directory)
 * are hidden, so the test does not depend on what the machine running it has.
 */
async function metadataServerOnly(): Promise<() => Promise<void>> {
	const keys = [
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_ACCESS_TOKEN",
		"CLOUDSDK_AUTH_ACCESS_TOKEN",
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_VERTEX_LOCATION",
	];
	const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
	for (const key of keys) delete Bun.env[key];
	Bun.env.GOOGLE_CLOUD_PROJECT = "seam-project";
	Bun.env.GOOGLE_VERTEX_LOCATION = "global";
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seam-no-adc-"));
	const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
	__resetVertexTokenCache();
	return async () => {
		homedir.mockRestore();
		for (const key of keys) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		await fs.rm(home, { recursive: true, force: true });
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRequestCompressionForTesting();
	clearCopilotIntegrationCache();
	clearGitLabDuoDirectAccessCache();
	__resetVertexTokenCache();
});

// The replay's own request is the inference request. A token fetch that runs
// between the decision and that request neither spends the replay's check nor
// stands in for it.
describe("a token fetch between the decision and the inference request", () => {
	const vertexModel = buildModel({
		id: "claude-sonnet-4@20250514",
		name: "Claude",
		api: "anthropic-messages",
		provider: "google-vertex",
		baseUrl:
			"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 200_000,
		maxTokens: 8_192,
	});

	async function vertexCall(replayBudgetMs: number | undefined): Promise<{
		tokens: number;
		inference: number;
		result: AssistantMessage;
	}> {
		const restoreCredentials = await metadataServerOnly();
		let tokens = 0;
		const clock = replayBudgetMs === undefined ? undefined : skewedClock();
		let inference = 0;
		const server = route(async (_n, path) => {
			if (path === "/token") {
				tokens++;
				// The refresh before the replay outlasts the budget: the skew is its duration.
				if (tokens === 2) clock?.lateBy(30_000);
				return Response.json({ access_token: "vertex-test-token", expires_in: 3600 });
			}
			inference++;
			// The cached token is dropped so the replay's request refreshes it again.
			if (inference === 1) __resetVertexTokenCache();
			return failure(inference === 1 ? 503 : 400, inference === 1 ? "The server is overloaded" : "bad request");
		});
		try {
			const result = await stream(vertexModel, context, {
				apiKey: "<authenticated>",
				...(replayBudgetMs === undefined ? {} : { replayBudgetMs }),
				// Never slept in the unset arm: the backoff would be real.
				providerRetryWait: replayBudgetMs === undefined ? async () => {} : undefined,
				fetch: (input, init) =>
					fetch(server.url + (String(input).includes("metadata.google.internal") ? "/token" : "/inference"), init),
			}).result();
			return { tokens, inference, result };
		} finally {
			server.stop();
			await restoreCredentials();
		}
	}

	it("keeps Vertex Claude's replay checked until its inference request, past a slow token refresh", async () => {
		const { tokens, inference, result } = await vertexCall(20_000);

		expect(tokens).toBe(2);
		expect(inference).toBe(1);
		expect(result.errorMessage).toContain("overloaded");
		expect(result.replayBudgetExhausted).toBe(true);
	}, 15_000);

	it("replays through the token refresh when no budget is set", async () => {
		const { inference, result } = await vertexCall(undefined);

		expect(inference).toBeGreaterThan(1);
		expect(result.replayBudgetExhausted).toBeUndefined();
	}, 15_000);

	// The deadline passes before the metadata probe itself, while the gcloud ADC
	// file is read: the probe's checkpoint refuses. The probe must not read that
	// as "no metadata server": the call answers with the 503 its replay replaced.
	it("answers with the original failure when the budget refuses the metadata probe itself", async () => {
		const restoreCredentials = await metadataServerOnly();
		const clock = skewedClock();
		let adcReads = 0;
		const bunFile = Bun.file.bind(Bun);
		const readsAdcSlowly = (path: string | URL, options?: BlobPropertyBag): Bun.BunFile => {
			const file = bunFile(path, options);
			if (!String(path).endsWith("application_default_credentials.json")) return file;
			return new Proxy(file, {
				get(target, key) {
					if (key !== "json") return Reflect.get(target, key, target);
					return async () => {
						// The replay's ADC lookup outlasts the budget.
						if (++adcReads === 2) clock.lateBy(30_000);
						return target.json();
					};
				},
			});
		};
		vi.spyOn(Bun, "file").mockImplementation(readsAdcSlowly as typeof Bun.file);
		let tokens = 0;
		let inference = 0;
		const server = route(async (_n, path) => {
			if (path === "/token") {
				tokens++;
				return Response.json({ access_token: "vertex-test-token", expires_in: 3600 });
			}
			inference++;
			__resetVertexTokenCache();
			return failure(503, "original overload sentinel", { "retry-after-ms": "1" });
		});
		try {
			const result = await stream(vertexModel, context, {
				apiKey: "<authenticated>",
				replayBudgetMs: 20_000,
				fetch: (input, init) =>
					fetch(server.url + (String(input).includes("metadata.google.internal") ? "/token" : "/inference"), init),
			}).result();

			expect(adcReads).toBe(2);
			expect(tokens).toBe(1);
			expect(inference).toBe(1);
			expect(result.errorMessage).toContain("original overload sentinel");
			expect(result.errorRetryAfterMs).toBe(1);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop();
			await restoreCredentials();
		}
	}, 15_000);

	it("keeps a GitLab Duo auth replay checked past its token request and a slow payload hook", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-1");
		if (!model) throw new Error("expected the GitLab Duo test model");
		let tokens = 0;
		let inference = 0;
		let prepares = 0;
		const clock = skewedClock();
		const server = route(async (_n, path) => {
			if (path === "/token") {
				tokens++;
				return Response.json({ token: `gateway-${tokens}`, headers: {} });
			}
			inference++;
			return failure(inference === 1 ? 401 : 400, inference === 1 ? "invalid API key" : "bad request");
		});
		try {
			const result = await streamSimple(model, context, {
				apiKey: async ctx => (ctx.error === undefined ? "first-key" : "second-key"),
				replayBudgetMs: 20_000,
				onPayload: async () => {
					if (++prepares === 2) clock.lateBy(30_000);
				},
				fetch: (input, init) =>
					fetch(server.url + (String(input).includes("/direct_access") ? "/token" : "/inference"), init),
			}).result();

			expect(tokens).toBe(2);
			expect(inference).toBe(1);
			expect(result.errorMessage).toContain("401");
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop();
		}
	}, 15_000);
});

// The deadline starts when the caller's call starts, not when a dependency
// finishes: a direct GitLab Duo call's token request is inside the budget.
describe("a call whose entry point fetches a token before it delegates", () => {
	it("starts the budget before the GitLab Duo token request", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-1");
		if (!model) throw new Error("expected the GitLab Duo test model");
		let inference = 0;
		const server = route(async (_n, path) => {
			if (path === "/token") {
				await scheduler.wait(900);
				return Response.json({ token: "gateway-token", headers: {} });
			}
			inference++;
			return Response.json(
				{ error: { message: inference === 1 ? "The server is overloaded" : "bad request" } },
				{ status: inference === 1 ? 503 : 400, headers: { "retry-after-ms": "1" } },
			);
		});
		try {
			const result = await streamGitLabDuo(model, context, {
				apiKey: "test-key-direct",
				replayBudgetMs: 700,
				fetch: (input, init) =>
					fetch(server.url + (String(input).includes("/direct_access") ? "/token" : "/inference"), init),
			}).result();

			// The first inference is not a replay; its replay would begin after the
			// 700 ms the token request alone has already spent.
			expect(inference).toBe(1);
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop();
		}
	}, 15_000);
});

// A correction re-sends a rejected request. A server that named a wait on the
// rejection is answered the same way as on any retryable failure.
describe("a correction the server asked to delay by 30 s, against a 2 s budget", () => {
	interface CorrectionTarget {
		kind: string;
		rejection: () => Response;
		call: (url: string, replayBudgetMs: number | undefined) => Promise<AssistantMessage>;
		attempts: (sends: Send[]) => Array<string | null>;
	}
	const targets: CorrectionTarget[] = [
		{
			kind: "compression",
			rejection: () =>
				Response.json(
					{
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "Request body is not valid gzip.",
							details: { error_code: "request_body_encoding_invalid" },
						},
					},
					{ status: 400, headers: { "retry-after": "30" } },
				),
			call: (url: string, replayBudgetMs: number | undefined) =>
				streamAnthropic(
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
					{
						apiKey: "test-key",
						...(replayBudgetMs === undefined ? {} : { replayBudgetMs }),
						providerRetryWait: async () => {},
						fetch: (_input, init) => fetch(url, init),
					},
				).result(),
			attempts: (sends: Send[]) => sends.map(send => send.headers.get("content-encoding")),
		},
		{
			kind: "copilot identity",
			rejection: () =>
				Response.json({ error: { message: "Access denied" } }, { status: 403, headers: { "retry-after": "30" } }),
			call: (url: string, replayBudgetMs: number | undefined) =>
				streamOpenAICompletions(
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
					largeContext,
					{
						apiKey: "ghu_test",
						...(replayBudgetMs === undefined ? {} : { replayBudgetMs }),
						providerRetryWait: async () => {},
						fetch: (_input, init) => fetch(url, init),
					},
				).result(),
			attempts: (sends: Send[]) => sends.map(send => send.headers.get("copilot-integration-id")),
		},
	];

	describe.each(targets)("$kind", target => {
		it("is not sent sooner than the server asked, and the call says the budget ended it", async () => {
			const server = route(n => (n === 1 ? target.rejection() : failure(400, "bad request")));
			try {
				const result = await target.call(server.url, 2_000);

				expect(server.sends).toHaveLength(1);
				expect(result.replayBudgetExhausted).toBe(true);
				// The server's wait stays on the result, structured, whatever rewrite the provider applies.
				expect(result.errorRetryAfterMs).toBe(30_000);
				expect(result.errorMessage).not.toContain("retry-after");
			} finally {
				server.stop();
			}
		});

		it("is resent at once when no budget is set", async () => {
			const server = route(n => (n === 1 ? target.rejection() : failure(400, "bad request")));
			try {
				const result = await target.call(server.url, undefined);

				expect(server.sends.length).toBeGreaterThanOrEqual(2);
				expect(new Set(target.attempts([...server.sends])).size).toBeGreaterThan(1);
				expect(result.replayBudgetExhausted).toBeUndefined();
			} finally {
				server.stop();
			}
		});
	});
});

describe("a retry with another credential, against a failure that names a 30 s wait", () => {
	const model = buildModel({
		id: "wire-model",
		name: "Wire",
		api: "openai-completions",
		provider: "wire",
		baseUrl: "http://placeholder.invalid",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 8_192,
	});

	async function call(replayBudgetMs: number | undefined): Promise<{ sends: Send[]; result: AssistantMessage }> {
		const server = route(n =>
			failure(n === 1 ? 401 : 400, n === 1 ? "invalid API key. Please retry in 30s" : "bad request", {
				"retry-after": "30",
			}),
		);
		try {
			const result = await streamSimple({ ...model, baseUrl: server.url }, context, {
				apiKey: async ctx => (ctx.error === undefined ? "first-key" : "second-key"),
				...(replayBudgetMs === undefined ? {} : { replayBudgetMs }),
			}).result();
			return { sends: [...server.sends], result };
		} finally {
			server.stop();
		}
	}

	it("keeps the first failure, marked, instead of retrying inside the server's window", async () => {
		const { sends, result } = await call(2_000);

		expect(sends).toHaveLength(1);
		expect(result.errorMessage).toContain("401");
		expect(result.replayBudgetExhausted).toBe(true);
	});

	it("retries with the next credential when no budget is set", async () => {
		const { sends, result } = await call(undefined);

		expect(sends).toHaveLength(2);
		expect(sends.map(send => send.headers.get("authorization"))).toEqual(["Bearer first-key", "Bearer second-key"]);
		expect(result.replayBudgetExhausted).toBeUndefined();
	});

	// The stock resolver rotates through stored credentials and may sleep out a
	// sibling's short block before answering. That sleep is part of the replay's
	// wait: a budget it would overrun refuses it, and the failed credential is
	// still blocked. Real AuthStorage, real HTTP 403, no mocked clock.
	it.each([0, 100])(
		"does not wait out a sibling credential's block past a %i ms budget",
		async replayBudgetMs => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-budget-rotation-"));
			const storage = await AuthStorage.create(path.join(dir, "auth.db"));
			const provider = "budget-rotation";
			const server = route(() =>
				failure(403, "This content was flagged for possible cybersecurity risk. (code=cyber_policy)"),
			);
			try {
				await storage.credentials.set(provider, [
					{ type: "api_key", key: "blocked-A" },
					{ type: "api_key", key: "denied-B" },
				]);
				const [blocked, denied] = storage.credentials.list(provider);
				// Long enough that a loaded machine reaches the rotation well before it
				// ends, short enough that the rotation would wait for it (under 5 s).
				const blockEndsAt = performance.now() + 4_000;
				storage.blocks.upsert({
					credentialId: blocked!.id,
					providerKey: `${provider}:api_key`,
					blockScope: "account-policy",
					blockedUntilMs: Date.now() + 4_000,
				});
				const sessionId = `budget-${replayBudgetMs}`;
				expect(await storage.keys.get(provider, sessionId)).toBe("denied-B");
				const rotationModel = { ...model, provider, baseUrl: server.url };
				const waits = vi.spyOn(scheduler, "wait");

				const result = await streamSimple(rotationModel, context, {
					apiKey: storage.keys.resolver(provider, { sessionId, baseUrl: server.url, modelId: model.id }),
					replayBudgetMs,
				}).result();
				const returnedAt = performance.now();

				expect(server.sends).toHaveLength(1);
				expect(result.replayBudgetExhausted).toBe(true);
				// No sleep toward the sibling's block was started, and the call returned
				// before that block ended.
				expect(waits.mock.calls.filter(([delayMs]) => Number(delayMs) >= 200)).toEqual([]);
				expect(returnedAt).toBeLessThan(blockEndsAt);
				// The rotation still blocks the denied credential. Under a spent budget
				// the call does not wait for that bookkeeping, so it may land just after.
				for (let waited = 0; waited < 2_000 && storage.blocks.list([denied!.id]).length === 0; waited += 20) {
					await scheduler.wait(20);
				}
				expect(storage.blocks.list([denied!.id])).not.toHaveLength(0);
			} finally {
				server.stop();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("waits out a sibling credential's block and retries with it when no budget is set", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-budget-rotation-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const provider = "budget-rotation-unset";
		const server = route(() =>
			failure(403, "This content was flagged for possible cybersecurity risk. (code=cyber_policy)"),
		);
		try {
			await storage.credentials.set(provider, [
				{ type: "api_key", key: "blocked-A" },
				{ type: "api_key", key: "denied-B" },
			]);
			const [blocked] = storage.credentials.list(provider);
			const blockEndsAt = performance.now() + 4_000;
			storage.blocks.upsert({
				credentialId: blocked!.id,
				providerKey: `${provider}:api_key`,
				blockScope: "account-policy",
				blockedUntilMs: Date.now() + 4_000,
			});
			const sessionId = "budget-unset";
			expect(await storage.keys.get(provider, sessionId)).toBe("denied-B");
			const waits = vi.spyOn(scheduler, "wait");

			await streamSimple({ ...model, provider, baseUrl: server.url }, context, {
				apiKey: storage.keys.resolver(provider, { sessionId, baseUrl: server.url, modelId: model.id }),
			}).result();

			expect(server.sends.slice(0, 2).map(send => send.headers.get("authorization"))).toEqual([
				"Bearer denied-B",
				"Bearer blocked-A",
			]);
			// The rotation slept out the sibling's block before the second request.
			expect(waits.mock.calls.some(([delayMs]) => Number(delayMs) >= 200)).toBe(true);
			expect(server.startedAt + server.sends[1]!.at).toBeGreaterThanOrEqual(blockEndsAt);
		} finally {
			server.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	// A caller's resolver is outside the library: the budget cannot see how long
	// it will run, so it races it. One that never answers does not hold the call.
	it("ends the call at the deadline while a caller's resolver is still resolving", async () => {
		const server = route(n => failure(n === 1 ? 401 : 400, n === 1 ? "invalid API key" : "bad request"));
		let retryResolutions = 0;
		try {
			const result = await streamSimple({ ...model, baseUrl: server.url }, context, {
				apiKey: async ctx => {
					if (ctx.error === undefined) return "first-key";
					retryResolutions++;
					return new Promise<string>(() => {});
				},
				replayBudgetMs: 500,
			}).result();

			expect(retryResolutions).toBe(1);
			expect(server.sends).toHaveLength(1);
			expect(result.errorMessage).toContain("401");
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop();
		}
	}, 30_000);

	it("refuses the retry's request when a caller's resolver answers after the deadline", async () => {
		const clock = skewedClock();
		const server = route(n => failure(n === 1 ? 401 : 400, n === 1 ? "invalid API key" : "bad request"));
		try {
			const result = await streamSimple({ ...model, baseUrl: server.url }, context, {
				apiKey: async ctx => {
					if (ctx.error === undefined) return "first-key";
					// The resolver outlasts the budget, and answers.
					clock.lateBy(30_000);
					await scheduler.wait(50);
					return "second-key";
				},
				replayBudgetMs: 20_000,
			}).result();

			expect(server.sends).toHaveLength(1);
			expect(result.errorMessage).toContain("401");
			expect(result.replayBudgetExhausted).toBe(true);
		} finally {
			server.stop();
		}
	}, 15_000);
});

// The deadline starts when the caller's call starts. A model whose headers
// resolve slowly spends that time inside the budget: a retry that would have
// fit a budget started after the resolution does not fit this one.
describe("a model whose headers resolve slowly", () => {
	const wireModel = (baseUrl: string, resolveMs: number) =>
		({
			...buildModel({
				id: "wire-model",
				name: "Wire",
				api: "openai-completions",
				provider: "wire",
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost,
				contextWindow: 128_000,
				maxTokens: 8_192,
			}),
			resolveHeaders: async () => {
				await scheduler.wait(resolveMs);
				return {};
			},
		}) as never;

	it.each([
		[
			"stream",
			(model: never, budget: number | undefined) =>
				stream(model, context, { apiKey: "k", ...(budget === undefined ? {} : { replayBudgetMs: budget }) }),
		],
		[
			"streamSimple",
			(model: never, budget: number | undefined) =>
				streamSimple(model, context, { apiKey: "k", ...(budget === undefined ? {} : { replayBudgetMs: budget }) }),
		],
	] as const)(
		"%s starts the budget before the header resolution",
		async (_name, call) => {
			const server = route(n => failure(n === 1 ? 503 : 400, "The server is overloaded", { "retry-after-ms": "1" }));
			try {
				const result = await call(wireModel(server.url, 900), 700).result();

				// The first request is not a replay; the transport's retry would begin
				// after the 700 ms the header resolution alone has already spent.
				expect(server.sends).toHaveLength(1);
				expect(result.replayBudgetExhausted).toBe(true);
			} finally {
				server.stop();
			}
		},
		15_000,
	);

	it("retries as today when no budget is set", async () => {
		const server = route(n => failure(n === 1 ? 503 : 400, "The server is overloaded", { "retry-after-ms": "1" }));
		try {
			const result = await stream(wireModel(server.url, 50), context, { apiKey: "k" }).result();

			expect(server.sends.length).toBeGreaterThanOrEqual(2);
			expect(result.replayBudgetExhausted).toBeUndefined();
		} finally {
			server.stop();
		}
	});
});
