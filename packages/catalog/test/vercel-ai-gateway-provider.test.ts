import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

	test("maps type:evaluation rows to api typesafe kind judge beside chat rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const jevId = "typesafe-ai/jev";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: chatId,
						name: "Claude Sonnet 4.5",
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
					{
						id: jevId,
						name: "Jev",
						object: "model",
						owned_by: "typesafe-ai",
						type: "evaluation",
						context_window: 32_000,
						pricing: { input: 0.000000042, output: 0 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const chat = byId.get(chatId);
		expect(chat?.api).toBe("anthropic-messages");
		expect(chat?.kind ?? "chat").toBe("chat");

		const jev = byId.get(jevId);
		expect(jev).toBeDefined();
		expect(jev?.api).toBe("typesafe");
		expect(jev?.kind).toBe("judge");
		expect(jev?.name).toBe("Jev");
		expect(jev?.reasoning).toBe(false);
		expect(jev?.input).toEqual(["text"]);
		expect(jev?.supportsTools).toBe(false);
		expect(jev?.cost?.input).toBeCloseTo(0.042, 9);
		expect(jev?.cost?.output).toBe(0);
		expect(jev?.contextWindow).toBe(32_000);
		// The mapper carries no judgment: the vercel-ai-gateway KDL default
		// supplies the /v1/evaluate wire contract through buildModel.
		expect(jev).not.toHaveProperty("judgment");
		// The judgment defaults must survive discovery → buildModel so ChainJudge routes at /v1/evaluate.
		if (!jev) throw new Error("expected the jev evaluation row");
		expect(buildModel(jev).judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
		expect(buildModel(jev).judgment?.route).toBe("/v1/evaluate");
		// Spec (user modelOverrides merged pre-rebuild) wins key-wise over the catalog baseline.
		expect(buildModel({ ...jev, judgment: { route: "/v1/custom", typeMap: { score: "number" } } }).judgment).toEqual({
			route: "/v1/custom",
			typeMap: { noul: "boolean", score: "number" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("chat filter drops non-tool-use rows while keeping evaluation rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const droppedChatId = "anthropic/claude-haiku-4-5-20251001";
		const jevId = "typesafe-ai/jev";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: chatId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
					{
						id: droppedChatId,
						object: "model",
						owned_by: "anthropic",
						tags: ["reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000001, output: 0.000005 },
					},
					{
						id: jevId,
						object: "model",
						owned_by: "typesafe-ai",
						type: "evaluation",
						context_window: 32_000,
						pricing: { input: 0.000000042, output: 0 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get(chatId)).toBeDefined();
		expect(byId.get(droppedChatId)).toBeUndefined();
		expect(byId.get(jevId)).toBeDefined();
	});
});
