import { describe, expect, test } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Type } from "@sinclair/typebox";

const context: Context = {
	systemPrompt: ["be terse"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
	tools: [
		{
			name: "echo",
			description: "Echo text",
			parameters: Type.Object({ t: Type.String() }),
		},
	],
};

interface ToolChoicePayload {
	toolConfig?: { toolChoice?: Record<string, unknown> };
	additionalModelRequestFields?: { thinking?: unknown };
}

/** Every Converse request carries `messages`; tools in context imply a `toolConfig` object. */
function isToolChoicePayload(payload: unknown): payload is ToolChoicePayload {
	if (typeof payload !== "object" || payload === null) return false;
	if (!("messages" in payload) || !Array.isArray(payload.messages)) return false;
	return "toolConfig" in payload && typeof payload.toolConfig === "object" && payload.toolConfig !== null;
}

async function capture(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions,
): Promise<ToolChoicePayload> {
	const controller = new AbortController();
	const { promise, resolve, reject } = Promise.withResolvers<ToolChoicePayload>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		signal: controller.signal,
		...options,
		onPayload: payload => {
			if (isToolChoicePayload(payload)) resolve(payload);
			else reject(new Error("expected a Bedrock request payload with toolConfig"));
			controller.abort();
			return undefined;
		},
	});
	return promise;
}

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
	if (!model) throw new Error(`missing bundled model ${id}`);
	return model;
}

describe("Bedrock forced tool choice", () => {
	// Opus/Sonnet 5.5 reject `toolChoice: {any}` / `{tool}` with 400 "tool_choice:
	// type \"tool\" and \"any\" are not supported for this model" regardless of thinking.
	for (const id of ["us.anthropic.claude-opus-5-5", "global.anthropic.claude-sonnet-5-5"]) {
		test(`downgrades forced choice to auto for ${id} and keeps thinking`, async () => {
			const model = bedrockModel(id);
			expect(model.compat.supportsForcedToolChoice).toBe(false);

			const anyPayload = await capture(model, { toolChoice: "any", reasoning: Effort.Low });
			expect(anyPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
			expect(anyPayload.additionalModelRequestFields?.thinking).toBeDefined();

			const namedPayload = await capture(model, {
				toolChoice: { type: "tool", name: "echo" },
				reasoning: Effort.Low,
			});
			expect(namedPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
			expect(namedPayload.additionalModelRequestFields?.thinking).toBeDefined();
		});
	}

	test("still forces the tool on Opus 5, dropping thinking instead", async () => {
		const payload = await capture(bedrockModel("us.anthropic.claude-opus-5"), {
			toolChoice: "any",
			reasoning: Effort.Low,
		});
		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
	});
});
