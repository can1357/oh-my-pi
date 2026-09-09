/**
 * Issue #2558 — `400 Error when using Claude Haiku 4.6 via Github Copilot`
 *
 * Reporter: sending any tool-bearing turn to a GitHub Copilot Claude model
 * (e.g. `github-copilot/claude-haiku-4.5`) returns
 * `400 tools.0.custom.eager_input_streaming: Extra inputs are not permitted`.
 *
 * Root cause: `buildAnthropicCompat` defaulted `supportsEagerToolInputStreaming`
 * to `true` regardless of host. That made `convertTools` emit
 * `eager_input_streaming: true` on every tool sent to
 * `api.githubcopilot.com/v1/messages`, which the Copilot proxy rejects.
 *
 * Fix: turn the flag off for the `github-copilot` host in the Anthropic
 * compat builder, AND stop pushing the legacy
 * `fine-grained-tool-streaming-2025-05-14` beta header on the Copilot
 * transport (the proxy doesn't whitelist Anthropic beta features either).
 */
import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const COPILOT_BEARER = JSON.stringify({ token: "ghc_test" });

const TOOLS: Tool[] = [
	{
		name: "ping",
		description: "ping",
		parameters: {
			type: "object",
			properties: { msg: { type: "string" } },
			required: ["msg"],
		} as TJsonSchema,
	},
];

const COPILOT_MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-haiku-4.5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
	tools: TOOLS,
};

function aborted(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

describe("issue #2558 — GitHub Copilot Anthropic transport rejects eager_input_streaming", () => {
	const model: Model<"anthropic-messages"> = buildModel(COPILOT_MODEL_SPEC);

	it("disables eager tool-input streaming on the github-copilot host", () => {
		expect(model.provider).toBe("github-copilot");
		expect(model.compat.supportsEagerToolInputStreaming).toBe(false);
	});

	it("omits the per-tool eager_input_streaming flag on the wire payload", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: COPILOT_BEARER,
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});
		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools?.[0]).not.toHaveProperty("eager_input_streaming");
	});

	it("omits the fine-grained-tool-streaming beta header on the github-copilot transport", () => {
		const options = buildAnthropicClientOptions({
			model,
			apiKey: COPILOT_BEARER,
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});
		// Either the header is absent or, if other betas pile in later, it must
		// not list `fine-grained-tool-streaming-2025-05-14`.
		expect(options.defaultHeaders["anthropic-beta"] ?? "").not.toContain("fine-grained-tool-streaming-2025-05-14");
	});
});
