import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_GITHUB_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5.1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...COPILOT_GITHUB_HEADERS },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	});
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

/**
 * Verbatim body from `api.githubcopilot.com/v1/messages` for a model the
 * account or integrator is not entitled to, even when `/models` lists it.
 */
const MODEL_NOT_SUPPORTED_BODY = {
	error: {
		message: "The requested model is not supported.",
		code: "model_not_supported",
		param: "model",
		type: "invalid_request_error",
	},
};

describe("GitHub Copilot Anthropic model rejection", () => {
	// Regression: this 400 was classified as transient fleet skew, rerolled
	// eight times per request, and then re-run by the agent-level retry with a
	// hardcoded message replacing GitHub's body (#7819).
	it("surfaces GitHub's 400 body after a single request and marks it terminal", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(MODEL_NOT_SUPPORTED_BODY), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await streamAnthropic(makeCopilotClaudeModel(), testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
			providerRetryWait: async () => {},
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("The requested model is not supported.");
		expect(AIError.retriable(result.errorId)).toBe(false);
	});
});
