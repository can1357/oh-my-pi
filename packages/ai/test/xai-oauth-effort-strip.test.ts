import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const singleUserContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("xAI OAuth Responses reasoning payload (regression)", () => {
	test("xai-oauth/grok-4.5 leaves reasoning unset when no reasoning was requested", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, undefined, undefined);

		expect(params.reasoning).toBeUndefined();
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("xai-oauth/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai/grok-4.5 omits presence_penalty on reasoning models", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(
			grok45,
			singleUserContext,
			{ reasoning: Effort.High, presencePenalty: 0.4, temperature: 0.2 },
			undefined,
		);

		expect(params).not.toHaveProperty("presence_penalty");
		expect(params.temperature).toBe(0.2);
	});

	test("paid xai/grok-2 omits presence_penalty on non-reasoning Responses models", () => {
		const grok2 = getBundledModel<"openai-responses">("xai", "grok-2");
		if (!grok2) throw new Error("xai/grok-2 must be in bundled models.json");

		const { params } = buildParams(grok2, singleUserContext, { presencePenalty: 0.4, temperature: 0.2 }, undefined);

		expect(params).not.toHaveProperty("presence_penalty");
		expect(params.temperature).toBe(0.2);
	});

	test("paid xai/grok-4.5 clamps minimal reasoning effort to low", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.Minimal }, undefined);

		expect(params.reasoning).toEqual({ effort: "low" });
	});

	test("xai-oauth/grok-4.5 clamps minimal reasoning effort to low", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.Minimal }, undefined);

		expect(params.reasoning).toEqual({ effort: "low" });
	});

	test("xai-oauth/grok-4.5 replays encrypted reasoning on the next turn", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, followUpContextWithEncryptedReasoning(grok45), undefined, undefined);

		expect(params.include).toContain("reasoning.encrypted_content");
		expect(findEncryptedReasoning(params.input)).toEqual({
			type: "reasoning",
			id: "rs_xai_next_turn",
			encrypted_content: "enc_next_turn",
		});
	});

	test("paid xai/grok-4.5 replays encrypted reasoning on the next turn", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, followUpContextWithEncryptedReasoning(grok45), undefined, undefined);

		expect(findEncryptedReasoning(params.input)).toEqual({
			type: "reasoning",
			id: "rs_xai_next_turn",
			encrypted_content: "enc_next_turn",
		});
	});

	test("xai-oauth/grok-4.6 sends reasoning.effort xhigh and omits max", () => {
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok46) throw new Error("xai-oauth/grok-4.6 must be in bundled models.json");

		const { params } = buildParams(grok46, singleUserContext, { reasoning: Effort.XHigh }, undefined);

		expect(params.reasoning).toEqual({ effort: "xhigh" });
		expect(getSupportedEfforts(grok46)).not.toContain(Effort.Max);
	});
});

function followUpContextWithEncryptedReasoning(model: Model<"openai-responses">): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "internal plan",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_xai_next_turn",
					encrypted_content: "enc_next_turn",
				}),
			},
			{ type: "text", text: "done" },
		],
		api: "openai-responses",
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
		stopReason: "stop",
		timestamp: 1,
	};
	return {
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			assistant,
			{ role: "user", content: "continue", timestamp: 2 },
		],
	};
}

function findEncryptedReasoning(input: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(input)) return undefined;
	return input.find(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { type?: unknown; encrypted_content?: unknown };
		return candidate.type === "reasoning" && typeof candidate.encrypted_content === "string";
	}) as Record<string, unknown> | undefined;
}
