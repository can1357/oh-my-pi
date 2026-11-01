/**
 * A retry wait becomes a sleep inside the provider that made the request, and
 * that provider is not always the one `streamSimple` called: Kimi Code and
 * Synthetic go through a shim that rebuilds the options for an inner OpenAI or
 * Anthropic provider, GitLab Duo rebuilds them for three routes, and Ollama
 * takes the options but never handed them to its transport. Each sleep must
 * still keep to the caller's `maxRetryDelayMs` and `providerRetryWaitCeilingMs`
 * and go through its `providerRetryWait`, or the turn waits silently past the
 * bound the caller set, on a timer the caller cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { clearGitLabDuoDirectAccessCache, getGitLabDuoModels } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import * as kimiOauth from "@oh-my-pi/pi-ai/registry/oauth/kimi";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { anthropicChunks, captureFetch, completionsChunks, responsesChunks } from "./helpers/factory-droid";

const context: Context = { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] };

const specDefaults = {
	name: "Retry policy fixture",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} satisfies Partial<ModelSpec<Api>>;

function shimModel(provider: "kimi-code" | "synthetic", kimiApiFormat?: "openai" | "anthropic"): Model<Api> {
	return buildModel({
		...specDefaults,
		id: `${provider}-retry-fixture`,
		api: "openai-completions",
		provider,
		baseUrl: "https://shim.invalid/coding/v1",
		...(kimiApiFormat ? { compat: { kimiApiFormat } } : {}),
	} satisfies ModelSpec<"openai-completions">);
}

function gitlabModel(id: string): Model<Api> {
	const model = getGitLabDuoModels().find(candidate => candidate.id === id);
	if (!model) throw new Error(`GitLab Duo fixture ${id} is missing`);
	return model;
}

const ollamaModel = buildModel({
	...specDefaults,
	id: "qwen3:8b",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
} satisfies ModelSpec<"ollama-chat">);

const json = (status: number, body: unknown, retryAfter: string) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "retry-after": retryAfter },
	});

/** How each wire refuses a request it wants retried after `retryAfter` seconds. */
const refusals = {
	openai: (retryAfter: string) => json(503, { error: { type: "server_error", message: "busy" } }, retryAfter),
	anthropic: (retryAfter: string) =>
		json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, retryAfter),
	ollama: (retryAfter: string) => json(503, { error: "server busy" }, retryAfter),
};

/** How each wire answers the retried request; a fresh capture per call, since restored mocks lose their implementation. */
const successes: Record<"completions" | "responses" | "anthropic" | "ollama", FetchImpl> = {
	completions: (input, init) => captureFetch([], completionsChunks("ok", "retry-fixture"))(input, init),
	responses: (input, init) => captureFetch([], responsesChunks("ok"))(input, init),
	anthropic: (input, init) => captureFetch([], anthropicChunks("ok"))(input, init),
	ollama: async () =>
		new Response(
			`${JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" })}\n`,
			{ headers: { "content-type": "application/x-ndjson" } },
		),
};

interface Route {
	name: string;
	model: Model<Api>;
	apiKey: string;
	options?: SimpleStreamOptions;
	refusal: (retryAfter: string) => Response;
	success: FetchImpl;
}

const kimiOpenAI: Route = {
	name: "Kimi Code over its OpenAI wire",
	model: shimModel("kimi-code", "openai"),
	apiKey: "kimi-key",
	refusal: refusals.openai,
	success: successes.completions,
};
const kimiAnthropic: Route = {
	name: "Kimi Code over its Anthropic wire",
	model: shimModel("kimi-code", "anthropic"),
	apiKey: "kimi-key",
	refusal: refusals.anthropic,
	success: successes.anthropic,
};
const syntheticOpenAI: Route = {
	name: "Synthetic over its OpenAI wire",
	model: shimModel("synthetic"),
	apiKey: "synthetic-key",
	refusal: refusals.openai,
	success: successes.completions,
};
const syntheticAnthropic: Route = {
	name: "Synthetic over its Anthropic wire",
	model: shimModel("synthetic"),
	apiKey: "synthetic-key",
	options: { syntheticApiFormat: "anthropic" },
	refusal: refusals.anthropic,
	success: successes.anthropic,
};
const ollama: Route = {
	name: "Ollama",
	model: ollamaModel,
	apiKey: "ollama",
	refusal: refusals.ollama,
	success: successes.ollama,
};

/** Routes that dropped or ignored the caller's cap and ceiling, as well as its retry-wait hook. */
const BOUND_LOSING_ROUTES = [kimiOpenAI, kimiAnthropic, syntheticOpenAI, syntheticAnthropic, ollama];

