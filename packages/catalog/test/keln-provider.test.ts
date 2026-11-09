import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { kelnModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A row in the shape `GET https://api.keln.ai/v1/models` returns. The prices
 * are test values, not Keln's rates: the point is the per-token conversion.
 */
function kelnRow(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		id,
		object: "model",
		owned_by: "keln",
		context_length: 1_048_576,
		input_modalities: ["text"],
		output_modalities: ["text"],
		pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.00000025" },
		pricing_lite: null,
		...overrides,
	};
}

const KELN_ROWS = [
	// Reasons at all times: no `none` in the vocabulary, `mandatory` set.
	kelnRow("zai-org/glm-5.3", {
		reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"], default_effort: "max" },
	}),
	// Keln can turn reasoning off here, though the Kimi lineage rules mark it mandatory.
	kelnRow("moonshotai/kimi-k3", {
		input_modalities: ["text", "image"],
		reasoning: { mandatory: false, supported_efforts: ["none", "low", "high", "max"], default_effort: "max" },
	}),
	// The Qwen lineage default would send `enable_thinking`.
	kelnRow("qwen/qwen3.8-27b", {
		reasoning: { mandatory: false, supported_efforts: ["none", "low", "medium", "xhigh"], default_effort: "xhigh" },
	}),
	// Publishes a reasoning block with no effort levels, so it offers no thinking control.
	kelnRow("google/gemma-4-31b-it", { reasoning: { mandatory: false } }),
	// Decision models answer through `/v1/decisions` and write no text.
	kelnRow("cloudflare/clef", { output_modalities: ["decisions"], reasoning: null }),
	kelnRow("typesafe/jev-1.14", { output_modalities: ["decisions"], reasoning: null }),
];

function modelsFetch(rows: () => Record<string, unknown>[] | null): {
	requests: { url: string; authorization: string | null }[];
	fetch: FetchImpl;
} {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetch: FetchImpl = async (input, init) => {
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		const data = rows();
		return data ? Response.json({ object: "list", data }) : new Response(null, { status: 503 });
	};
	return { requests, fetch };
}

async function discover(): Promise<Map<string, Model<"openai-completions">>> {
	const { fetch } = modelsFetch(() => KELN_ROWS);
	const specs = (await kelnModelManagerOptions({ fetch }).fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, buildModel(spec as ModelSpec<"openai-completions">)]));
}

