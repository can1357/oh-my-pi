import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	type AnthropicSlowModeFailure,
	type AnthropicSlowModeHooks,
	type AnthropicSlowModeRetry,
	type AnthropicSlowModeSignal,
	parseAnthropicSlowModeHeaders,
} from "@oh-my-pi/pi-ai/providers/anthropic-slow-mode";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

withOfficialAnthropicEndpoint();

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };

const SUCCESS_EVENTS = [
	{
		type: "message_start",
		message: {
			id: "msg_slow",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

function successResponse(headers: Record<string, string> = {}): Response {
	const body = `${SUCCESS_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

function errorResponse(status: number, type: string, headers: Record<string, string>): Response {
	return new Response(JSON.stringify({ type: "error", error: { type, message: `${type} test` } }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

type RecordingHooks = AnthropicSlowModeHooks & {
	observed: AnthropicSlowModeSignal[];
	failures: AnthropicSlowModeFailure[];
};

function recordingHooks(
	active: () => boolean,
	decide: (failure: AnthropicSlowModeFailure) => AnthropicSlowModeRetry | undefined,
): RecordingHooks {
	const observed: AnthropicSlowModeSignal[] = [];
	const failures: AnthropicSlowModeFailure[] = [];
	return {
		observed,
		failures,
		isActive: active,
		observe: signal => {
			observed.push(signal);
		},
		onFailure: failure => {
			failures.push(failure);
			return decide(failure);
		},
	};
}

function scriptedFetch(responses: Array<() => Response>): {
	fetch: typeof fetch;
	usageLimitHeaders: (string | null)[];
} {
	const usageLimitHeaders: (string | null)[] = [];
	const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
		usageLimitHeaders.push(new Headers(init?.headers).get("anthropic-usage-limit"));
		const next = responses[Math.min(usageLimitHeaders.length - 1, responses.length - 1)];
		return next();
	}) as typeof fetch;
	return { fetch: impl, usageLimitHeaders };
}

describe("parseAnthropicSlowModeHeaders", () => {
	it("converts server seconds to milliseconds and keeps known statuses", () => {
		const signal = parseAnthropicSlowModeHeaders({
			"anthropic-ratelimit-unified-slow-offer": "treatment",
			"anthropic-ratelimit-unified-slow-status": "slot_busy",
			"anthropic-ratelimit-unified-slow-retry-after": "15",
			"anthropic-ratelimit-unified-slow-max-wait": "600",
			"anthropic-ratelimit-unified-slow-budget-utilization": "0.25",
			"anthropic-ratelimit-unified-reset": "1780405800",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
		});
		expect(signal).toEqual({
			offer: "treatment",
			status: "slot_busy",
			retryAfterMs: 15_000,
			maxWaitMs: 600_000,
			budgetUtilization: 0.25,
			unifiedResetAtSec: 1780405800,
			unifiedLimitClaim: true,
			overageInUse: false,
		});
	});

	it("maps an unknown status to `unrecognized` and ignores a non-experiment offer value", () => {
		const signal = parseAnthropicSlowModeHeaders(
			new Headers({
				"anthropic-ratelimit-unified-slow-offer": "holdout",
				"anthropic-ratelimit-unified-slow-status": "paused_for_maintenance",
			}),
		);
		expect(signal?.offer).toBeUndefined();
		expect(signal?.status).toBe("unrecognized");
	});

	it("reads wrap-up utilization only from unified-status responses, keeping zero readings", () => {
		const inWindow = parseAnthropicSlowModeHeaders({
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-grace-5h-utilization": "0.4",
			"anthropic-ratelimit-unified-grace-7d-utilization": "garbage",
			"anthropic-ratelimit-unified-overage-status": "allowed_warning",
		});
		expect(inWindow?.graceUtilization).toEqual({ fiveHour: 0.4, sevenDay: 0 });
		expect(inWindow?.overageAllowed).toBe(true);
		// The closing response carries no other slow facts but must still reach the controller.
		expect(
			parseAnthropicSlowModeHeaders({ "anthropic-ratelimit-unified-status": "allowed" })?.graceUtilization,
		).toEqual({ fiveHour: 0, sevenDay: 0 });
		expect(
			parseAnthropicSlowModeHeaders({
				"anthropic-ratelimit-unified-grace-5h-utilization": "0.4",
				"anthropic-ratelimit-unified-5h-reset": "1780405800",
			})?.graceUtilization,
		).toBeUndefined();
	});

	it("returns undefined when a response carries no slow-lane or unified-limit facts", () => {
		expect(parseAnthropicSlowModeHeaders({ "content-type": "text/event-stream" })).toBeUndefined();
		expect(parseAnthropicSlowModeHeaders(undefined)).toBeUndefined();
	});
});

describe("Anthropic provider slow mode", () => {
	it("stamps `anthropic-usage-limit: slow` on first-party OAuth requests only while active", async () => {
		const active = scriptedFetch([() => successResponse()]);
		await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			fetch: active.fetch,
			anthropicSlowMode: recordingHooks(
				() => true,
				() => undefined,
			),
		}).result();
		expect(active.usageLimitHeaders).toEqual(["slow"]);

		const idle = scriptedFetch([() => successResponse()]);
		await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			fetch: idle.fetch,
			anthropicSlowMode: recordingHooks(
				() => false,
				() => undefined,
			),
		}).result();
		expect(idle.usageLimitHeaders).toEqual([null]);

		// API-key requests are outside the subscription lane even when the caller is active.
		const apiKey = scriptedFetch([() => successResponse()]);
		await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-api03-test",
			fetch: apiKey.fetch,
			anthropicSlowMode: recordingHooks(
				() => true,
				() => undefined,
			),
		}).result();
		expect(apiKey.usageLimitHeaders).toEqual([null]);
	});

	it("waits the hook-chosen delay on a slot_busy 429 and reports the served response", async () => {
		const waits: number[] = [];
		const scripted = scriptedFetch([
			() =>
				errorResponse(429, "rate_limit_error", {
					"anthropic-ratelimit-unified-slow-status": "slot_busy",
					"anthropic-ratelimit-unified-slow-retry-after": "20",
				}),
			() => successResponse({ "anthropic-ratelimit-unified-slow-status": "active" }),
		]);
		const hooks = recordingHooks(
			() => true,
			failure => (failure.signal?.status === "slot_busy" ? { delayMs: 12_345, capacityWait: true } : undefined),
		);
		const result = await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			credentialId: 7,
			fetch: scripted.fetch,
			anthropicSlowMode: hooks,
			providerRetryWait: async delayMs => {
				waits.push(delayMs);
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(scripted.usageLimitHeaders).toEqual(["slow", "slow"]);
		expect(waits).toEqual([12_345]);
		expect(hooks.failures).toHaveLength(1);
		expect(hooks.failures[0]).toMatchObject({
			lane: "cred:7",
			httpStatus: 429,
			sentSlow: true,
			attempts: 0,
			waitedMs: 0,
		});
		expect(hooks.observed.map(signal => signal.status)).toEqual(["active"]);
	});

	it("resends immediately with the slow header when the hook accepts a session-limit offer", async () => {
		let accepted = false;
		const scripted = scriptedFetch([
			() =>
				errorResponse(429, "rate_limit_error", {
					"anthropic-ratelimit-unified-slow-offer": "treatment",
					"anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3_600),
					"anthropic-ratelimit-unified-representative-claim": "five_hour",
				}),
			() => successResponse({ "anthropic-ratelimit-unified-slow-status": "active" }),
		]);
		const hooks = recordingHooks(
			() => accepted,
			failure => {
				if (failure.sentSlow || failure.signal?.offer !== "treatment") return undefined;
				accepted = true;
				return { delayMs: 0, capacityWait: false };
			},
		);
		const result = await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			fetch: scripted.fetch,
			anthropicSlowMode: hooks,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(scripted.usageLimitHeaders).toEqual([null, "slow"]);
	});

	it("surfaces the provider error when the hook declines", async () => {
		const scripted = scriptedFetch([
			() =>
				errorResponse(429, "rate_limit_error", {
					"anthropic-ratelimit-unified-slow-status": "weekly_limit",
					"anthropic-ratelimit-unified-representative-claim": "seven_day",
				}),
		]);
		const hooks = recordingHooks(
			() => true,
			() => undefined,
		);
		const result = await streamAnthropic(MODEL, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			fetch: scripted.fetch,
			anthropicSlowMode: hooks,
			maxRetryDelayMs: 1,
			providerRetryWait: async () => {},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(hooks.failures[0]?.signal?.status).toBe("weekly_limit");
	});
});
