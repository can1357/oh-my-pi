/**
 * Repro for #887 — OpenCode Go: Minimax M2.7 (and Qwen3.5/3.6 Plus) return 404
 * because the resolver routes them to anthropic-messages /v1/messages while
 * the OpenCode Go gateway only serves them at /v1/chat/completions.
 *
 * models.dev declares these ids with `provider.npm = "@ai-sdk/anthropic"`,
 * which by default would resolve to anthropic-messages on opencode-go. The
 * descriptor must override these specific ids to openai-completions so that
 * regenerated models.json keeps the correct routing.
 */
import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
	opencodeGoModelManagerOptions,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";

const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

describe("opencode-go resolver routes 404-ing ids to openai-completions (issue #887)", () => {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-go");

	// Per upstream models.dev (verified 2026-05-02 against
	// https://models.dev/api.json["opencode-go"].models), these three ids carry
	// `provider.npm = "@ai-sdk/anthropic"`. The naive @ai-sdk/anthropic rule
	// would route them to /v1/messages on opencode.ai/zen/go which 404s.
	const npmAnthropic: ModelsDevModel = { provider: { npm: "@ai-sdk/anthropic" }, tool_call: true };

	test.each([["minimax-m2.7"], ["qwen3.5-plus"], ["qwen3.6-plus"]])(
		"%s resolves to openai-completions on /v1/chat/completions",
		modelId => {
			const resolved = descriptor?.resolveApi?.(modelId, npmAnthropic);
			expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_BASE });
		},
	);

	test("minimax-m2.5 (control: works empirically) also resolves to openai-completions", () => {
		// models.dev currently lists minimax-m2.5 without an explicit provider.npm,
		// so it falls through to the default openai-completions resolution.
		const m25: ModelsDevModel = { tool_call: true };
		const resolved = descriptor?.resolveApi?.("minimax-m2.5", m25);
		expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_BASE });
	});

	test("runtime /v1/models refresh preserves qwen3.7-max Anthropic transport", async () => {
		let requestedUrl = "";
		const fetchMock = (async (input: string | Request | URL): Promise<Response> => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			return new Response(
				JSON.stringify({
					data: [{ id: "qwen3.7-max", name: "Qwen3.7 Max", context_length: 1000000 }],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		const options = opencodeGoModelManagerOptions({ apiKey: "opencode-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const qwenMax = models?.find(model => model.id === "qwen3.7-max");

		expect(requestedUrl).toBe("https://opencode.ai/zen/go/v1/models");
		expect(qwenMax?.api).toBe("anthropic-messages");
		expect(qwenMax?.baseUrl).toBe("https://opencode.ai/zen/go");
	});
});
