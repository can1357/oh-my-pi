// Fireworks (and other OpenAI-compat backends) can abort mid-generation with an
// HTTP 400 whose body is shaped like a request-validation error but reports a
// model-side numerical fault: "Floating point NaN (not-a-number) is detected in
// generation". A byte-identical replay of the same request succeeds, so the turn
// must surface as a retryable provider error rather than a terminal 400. This
// drives the real OpenAI-compat path (HTTP response -> SDK APIError -> finalized
// AssistantMessage) instead of instantiating the error class directly, so a
// regression in status/body propagation is caught, not masked.
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

function jsonErrorFetch(status: number, body: unknown): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}
	return mockFetch as typeof fetch;
}

describe("Fireworks mid-generation NaN 400", () => {
	it("surfaces a retryable provider error through the completions path", async () => {
		const fetchMock = jsonErrorFetch(400, {
			error: {
				object: "error",
				type: "invalid_request_error",
				code: "invalid_request_error",
				message:
					"Floating point NaN (not-a-number) is detected in generation. This is a model-side numerical error.",
			},
		});

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.errorId)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		// The classification survives a re-classify from the persisted message
		// fields (the form loop-level salvage sees after the Error is gone).
		const reId = AIError.classifyMessage({ errorId: result.errorId, errorMessage: result.errorMessage });
		expect(AIError.retriable(reId)).toBe(true);
	}, 10_000);

	it("keeps a genuine request-validation 400 terminal", async () => {
		const fetchMock = jsonErrorFetch(400, {
			error: { type: "invalid_request_error", message: "Invalid value for 'temperature': must be <= 2." },
		});

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.errorId)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(false);
		const reId = AIError.classifyMessage({ errorId: result.errorId, errorMessage: result.errorMessage });
		expect(AIError.retriable(reId)).toBe(false);
	}, 10_000);
});
