import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: contributorId,
						object: "model",
						owned_by: "meta",
						tags: ["tool-use", "reasoning", "vision"],
						context_window: 1_048_576,
						max_tokens: 1_048_576,
						pricing: { input: 0.0000001, output: 0.0000002 },
					},
					{
						id: controlId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const contributor = byId.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = byId.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});

	test("maps type:evaluation rows to typesafe judges on the /typesafe surface", async () => {
		// Verified live 2026-11-05: `POST {base}/typesafe/v1/systemone` with the
		// canonical System One body answers 200 with native typed answers, so
		// evaluation rows are `api: "typesafe"` judges — not chat models.
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: "convaiinnovations/laya",
						object: "model",
						type: "evaluation",
						context_window: 8192,
						max_tokens: 0,
						pricing: { input: "0.0000000105", output: "0" },
					},
					{
						id: "scaledown/scaledown-classify-1",
						object: "model",
						type: "evaluation",
						context_window: 0,
						max_tokens: 0,
						pricing: { input: "0.00000005", output: "0" },
					},
					{
						id: "anthropic/claude-sonnet-4-5-20250929",
						object: "model",
						type: "language",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
					{
						id: "some/text-embedding",
						object: "model",
						type: "embedding",
						context_window: 8192,
					},
				],
			})) as unknown as typeof fetch;

		const models = await vercelAiGatewayModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const laya = byId.get("convaiinnovations/laya");
		expect(laya).toMatchObject({
			api: "typesafe",
			kind: "judge",
			baseUrl: "https://ai-gateway.vercel.sh/typesafe",
			reasoning: false,
			input: ["text"],
			supportsTools: false,
			cost: { output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: null,
		});
		expect(laya?.cost.input).toBeCloseTo(0.0105, 12);

		// Upstream reports 0 for unknown limits; the row stays unknown, not 0.
		const scaledown = byId.get("scaledown/scaledown-classify-1");
		expect(scaledown).toMatchObject({
			api: "typesafe",
			kind: "judge",
			baseUrl: "https://ai-gateway.vercel.sh/typesafe",
			contextWindow: null,
			maxTokens: null,
		});

		// Chat rows keep their transport and gate; non-chat, non-evaluation
		// rows stay excluded.
		expect(byId.get("anthropic/claude-sonnet-4-5-20250929")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://ai-gateway.vercel.sh",
		});
		expect(byId.has("some/text-embedding")).toBe(false);
	});

	test("rebases evaluation judges onto a custom gateway root", async () => {
		// A host-only and a `/v1` override both name the gateway root; the
		// judges ride its `/typesafe` sibling, like the default host.
		for (const [configured, expected] of [
			["https://proxy.example", "https://proxy.example/typesafe"],
			["https://proxy.example/v1", "https://proxy.example/typesafe"],
		]) {
			const fetchMock = (async () =>
				Response.json({
					object: "list",
					data: [
						{ id: "typesafe-ai/jev", object: "model", type: "evaluation", context_window: 32000 },
						{
							id: "typesafe-ai/jev-1.14.0",
							object: "model",
							type: "evaluation",
							tags: ["vision"],
							context_window: 32000,
						},
					],
				})) as unknown as typeof fetch;
			const models = await vercelAiGatewayModelManagerOptions({
				baseUrl: configured,
				fetch: fetchMock,
			}).fetchDynamicModels?.();
			const byId = new Map((models ?? []).map(model => [model.id, model]));
			expect(byId.get("typesafe-ai/jev")?.baseUrl).toBe(expected);
			// The vision tag is the only image signal the roster carries.
			expect(byId.get("typesafe-ai/jev-1.14.0")).toMatchObject({
				baseUrl: expected,
				input: ["text", "image"],
			});
		}
	});

	test("seeded evaluation ids resolve to kind judge", () => {
		// `kind` is the derived contract: seed rows carry no kind, the KDL
		// residue rule assigns it. The offline fallback covers the ids
		// probed live (laya + scaledown answered 200; jev routed to
		// typesafe-ai, free-tier gated on the probe key).
		for (const id of ["convaiinnovations/laya", "scaledown/scaledown-classify-1", "typesafe-ai/jev"]) {
			const seed = seedModels("vercel-ai-gateway").find(model => model.id === id);
			if (!seed) throw new Error(`missing vercel-ai-gateway seed ${id}`);
			expect(buildModel(seed).kind).toBe("judge");
		}
	});
});
