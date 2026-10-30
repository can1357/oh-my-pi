import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Google reuses 429 for an account billing ceiling (replays identically forever)
// and for a per-minute throttle (retry is correct). Only `error.status` plus the
// `google.rpc.ErrorInfo` reason separates them, so the thrown message must carry
// that residue — reducing the body to `error.message` made every billing 429 look
// like a transient rate limit and burned the provider retry budget on a dead key
// (#13090).

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

async function failedTurn(status: number, body: unknown) {
	const fetchImpl: FetchImpl = async () =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const result = await streamGoogle(model, context, { apiKey: "k", fetch: fetchImpl }).result();
	const errorMessage = result.errorMessage ?? "";
	return { errorMessage, error: new AIError.ProviderHttpError(errorMessage, result.errorStatus ?? status) };
}

describe("Google error body classification", () => {
	it("keeps a billing-cap 429 terminal instead of retrying it as a transient throttle", async () => {
		const { error } = await failedTurn(429, {
			error: {
				code: 429,
				message: "Your project has exceeded its monthly spending cap.",
				status: "RESOURCE_EXHAUSTED",
				details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
			},
		});

		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isProviderRetryableError(error)).toBe(false);
	});

	it("keeps a per-minute 429 retryable so a throttle does not burn a sibling credential", async () => {
		const { error } = await failedTurn(429, {
			error: {
				code: 429,
				message: "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute.",
				status: "RESOURCE_EXHAUSTED",
				details: [
					{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
					{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
				],
			},
		});

		expect(AIError.isUsageLimit(error)).toBe(false);
		expect(AIError.isProviderRetryableError(error)).toBe(true);
	});

	it("leaves a validation 400 as the plain Google message", async () => {
		const { errorMessage } = await failedTurn(400, {
			error: {
				code: 400,
				message: "* GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty.",
				status: "INVALID_ARGUMENT",
				details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [] }],
			},
		});

		expect(errorMessage).toBe(
			"Google API error (400): * GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty.",
		);
	});
});
