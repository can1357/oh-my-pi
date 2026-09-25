/**
 * Issue #5756 — `moonshot/kimi-k3 is incorrectly shown as free`
 *
 * The native Moonshot `kimi-k3` entry is dynamically discovered but has no
 * bundled/stencil.so reference, so `mapWithBundledReference` produced the
 * generic dynamic defaults: zero token cost, null limits, text-only input,
 * and `reasoning: false`. `/models` then labeled the paid model "Free".
 *
 * The fix stamps Moonshot's official K3 pricing/limits, marks it reasoning +
 * vision, and routes reasoning through OpenAI-style `reasoning_effort: "max"`
 * (K3 does NOT accept the K2.x binary `thinking: { type }` block).
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { moonshotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function moonshotModelsResponse(): Response {
	const body = {
		object: "list",
		data: [
			{ id: "kimi-k3", object: "model", owned_by: "moonshot" },
			{ id: "kimi-k2.6", object: "model", owned_by: "moonshot" },
		],
	};
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function discoverKimiK3(): Promise<ModelSpec<"openai-completions">> {
	const fetchMock = (async (_input: string | URL | Request): Promise<Response> =>
		moonshotModelsResponse()) as typeof fetch;
	const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
	const k3 = models?.find(m => m.id === "kimi-k3");
	if (!k3) throw new Error("kimi-k3 not discovered");
	return k3;
}

function encodeSseChunks(chunks: ReadonlyArray<Record<string, unknown>>): string {
	return `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

describe("issue #5756 — moonshot kimi-k3 pricing and wire format", () => {
	it("discovery mapper stamps K3 pricing, limits, vision, and reasoning", async () => {
		const k3 = await discoverKimiK3();
		expect(k3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		expect(k3.contextWindow).toBe(1_048_576);
		expect(k3.maxTokens).toBe(131_072);
		expect(k3.input).toEqual(["text", "image"]);
		expect(k3.reasoning).toBe(true);
		// The effort ladder itself tracks the generated catalog policies; the
		// binding K3 contract — reasoning_effort=max on the wire, no K2-style
		// thinking block — is asserted by the wire-body test below.
		expect(k3.thinking?.mode).toBe("effort");
		expect(k3.thinking?.efforts?.length).toBeGreaterThan(0);
	});

	it("K3 native compat uses the OpenAI reasoning_effort dialect, not the K2 thinking block", async () => {
		const model = buildModel(await discoverKimiK3());
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compat.reasoningDisableMode).toBe("lowest-effort");
		expect(model.compat.supportsReasoningEffort).toBe(true);
	});

	it("wire body carries reasoning_effort=max and omits the thinking block", async () => {
		const model = buildModel(await discoverKimiK3());
		let body: Record<string, unknown> = {};
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof init?.body === "string" ? init.body : "";
			body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			return new Response(
				encodeSseChunks([
					{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoning: "max",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(body.reasoning_effort).toBe("max");
		expect("thinking" in body).toBe(false);
		// Moonshot-native Kimi rate-limits on max_tokens, not
		// max_completion_tokens; K3's default reaches its advertised 131K cap.
		expect(body.max_tokens).toBe(131_072);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("keeps reasoning_effort=max on forced-tool-choice turns (mandatory K3 reasoning)", async () => {
		// K3 always reasons via `reasoning_effort: "max"`. The K2.x Kimi
		// `disableReasoningOnForcedToolChoice` rule (Moonshot 400s on forced
		// tool_choice + the binary `thinking` block, #827) must NOT strip K3's
		// effort, or plan-mode `toolChoice` turns run without the required
		// reasoning (#5758 review).
		const model = buildModel(await discoverKimiK3());
		let body: Record<string, unknown> = {};
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof init?.body === "string" ? init.body : "";
			body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			return new Response(
				encodeSseChunks([
					{
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{ index: 0, id: "c1", type: "function", function: { name: "plan", arguments: "{}" } },
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [{ name: "plan", description: "plan", parameters: { type: "object", properties: {} } }],
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoning: "max",
			maxTokens: 131_072,
			toolChoice: { type: "tool", name: "plan" },
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(body.reasoning_effort).toBe("max");
		expect("thinking" in body).toBe(false);
		expect(body.max_tokens).toBe(131_072);
	});
});
describe("unbundled Moonshot variants (no reference row)", () => {
	// `kimi-k3` / `kimi-k2.6` above ride bundled references, which bypass the
	// mapper's no-reference branch entirely. These ids have no bundled row, so
	// they exercise the exact #5756/#2113 failure paths: the mapper seeds only
	// live facts (structured reasoning, official K3 pricing, model-limits
	// fallbacks) and the built model derives rule-owned input/thinking.
	async function discoverUnbundled(): Promise<Map<string, ModelSpec<"openai-completions">>> {
		const body = {
			object: "list",
			data: [
				{ id: "kimi-k3-turbo", object: "model", owned_by: "moonshot" },
				{ id: "kimi-k2.6-turbo", object: "model", owned_by: "moonshot" },
			],
		};
		const fetchMock = (async (_input: string | URL | Request): Promise<Response> =>
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
		return new Map((models ?? []).map(model => [model.id, model]));
	}

	it("seeds an unbundled K3-family id with official pricing, limits, and mandatory reasoning (#5756)", async () => {
		const k3 = (await discoverUnbundled()).get("kimi-k3-turbo");
		if (!k3) throw new Error("kimi-k3-turbo not discovered");
		// Raw spec: live/seed facts only — modalities and the ladder stay unset.
		expect(k3.reasoning).toBe(true);
		expect(k3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		expect(k3.contextWindow).toBe(1_048_576);
		expect(k3.maxTokens).toBe(131_072);
		expect(k3.input).toEqual(["text"]);
		expect(k3.thinking).toBeUndefined();
		// Built model: rule-owned modalities and the census K3 effort surface.
		const built = buildModel(k3);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(built.thinking?.requiresEffort).toBe(true);
		expect(built.thinking?.defaultLevel).toBe(Effort.Max);
	});

	it("derives the K2.x thinking block and modalities for an unbundled K2.6 variant (#2113)", async () => {
		const k26 = (await discoverUnbundled()).get("kimi-k2.6-turbo");
		if (!k26) throw new Error("kimi-k2.6-turbo not discovered");
		expect(k26.reasoning).toBe(true);
		expect(k26.thinking).toBeUndefined();
		const built = buildModel(k26);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});
});
