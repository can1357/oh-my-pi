import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const GPT_56_MODEL_IDS = [
	"daybreak-blue-latest",
	"daybreak-red-latest",
	"gpt-5.6",
	"gpt-5.6-cyber",
	"gpt-5.6-luna",
	"gpt-5.6-luna-pro",
	"gpt-5.6-sol",
	"gpt-5.6-sol-pro",
	"gpt-5.6-terra",
	"gpt-5.6-terra-pro",
];
const GPT_56_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
const CONTEXT: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("OpenAI GPT-5.6 Responses reasoning payload", () => {
	for (const id of GPT_56_MODEL_IDS) {
		test(`${id} serializes off and every supported thinking level`, () => {
			const model = getBundledModel<"openai-responses">("openai", id);
			if (!model) throw new Error(`openai/${id} must be in bundled models.json`);

			const mode = model.reasoningMode ? { mode: model.reasoningMode } : {};
			const disabled = buildParams(model, CONTEXT, { disableReasoning: true }, undefined);
			expect(disabled.params.reasoning).toEqual({ effort: "none", ...mode });

			for (const effort of GPT_56_EFFORTS) {
				const enabled = buildParams(model, CONTEXT, { reasoning: effort }, undefined);
				expect(enabled.params.reasoning).toEqual({ effort, summary: "auto", ...mode });
			}
		});
	}
});
