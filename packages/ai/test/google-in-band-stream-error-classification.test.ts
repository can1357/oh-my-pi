import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Google reuses 429 for an account billing ceiling (replays identically forever)
// and for a per-minute throttle (retry is correct). Only `error.status` plus the
// `google.rpc.ErrorInfo` reason separates them. The HTTP path kept that residue
// after #13090; the in-band paths (`chunk.error` inside a 200 SSE stream) did
// not, so the identical body classified differently purely on delivery framing:
// terminal account-quota exhaustion in-band, retryable throttle over HTTP. That
// burns a healthy sibling credential as a false quota, which
// `error/rate-limit.ts` explicitly warns about.
//
// Contract: for any Google error body, the in-band delivery classifies
// identically to the HTTP non-2xx delivery, in both directions. A throttle must
// stay retryable in-band; a billing cap must stay terminal in-band.

const billingCapBody = {
	code: 429,
	message: "Your project has exceeded its monthly spending cap.",
	status: "RESOURCE_EXHAUSTED",
	details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
};

const throttleBody = {
	code: 429,
	message: "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute.",
	status: "RESOURCE_EXHAUSTED",
	details: [
		{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
		{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
	],
};

// Counterweight: the same throttle, but its human-readable message embeds a JSON
// fragment. The residue is appended after that fragment, so recovering it means
// scanning past the first `{`. A first-brace-only parse drops the residue, the
// text alone reads as quota wording, and the throttle rotates a credential again.
const throttleWithBracesBody = {
	code: 429,
	message: 'Quota exceeded for metric {"quota_id":"generate_content_requests_per_minute"}.',
	status: "RESOURCE_EXHAUSTED",
	details: [
		{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
		{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
	],
};

interface Verdict {
	usageLimit: boolean;
	retryable: boolean;
}

function verdictOf(error: unknown): Verdict {
	return { usageLimit: AIError.isUsageLimit(error), retryable: AIError.isProviderRetryableError(error) };
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function sseResponse(payloads: unknown[]): Response {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const payload of payloads) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function genAiModel(): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

function geminiCliModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "gemini-2.5-flash",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

/** HTTP non-2xx delivery of `body`, the reference classification. */
async function genAiHttpTurn(body: unknown): Promise<Verdict> {
	const fetchImpl: FetchImpl = async () => new Response(JSON.stringify({ error: body }), { status: 429 });
	const result = await streamGoogle(genAiModel(), context, { apiKey: "k", fetch: fetchImpl }).result();
	return verdictOf(new AIError.ProviderHttpError(result.errorMessage ?? "", result.errorStatus ?? 429));
}

/** In-band delivery of the same `body` inside a 200 SSE stream. */
async function genAiInBandTurn(body: unknown): Promise<Verdict> {
	const fetchImpl: FetchImpl = async () => sseResponse([{ error: body }]);
	const result = await streamGoogle(genAiModel(), context, { apiKey: "k", fetch: fetchImpl }).result();
	expect(result.stopReason).toBe("error");
	return verdictOf(new AIError.ProviderHttpError(result.errorMessage ?? "", result.errorStatus ?? 429));
}

/** In-band delivery on the Cloud Code Assist provider. */
async function geminiCliInBandTurn(body: unknown): Promise<Verdict> {
	const fetchImpl: FetchImpl = async () => sseResponse([{ error: body }]);
	const result = await streamGoogleGeminiCli(geminiCliModel(), context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		fetch: fetchImpl,
	}).result();
	expect(result.stopReason).toBe("error");
	return verdictOf(new AIError.ProviderHttpError(result.errorMessage ?? "", result.errorStatus ?? 429));
}

describe("google-generative-ai in-band stream error classification", () => {
	it("classifies an in-band billing-cap 429 exactly like the HTTP 429 delivery", async () => {
		expect(await genAiInBandTurn(billingCapBody)).toEqual(await genAiHttpTurn(billingCapBody));
	});

	it("classifies an in-band per-minute throttle exactly like the HTTP 429 delivery", async () => {
		expect(await genAiInBandTurn(throttleBody)).toEqual(await genAiHttpTurn(throttleBody));
	});

	it("keeps an in-band billing-cap 429 terminal instead of rotating credentials", async () => {
		const { usageLimit, retryable } = await genAiInBandTurn(billingCapBody);
		expect(usageLimit).toBe(true);
		expect(retryable).toBe(false);
	});

	it("keeps an in-band per-minute throttle retryable so it does not burn a sibling credential", async () => {
		const { usageLimit, retryable } = await genAiInBandTurn(throttleBody);
		expect(usageLimit).toBe(false);
		expect(retryable).toBe(true);
	});

	it("classifies an in-band Cloud Code Assist billing-cap 429 as terminal quota", async () => {
		const { usageLimit, retryable } = await geminiCliInBandTurn(billingCapBody);
		expect(usageLimit).toBe(true);
		expect(retryable).toBe(false);
	});

	it("classifies an in-band Cloud Code Assist throttle as retryable", async () => {
		const { usageLimit, retryable } = await geminiCliInBandTurn(throttleBody);
		expect(usageLimit).toBe(false);
		expect(retryable).toBe(true);
	});

	it("keeps an in-band throttle retryable when its message embeds a JSON fragment", async () => {
		expect(await genAiInBandTurn(throttleWithBracesBody)).toEqual(await genAiHttpTurn(throttleWithBracesBody));
		const { usageLimit, retryable } = await genAiInBandTurn(throttleWithBracesBody);
		expect(usageLimit).toBe(false);
		expect(retryable).toBe(true);
	});
});