describe("Keln model discovery", () => {
	test("reads prices, limits, and modalities from the live row and drops decision models", async () => {
		const models = await discover();

		expect([...models.keys()].sort()).toEqual([
			"google/gemma-4-31b-it",
			"moonshotai/kimi-k3",
			"qwen/qwen3.8-27b",
			"zai-org/glm-5.3",
		]);
		const kimi = models.get("moonshotai/kimi-k3")!;
		expect(kimi.input).toEqual(["text", "image"]);
		expect(kimi.contextWindow).toBe(1_048_576);
		expect(kimi.cost.input).toBeCloseTo(1);
		expect(kimi.cost.output).toBeCloseTo(2);
		expect(kimi.cost.cacheRead).toBeCloseTo(0.25);
		expect(kimi.cost.cacheWrite).toBe(0);
		// `/v1/models` publishes no output cap, so the provider rule supplies one.
		expect(kimi.maxTokens).toBe(32_768);
	});

	test("lists the roster without a key and treats a successful fetch as the complete roster", async () => {
		await using temp = await TempDir.create("@keln-roster-");
		let rows: Record<string, unknown>[] | null = KELN_ROWS;
		const { requests, fetch } = modelsFetch(() => rows);
		const options = { ...kelnModelManagerOptions({ fetch }), cacheDbPath: temp.join("models.db") };

		const first = await resolveProviderModels(options, "online");
		expect(first.models.map(model => model.id)).toContain("moonshotai/kimi-k3");
		expect(requests[0]).toEqual({ url: "https://api.keln.ai/v1/models", authorization: null });

		// A retired row must leave the picker.
		rows = KELN_ROWS.filter(row => row.id !== "moonshotai/kimi-k3");
		const retired = await resolveProviderModels(options, "online");
		expect(retired.models.map(model => model.id)).not.toContain("moonshotai/kimi-k3");

		// An outage serves the last roster instead of emptying the picker.
		rows = null;
		const outage = await resolveProviderModels(options, "online");
		expect(outage.models.map(model => model.id)).toEqual(retired.models.map(model => model.id));
	});

	test("follows the row's reasoning controls over the lineage rules", async () => {
		const models = await discover();

		expect(models.get("zai-org/glm-5.3")?.thinking).toMatchObject({
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		// The lineage marks Kimi K3 mandatory; this row publishes `none`.
		expect(models.get("moonshotai/kimi-k3")?.thinking?.requiresEffort).toBe(false);
		expect(models.get("moonshotai/kimi-k3")?.thinking?.efforts).not.toContain("none");

		// A row with no effort levels must not inherit them from the Gemma lineage.
		const gemma = models.get("google/gemma-4-31b-it")!;
		expect(gemma.reasoning).toBe(false);
		expect(gemma.thinking).toBeUndefined();
	});
});

describe("Keln chat requests", () => {
	const context: Context = {
		systemPrompt: ["You are a coding assistant."],
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	};

	async function requestBody(
		model: Model<"openai-completions">,
		options: SimpleStreamOptions & { disableReasoning?: boolean },
		requestContext: Context = context,
	): Promise<Record<string, unknown>> {
		let payload: Record<string, unknown> | undefined;
		const controller = new AbortController();
		controller.abort();
		await streamOpenAICompletions(model, requestContext, {
			...options,
			apiKey: "keln-test-key",
			maxTokens: 1_024,
			signal: controller.signal,
			onPayload: body => {
				payload = body as Record<string, unknown>;
			},
		}).result();
		return payload!;
	}

	test.each([
		{ id: "zai-org/glm-5.3", options: { reasoning: Effort.High }, wireEffort: "high" },
		// Off is the wire value `none` where the row publishes it.
		{ id: "moonshotai/kimi-k3", options: { disableReasoning: true }, wireEffort: "none" },
		// Without `none` in the row, off is the lowest level: Keln answers
		// `reasoning_not_disableable` to `none` on these models.
		{ id: "zai-org/glm-5.3", options: { disableReasoning: true }, wireEffort: "low" },
		// `reasoning_effort`, not the Qwen lineage's `enable_thinking`.
		{ id: "qwen/qwen3.8-27b", options: { reasoning: Effort.XHigh }, wireEffort: "xhigh" },
	])("sends $id with reasoning_effort $wireEffort", async ({ id, options, wireEffort }) => {
		const models = await discover();
		const payload = await requestBody(models.get(id)!, options);

		expect(payload.reasoning_effort).toBe(wireEffort);
		expect(payload).not.toHaveProperty("enable_thinking");
		expect(payload.max_tokens).toBe(1_024);
		expect(payload).not.toHaveProperty("max_completion_tokens");
		expect(payload).not.toHaveProperty("store");
		expect(payload.stream_options).toEqual({ include_usage: true });
		expect(payload.messages).toEqual([
			expect.objectContaining({ role: "system" }),
			expect.objectContaining({ role: "user" }),
		]);
	});

	test("replays reasoning_content on an assistant tool-call turn", async () => {
		const models = await discover();
		const model = models.get("zai-org/glm-5.3")!;
		const payload = await requestBody(
			model,
			{ reasoning: Effort.High },
			{
				messages: [
					{ role: "user", content: "add 1 and 2", timestamp: 0 },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "use the tool", thinkingSignature: "reasoning_content" },
							{ type: "toolCall", id: "call_1", name: "add", arguments: { a: 1, b: 2 } },
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "add",
						content: [{ type: "text", text: "3" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
		);

		const messages = payload.messages as Record<string, unknown>[];
		expect(messages.find(message => message.role === "assistant")?.reasoning_content).toBe("use the tool");
	});
});

describe("Keln API-key login", () => {
	function loginWith(respond: (apiKey: string) => Response, pasted: string) {
		const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
		const result = getProviderDefinition("keln")!.login!({
			onAuth: () => {},
			onPrompt: async () => pasted,
			fetch: async (input, init) => {
				const authorization = new Headers(init?.headers).get("authorization");
				requests.push({ url: String(input), authorization, body: JSON.parse(String(init?.body)) });
				return respond(authorization?.replace(/^Bearer /, "") ?? "");
			},
		});
		return { requests, result };
	}

	// `/v1/models` is public, so only an authenticated inference call can tell a
	// bad key from a good one.
	test("validates a pasted key with a 1-token chat probe and rejects a refused key", async () => {
		const valid = loginWith(
			() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "" } }] }),
			"Bearer sk-keln-test",
		);
		expect(await valid.result).toBe("sk-keln-test");
		expect(valid.requests[0]).toMatchObject({
			url: "https://api.keln.ai/v1/chat/completions",
			authorization: "Bearer sk-keln-test",
			body: { max_tokens: 1 },
		});

		const invalid = loginWith(
			() => Response.json({ error: { message: "Invalid API key", type: "keln_error" } }, { status: 401 }),
			"sk-keln-revoked",
		);
		await expect(invalid.result).rejects.toThrow("Invalid API key");
	});

	test("keeps the key when the probe fails for a reason other than auth", async () => {
		const retired = loginWith(
			() => Response.json({ error: { message: "Model not found", code: "model_not_found" } }, { status: 404 }),
			"sk-keln-test",
		);
		expect(await retired.result).toBe("sk-keln-test");
	});
});