/** Every route above, and GitLab Duo's three, which kept the cap and ceiling but dropped the hook. */
const ROUTES: Route[] = [
	...BOUND_LOSING_ROUTES,
	{
		name: "GitLab Duo's Anthropic route",
		model: gitlabModel("duo-chat-sonnet-4-5"),
		apiKey: "gitlab-token",
		refusal: refusals.anthropic,
		success: successes.anthropic,
	},
	{
		name: "GitLab Duo's chat-completions route",
		model: gitlabModel("duo-chat-gpt-5-1"),
		apiKey: "gitlab-token",
		refusal: refusals.openai,
		success: successes.completions,
	},
	{
		name: "GitLab Duo's Responses route",
		model: gitlabModel("duo-chat-gpt-5-codex"),
		apiKey: "gitlab-token",
		refusal: refusals.openai,
		success: successes.responses,
	},
];

/** One turn whose first model request is refused with `retryAfter` seconds and whose second succeeds. */
async function runTurn(route: Route, retryAfter: string, bounds: SimpleStreamOptions = {}) {
	let requests = 0;
	const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
	const fetch: FetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/direct_access")) {
			return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
				headers: { "content-type": "application/json" },
			});
		}
		requests++;
		return requests === 1 ? route.refusal(retryAfter) : route.success(input, init);
	};
	const message = await streamSimple(route.model, context, {
		...route.options,
		...bounds,
		apiKey: route.apiKey,
		fetch,
		providerRetryWait,
	}).result();
	return { requests: () => requests, providerRetryWait, message };
}
/**
 * A transport may reject an over-bound `google.rpc.RetryInfo` delay before the
 * provider finalizes its error. The public stream must retain that refusal, not
 * rebuild a new 500 ms replay from the formatted message.
 */
async function runStructuredRetryInfoTurn(route: Route) {
	let requests = 0;
	const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
	const fetch: FetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/direct_access")) {
			return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
				headers: { "content-type": "application/json" },
			});
		}
		requests++;
		return requests === 1
			? new Response(
					JSON.stringify({
						error: {
							type: "server_error",
							message: "busy",
							details: [
								{
									"@type": "type.googleapis.com/google.rpc.RetryInfo",
									retryDelay: "15s",
								},
							],
						},
					}),
					{ status: 503, headers: { "content-type": "application/json" } },
				)
			: route.success(input, init);
	};
	const message = await stream(route.model, context, {
		...route.options,
		apiKey: route.apiKey,
		fetch,
		maxRetryDelayMs: 5 * 60_000,
		providerRetryWaitCeilingMs: 10_000,
		providerRetryWait,
	}).result();
	return { requests: () => requests, providerRetryWait, message };
}

beforeEach(() => {
	vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(
		Object.freeze({
			"User-Agent": "KimiCLI/test",
			"X-Msh-Platform": "kimi_cli",
			"X-Msh-Version": "test",
			"X-Msh-Device-Name": "test",
			"X-Msh-Device-Model": "test",
			"X-Msh-Os-Version": "test",
			"X-Msh-Device-Id": "test",
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	clearGitLabDuoDirectAccessCache();
});

describe("a provider behind a wrapper sleeps under the caller's retry policy", () => {
	for (const route of ROUTES) {
		it(`${route.name}: a 50 ms wait is slept through the caller's providerRetryWait`, async () => {
			const { requests, providerRetryWait, message } = await runTurn(route, "0.05");

			expect(requests()).toBe(2);
			expect(providerRetryWait).toHaveBeenCalledTimes(1);
			expect(providerRetryWait.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(50);
			expect(message.stopReason).toBe("stop");
		});
	}
	for (const route of ROUTES) {
		it(`${route.name}: a refused structured RetryInfo wait does not fall back to an outer replay`, async () => {
			const { requests, providerRetryWait, message } = await runStructuredRetryInfoTurn(route);

			expect(requests()).toBe(1);
			expect(providerRetryWait).not.toHaveBeenCalled();
			expect(message.stopReason).toBe("error");
			expect(message.errorRetryWaitRefusal).toEqual({
				waitMs: 15_000,
				limitMs: 10_000,
				option: "providerRetryWaitCeilingMs",
			});
		});
	}

	for (const route of BOUND_LOSING_ROUTES) {
		it.each([
			["providerRetryWaitCeilingMs", { maxRetryDelayMs: 5 * 60_000, providerRetryWaitCeilingMs: 1_000 }],
			["maxRetryDelayMs", { maxRetryDelayMs: 1_000 }],
		] as [string, SimpleStreamOptions][])(
			`${route.name}: a 2 s wait over the caller's 1 s %s ends the turn after one request`,
			async (_bound, bounds) => {
				const { requests, providerRetryWait, message } = await runTurn(route, "2", bounds);

				expect(requests()).toBe(1);
				expect(providerRetryWait).not.toHaveBeenCalled();
				expect(message.stopReason).toBe("error");
				expect(message.errorRetryAfterMs).toBe(2_000);
			},
			10_000,
		);
	}
});
