/**
 * End-to-end cost of a rate-limited primary model.
 *
 * These sessions drive the real OpenAI-completions transport against a local
 * stub, so the assertions count actual HTTP requests rather than `streamFn`
 * calls. A persistent 429 must reach `TurnRecovery` — and therefore the
 * configured fallback chain — after the small documented transport budget,
 * not after a hidden per-attempt multiplier. With several sessions running
 * concurrently (the subagent case) the total request count must stay
 * proportional to the number of sessions.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MAX_RATE_LIMIT_ATTEMPTS, TempDir } from "@oh-my-pi/pi-utils";

/** Retry budget the session may spend before giving up on the whole turn. */
const OUTER_RETRIES = 3;

function rateLimitedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "Rate limit reached for requests" } }), {
		status: 429,
		// A short, credible recovery hint: the most retry-friendly 429 there is.
		headers: { "content-type": "application/json", "retry-after-ms": "10" },
	});
}

function successResponse(text: string): Response {
	const frames = [
		{ id: "chatcmpl_ok", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{
			id: "chatcmpl_ok",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
		},
	];
	return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("AgentSession rate-limit request budget", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-rate-limit-budget-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	function models(): { primary: Model; fallback: Model } {
		const primary = getBundledModel("openai", "gpt-4o-mini");
		const fallback = getBundledModel("openai", "gpt-4o");
		if (!primary || !fallback) throw new Error("Expected bundled test models to exist");
		return { primary, fallback };
	}

	/**
	 * A session whose primary model is permanently rate-limited on the wire and
	 * whose fallback model answers normally. Returns the per-model HTTP request
	 * counters so the caller can assert on real transport traffic.
	 */
	function createRateLimitedSession(
		primary: Model,
		fallback: Model,
		settingsOverrides: Record<string, unknown> = {},
	): { session: AgentSession; requests: Map<string, number> } {
		const requests = new Map<string, number>();
		const agent = new Agent({
			getApiKey: () => "openai-test-key",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) =>
				streamOpenAICompletions(model as Model<"openai-completions">, context, {
					...options,
					apiKey: "openai-test-key",
					providerRetryWait: async () => {},
					fetch: async () => {
						const key = `${model.provider}/${model.id}`;
						requests.set(key, (requests.get(key) ?? 0) + 1);
						return model.id === primary.id ? rateLimitedResponse() : successResponse(`ok:${key}`);
					},
				}),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": OUTER_RETRIES,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[`${primary.provider}/${primary.id}`]: [`${fallback.provider}/${fallback.id}`],
			},
			...settingsOverrides,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		sessions.push(session);
		return { session, requests };
	}

	it("switches to the fallback model after the bounded rate-limit budget", async () => {
		const { primary, fallback } = models();
		const { session, requests } = createRateLimitedSession(primary, fallback, {
			"retry.fallbackRevertPolicy": "never",
		});

		await session.prompt("Answer despite the rate limit");
		await session.waitForIdle();

		const primaryRequests = requests.get(`${primary.provider}/${primary.id}`) ?? 0;
		const fallbackRequests = requests.get(`${fallback.provider}/${fallback.id}`) ?? 0;
		// A single session attempt on the primary, bounded by the transport budget.
		expect(primaryRequests).toBeLessThanOrEqual(MAX_RATE_LIMIT_ATTEMPTS);
		expect(fallbackRequests).toBe(1);
		expect(session.model?.id).toBe(fallback.id);
		const last = session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(JSON.stringify(last)).toContain(`ok:${fallback.provider}/${fallback.id}`);
	});

	it("stays bounded per outer attempt under the default revert policy", async () => {
		const { primary, fallback } = models();
		// `cooldown-expiry` (the default) hands the role back to the primary as
		// soon as the 429's short retry hint elapses, so the session can spend
		// further outer attempts on it before the fallback sticks. How many
		// depends on wall-clock timing and is out of scope here; what must hold
		// is that every outer attempt costs only the transport budget.
		const { session, requests } = createRateLimitedSession(primary, fallback);
		let outerAttempts = 1;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") outerAttempts++;
		});

		await session.prompt("Answer despite the rate limit");
		await session.waitForIdle();

		const primaryRequests = requests.get(`${primary.provider}/${primary.id}`) ?? 0;
		expect(primaryRequests).toBeLessThanOrEqual(outerAttempts * MAX_RATE_LIMIT_ATTEMPTS);
		expect(requests.get(`${fallback.provider}/${fallback.id}`) ?? 0).toBe(1);
		expect(session.model?.id).toBe(fallback.id);
	});

	it("keeps parallel sessions proportional to their count, not to a transport multiplier", async () => {
		const { primary, fallback } = models();
		const parallel = 4;
		const started = Array.from({ length: parallel }, () =>
			createRateLimitedSession(primary, fallback, { "retry.fallbackRevertPolicy": "never" }),
		);

		await Promise.all(started.map(({ session }) => session.prompt("Answer despite the rate limit")));
		await Promise.all(started.map(({ session }) => session.waitForIdle()));

		const primaryTotal = started.reduce(
			(sum, { requests }) => sum + (requests.get(`${primary.provider}/${primary.id}`) ?? 0),
			0,
		);
		expect(primaryTotal).toBeLessThanOrEqual(parallel * MAX_RATE_LIMIT_ATTEMPTS);
		for (const { session, requests } of started) {
			expect(requests.get(`${fallback.provider}/${fallback.id}`) ?? 0).toBe(1);
			expect(session.model?.id).toBe(fallback.id);
		}
	});

	it("still exhausts the session retry budget on the primary when no fallback is configured", async () => {
		const { primary, fallback } = models();
		const { session, requests } = createRateLimitedSession(primary, fallback, {
			"retry.modelFallback": false,
			"retry.fallbackChains": {},
		});

		await session.prompt("No fallback available");
		await session.waitForIdle();

		const primaryRequests = requests.get(`${primary.provider}/${primary.id}`) ?? 0;
		// Session-level retries stay in the session's own budget: each outer
		// attempt costs at most the transport rate-limit budget, never a hidden
		// multiple of it.
		expect(primaryRequests).toBeLessThanOrEqual((OUTER_RETRIES + 1) * MAX_RATE_LIMIT_ATTEMPTS);
		expect(requests.get(`${fallback.provider}/${fallback.id}`) ?? 0).toBe(0);
		expect(session.model?.id).toBe(primary.id);
	});
});
