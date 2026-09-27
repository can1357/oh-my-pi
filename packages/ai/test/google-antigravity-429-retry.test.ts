/**
 * Antigravity detail-free 429 RESOURCE_EXHAUSTED retry contract (issue #12655).
 *
 * The Cloud Code Assist API returns the bare gRPC boilerplate
 * "Resource has been exhausted (e.g. check quota)." with no quota/reset detail.
 * That must classify as transient MODEL_CAPACITY_EXHAUSTED — bounded
 * retry-with-backoff honoring Retry-After — never as QUOTA_EXHAUSTED (whose
 * 30-minute heuristic exceeds retry.maxDelayMs, so the turn surfaced a raw 429
 * after a single attempt on a quota-healthy account). Bodies carrying a real
 * quota signal keep their authoritative QUOTA_EXHAUSTED classification.
 */
import { describe, expect, it } from "bun:test";
import { extractRetryHint } from "@oh-my-pi/pi-utils/fetch-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	calculateRateLimitBackoffMs,
	isUsageLimitOutcome,
	parseRateLimitReason,
} from "@oh-my-pi/pi-ai/error/rate-limit";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const DETAIL_FREE_429_BODY = JSON.stringify({
	error: {
		code: 429,
		message: "Resource has been exhausted (e.g. check quota).",
		status: "RESOURCE_EXHAUSTED",
	},
});

function ccaChunk(text: string): Record<string, unknown> {
	return {
		response: {
			candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
		},
	};
}

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
	return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3.8-flash-high",
	name: "Gemini 3.8 Flash High (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const credentials = JSON.stringify({ token: "token", projectId: "proj-123" });

async function drainResult(
	stream: AssistantMessageEventStream,
): Promise<{ text: string; stopReason: string | undefined }> {
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
	}
	const result = await stream.result();
	return { text, stopReason: result.stopReason };
}

describe("antigravity detail-free 429 classification", () => {
	it("maps the boilerplate to MODEL_CAPACITY_EXHAUSTED instead of QUOTA_EXHAUSTED", () => {
		expect(parseRateLimitReason(`Cloud Code Assist API error (429): ${DETAIL_FREE_429_BODY}`)).toBe(
			"MODEL_CAPACITY_EXHAUSTED",
		);
	});

	it("stays out of the credential-rotation lane", () => {
		expect(isUsageLimitOutcome(429, `Cloud Code Assist API error (429): ${DETAIL_FREE_429_BODY}`)).toBe(false);
	});

	it("keeps real quota detail authoritative", () => {
		const withQuota =
			"Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota). Quota exceeded for project.";
		expect(parseRateLimitReason(withQuota)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, withQuota)).toBe(true);
	});

	it("classifies the surfaced provider error as transient and retriable", () => {
		const error = new AIError.GeminiCliApiError(`Cloud Code Assist API error (429): ${DETAIL_FREE_429_BODY}`, 429);
		expect(AIError.isUsageLimit(error)).toBe(false);
		expect(AIError.is(AIError.classify(error), AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
	});
});

describe("antigravity detail-free 429 retry path", () => {
	it("honors Retry-After: scripted 429 retries once then succeeds", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			if (calls === 1) {
				return errorResponse(429, DETAIL_FREE_429_BODY, { "retry-after": "0" });
			}
			const response = sse(ccaChunk("Recovered."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: credentials,
			antigravityEndpointMode: "production",
			fetch: fetchMock,
			maxRetryDelayMs: 60_000,
		});
		const { text, stopReason } = await drainResult(stream);

		expect(calls).toBe(2);
		expect(stopReason).toBe("stop");
		expect(text).toBe("Recovered.");
	});

	it("uses bounded backoff without a header: succeeds within the retry budget", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			if (calls === 1) return errorResponse(429, DETAIL_FREE_429_BODY);
			const response = sse(ccaChunk("Recovered."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: credentials,
			antigravityEndpointMode: "production",
			fetch: fetchMock,
			maxRetryDelayMs: 60_000,
		});
		const { text, stopReason } = await drainResult(stream);

		// First 429 attempt + one bounded-backoff retry that succeeds: no raw
		// 429 surfaces, and the request is not retried in a loop.
		expect(calls).toBe(2);
		expect(stopReason).toBe("stop");
		expect(text).toBe("Recovered.");
	});

	it("backoff for the detail-free 429 stays within the session retry cap", () => {
		const errorText = `Cloud Code Assist API error (429): ${DETAIL_FREE_429_BODY}`;
		// A provider Retry-After hint wins when present …
		expect(extractRetryHint(new Headers({ "retry-after": "2" }), errorText)).toBe(2_000);
		// … and the heuristic fallback (no header) must fit under the default
		// 60s session cap, unlike the 30-minute QUOTA_EXHAUSTED wait that caused
		// the raw single-attempt 429 surface in #12655.
		const fallbackMs = calculateRateLimitBackoffMs(parseRateLimitReason(errorText));
		expect(fallbackMs).toBeLessThanOrEqual(120_000);
	});
});
