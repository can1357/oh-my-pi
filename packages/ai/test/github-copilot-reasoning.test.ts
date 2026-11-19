import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureResponsesPayload(model: Model<"openai-responses">): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(model, testContext, {
		apiKey: "ghu_test_copilot_token",
		reasoning: Effort.High,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function captureAnthropicPayload(model: Model<"anthropic-messages">): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, testContext, {
		apiKey: "ghu_test_copilot_token",
		isOAuth: false,
		reasoning: Effort.High,
		thinkingEnabled: true,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("GitHub Copilot reasoning request construction", () => {
	it("keeps reasoning controls for GPT-5.4 responses requests", async () => {
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model)) as {
			include?: string[];
			reasoning?: { effort?: string; summary?: string };
		};

		expect(payload.include).toContain("reasoning.encrypted_content");
		expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	it("keeps thinking controls for Claude Opus 4.6 anthropic requests", async () => {
		const model = getBundledModel("github-copilot", "claude-opus-4.6") as Model<"anthropic-messages">;
		const payload = (await captureAnthropicPayload(model)) as {
			thinking?: { type?: string };
			output_config?: { effort?: string };
			context_management?: unknown;
		};

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config).toEqual({ effort: "high" });
		// The Copilot Anthropic proxy strips Anthropic betas and demotes
		// thinking blocks to text upstream — the `context_management` field
		// would have no replayed thinking to keep and risks proxy rejection
		// of an unrecognized field. The field MUST NOT be sent (#3288).
		expect(payload.context_management).toBeUndefined();
	});
});
