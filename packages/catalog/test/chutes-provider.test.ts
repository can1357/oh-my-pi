import { describe, expect, test } from "bun:test";
import { chutesModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Entries mirror live `https://llm.chutes.ai/v1/models` payloads: flat
 * `pricing` in USD per million tokens, `context_length`, `max_output_length`,
 * `input_modalities`, and `supported_features`. Ids under `chutes-test/` are
 * never bundled, so they exercise the no-reference path.
 */
function chutesModelsFetch(data: Record<string, unknown>[]): {
	calls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

async function discover(data: Record<string, unknown>[]) {
	const { calls, authorizations, fetch } = chutesModelsFetch(data);
	const models = await chutesModelManagerOptions({ apiKey: "cpk_test", fetch }).fetchDynamicModels?.();
	return { calls, authorizations, models: models ?? [] };
}

const FULL_ROW = {
	id: "chutes-test/Full-Model-TEE",
	object: "model",
	owned_by: "sglang",
	pricing: { prompt: 0.44, completion: 1.32, input_cache_read: 0.044 },
	context_length: 1048576,
	max_output_length: 131072,
	input_modalities: ["text", "image"],
	supported_features: ["json_mode", "structured_outputs", "tools", "reasoning"],
	confidential_compute: true,
};

describe("Chutes provider discovery", () => {
	test("declares live reasoning and input as authoritative", () => {
		const options = chutesModelManagerOptions({ apiKey: "cpk_test" });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.dynamicReasoningAuthoritative).toBe(true);
		expect(options.dynamicInputAuthoritative).toBe(true);
	});

	test("maps Chutes catalog metadata", async () => {
		const { calls, authorizations, models } = await discover([FULL_ROW]);

		expect(calls[0]).toBe("https://llm.chutes.ai/v1/models");
		expect(authorizations[0]).toBe("Bearer cpk_test");
		expect(models.find(model => model.id === FULL_ROW.id)).toMatchObject({
			provider: "chutes",
			api: "openai-completions",
			baseUrl: "https://llm.chutes.ai/v1",
			reasoning: true,
			supportsTools: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 131072,
			cost: { input: 0.44, output: 1.32, cacheRead: 0.044, cacheWrite: 0 },
		});
	});

	test("a row without reasoning carries no effort ladder", async () => {
		const { models } = await discover([
			{ ...FULL_ROW, id: "chutes-test/Tools-Only-TEE", supported_features: ["tools"], input_modalities: ["text"] },
		]);
		const model = models.find(entry => entry.id === "chutes-test/Tools-Only-TEE");
		expect(model?.reasoning).toBe(false);
		expect(model?.thinking).toBeUndefined();
		expect(model?.supportsTools).toBe(true);
		expect(model?.input).toEqual(["text"]);
	});

	test("a missing feature list keeps the row's other live metadata", async () => {
		const { supported_features: _features, ...row } = FULL_ROW;
		const { models } = await discover([{ ...row, id: "chutes-test/No-Features-TEE" }]);
		expect(models.find(model => model.id === "chutes-test/No-Features-TEE")).toMatchObject({
			input: ["text", "image"],
			maxTokens: 131072,
			cost: { input: 0.44, output: 1.32, cacheRead: 0.044, cacheWrite: 0 },
		});
	});

	test("a metadata-less row that is not bundled invents no capabilities", async () => {
		const { models } = await discover([
			{
				id: "chutes-test/Bare-Model",
				object: "model",
				owned_by: "chutes",
				chute_id: "00000000-0000-0000-0000-000000000000",
			},
		]);
		const bare = models.find(model => model.id === "chutes-test/Bare-Model");
		expect(bare).toMatchObject({ provider: "chutes", reasoning: false, input: ["text"] });
		expect(bare?.thinking).toBeUndefined();
		expect(bare?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});
