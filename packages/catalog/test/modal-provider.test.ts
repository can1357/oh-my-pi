import { describe, expect, test, vi } from "bun:test";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { modalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const GATEWAY_URL = "https://inference.us-west.modal.direct/v1";

function mockModelsResponse(): Response {
	return new Response(
		JSON.stringify({
			object: "list",
			data: [
				{
					id: "acme--ep-kimi-k3-server.us-west.modal.direct",
					name: "MoonshotAI: Kimi K3",
					base_model_id: "moonshotai/Kimi-K3",
					context_length: 1048576,
					max_output_length: 1048576,
					input_modalities: ["text"],
					output_modalities: ["text"],
					supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
					reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
					interleaved: { field: "reasoning_content" },
				},
				{
					id: "acme--ep-deepseek-v4-1-flash-server.us-west.modal.direct",
					name: "DeepSeek: DeepSeek V4.1 Flash",
					base_model_id: "deepseek-ai/DeepSeek-V4.1-Flash",
					context_length: 262144,
					max_output_length: 262144,
					input_modalities: ["text"],
					output_modalities: ["text"],
					supported_features: ["reasoning"],
					reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh", "max"] }],
				},
				{
					id: "acme--ep-embed-server.us-west.modal.direct",
					name: "Acme embed",
					input_modalities: ["text"],
					output_modalities: ["embedding"],
					supported_features: [],
				},
				{
					id: "acme--ep-voice-server.us-west.modal.direct",
					name: "Acme voice",
					input_modalities: ["audio"],
					output_modalities: ["text"],
					supported_features: [],
				},
				{
					id: "acme--ep-plain-server.us-west.modal.direct",
					name: "Acme plain",
					input_modalities: ["text"],
					output_modalities: ["text"],
					supported_features: [],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("modal provider discovery", () => {
	test("maps /v1/models endpoint fields into model specs", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			expect(url).toBe(`${GATEWAY_URL}/models`);
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.Authorization).toBe("Bearer wk-test.ws-secret");
			return mockModelsResponse();
		});

		const options = modalModelManagerOptions({ apiKey: "wk-test.ws-secret", baseUrl: GATEWAY_URL, fetch: fetchMock });
		expect(options.providerId).toBe("modal");
		expect(options.cacheProviderId).toMatch(/^modal:models-v1:[0-9a-z]+$/);

		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(3);

		const kimi = models?.find(candidate => candidate.id === "acme--ep-kimi-k3-server.us-west.modal.direct");
		expect(kimi?.name).toBe("MoonshotAI: Kimi K3");
		expect(kimi?.api).toBe("openai-completions");
		expect(kimi?.provider).toBe("modal");
		expect(kimi?.baseUrl).toBe(GATEWAY_URL);
		expect(kimi?.contextWindow).toBe(1048576);
		expect(kimi?.maxTokens).toBe(1048576);
		expect(kimi?.input).toEqual(["text"]);
		expect(kimi?.reasoning).toBe(true);
		// No `none` tier in the ladder: thinking is always-on for this endpoint.
		expect(kimi?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			requiresEffort: true,
		});
		expect(kimi?.pricingStatus).toBe("unknown");
		// `interleaved.field=reasoning_content` names the reasoning replay field.
		expect(kimi?.compat?.reasoningContentField).toBe("reasoning_content");
		expect(kimi?.compat?.requiresReasoningContentForToolCalls).toBe(true);
		// An always-on ladder has no advertised off switch.
		expect(kimi?.compat?.reasoningDisableMode).toBeUndefined();

		const deepseek = models?.find(
			candidate => candidate.id === "acme--ep-deepseek-v4-1-flash-server.us-west.modal.direct",
		);
		expect(deepseek?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.XHigh, Effort.Max],
		});
		// The advertised `none` tier maps to `reasoning_effort: "none"` on the wire.
		expect(deepseek?.compat?.reasoningDisableMode).toBe("none-effort");
		// `supported_features` without `tools` means no tool calling.
		expect(deepseek?.supportsTools).toBe(false);

		// An explicitly empty `supported_features` also disables tools.
		const plain = models?.find(candidate => candidate.id === "acme--ep-plain-server.us-west.modal.direct");
		expect(plain?.supportsTools).toBe(false);
	});

	test("marks endpoints without tools and skips non-text outputs", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => mockModelsResponse());
		const options = modalModelManagerOptions({ apiKey: "wk-test.ws-secret", baseUrl: GATEWAY_URL, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		// The embedding (`output_modalities` lacks `text`) and voice
		// (`input_modalities` lacks `text`) endpoints are filtered out.
		expect(models?.every(model => !model.id.includes("embed") && !model.id.includes("voice"))).toBe(true);
	});

	test("login validation normalizes MODAL_BASE_URL like discovery", () => {
		const login = authPolicyFor("modal")?.login;
		expect(login?.kind).toBe("api-key");
		if (login?.kind !== "api-key") return;
		expect(login.validate?.kind).toBe("models-endpoint");
		if (login.validate?.kind !== "models-endpoint") return;
		expect(login.validate.baseUrlEnv).toBe("MODAL_BASE_URL");
		expect(login.validate.baseUrlAppend).toBe("/v1");
		expect(login.validate.baseUrlPath).toBe("/models");
	});

	test("skips discovery with no token and no dedicated endpoint", () => {
		const saved = Bun.env.MODAL_BASE_URL;
		delete Bun.env.MODAL_BASE_URL;
		try {
			expect(modalModelManagerOptions().fetchDynamicModels).toBeUndefined();
		} finally {
			if (saved !== undefined) Bun.env.MODAL_BASE_URL = saved;
		}
	});

	test("normalizes MODAL_BASE_URL and scopes the cache to token plus endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async input => {
			expect(String(input)).toBe("https://acme--ep-app.modal.run/v1/models");
			return mockModelsResponse();
		});
		const options = modalModelManagerOptions({ baseUrl: "https://acme--ep-app.modal.run", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.baseUrl).toBe("https://acme--ep-app.modal.run/v1");

		const same = modalModelManagerOptions({ baseUrl: "https://acme--ep-app.modal.run/v1", fetch: fetchMock });
		expect(same.cacheProviderId).toBe(options.cacheProviderId);

		const other = modalModelManagerOptions({
			apiKey: "wk-other.ws-secret",
			baseUrl: "https://acme--ep-app.modal.run",
			fetch: fetchMock,
		});
		expect(other.cacheProviderId).not.toBe(options.cacheProviderId);
	});
});
