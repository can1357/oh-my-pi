import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildGrokbotStaticSeed } from "@oh-my-pi/pi-catalog/provider-models/grokbot";
import { toInferenceMessages } from "../../src/providers/grokbot";
import type { AssistantMessage } from "../../src/types";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import { decodeInferenceStreamRequest, encodeInferenceStreamRequest } from "../../src/providers/grokbot/proto";

test("Opus 5.5's captured defaults become Sand wire parameters without an unadvertised thinking flag", () => {
	const requestedModel = resolveGrokbotRequestedModel("grokbot/claude-opus-5-5", {
		sandParameterIds: ["context", "effort", "fast"],
		sandParameterDefaults: { context: "300k", effort: "medium", fast: "false" },
	});
	const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ requestedModel }));
	const wire = decoded.requestedModel as { modelId: string; parameters: Array<{ id: string; value: string }> };
	expect(wire.modelId).toBe("claude-opus-5-5");
	expect(Object.fromEntries(wire.parameters.map(p => [p.id, p.value]))).toEqual({
		context: "300k",
		effort: "medium",
		fast: "false",
	});
});

test("signed native content survives effort variants and protobuf field 18 without serialization changes", () => {
	const model = buildModel(buildGrokbotStaticSeed().find(row => row.id === "claude-opus-5-5")!);
	const nativeContent = '[ { "type": "thinking", "thinking": "fixture", "signature": "fixture-signature" } ]';
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "grokbot-sand",
		provider: "grokbot",
		model: "claude-opus-5-5-medium",
		upstreamModel: "claude-opus-5-5-high",
		content: [{ type: "text", text: "fixture" }],
		providerPayload: {
			type: "anthropicNativeContent",
			provider: "grokbot",
			model: "claude-opus-5-5-high",
			blocks: [],
			nativeContent,
		},
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const wire = decodeInferenceStreamRequest(
		encodeInferenceStreamRequest({
			messages: toInferenceMessages({ messages: [assistant] }, model),
			requestedModel: { modelId: model.id },
		}),
	);
	expect((wire.messages as Array<{ anthropicNativeContent?: string }>)[0]?.anthropicNativeContent).toBe(nativeContent);
	const foreign = toInferenceMessages(
		{
			messages: [{ ...assistant, upstreamModel: "claude-sonnet-5-5" }],
		},
		model,
	);
	expect(foreign).toEqual([{ role: 2, text: "fixture" }]);
});
