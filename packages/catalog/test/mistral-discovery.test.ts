import { describe, expect, it } from "bun:test";
import { mistralModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function capabilities(overrides: Record<string, boolean>) {
	return {
		completion_chat: false,
		function_calling: false,
		reasoning: false,
		vision: false,
		ocr: false,
		moderation: false,
		audio_transcription: false,
		audio_speech: false,
		...overrides,
	};
}

async function discoverMistralModels(payload: unknown) {
	const options = mistralModelManagerOptions({
		apiKey: "test-key",
		fetch: async () => Response.json(payload),
	});
	const models = await options.fetchDynamicModels?.();
	if (!models) throw new Error("mistral discovery failed");
	return models;
}

describe("mistral discovery", () => {
	it("keeps only rows Mistral flags as chat-capable", async () => {
		const models = await discoverMistralModels({
			object: "list",
			data: [
				{
					id: "mistral-small-latest",
					capabilities: capabilities({ completion_chat: true, function_calling: true }),
				},
				{ id: "mistral-embed", capabilities: capabilities({}) },
				{ id: "mistral-ocr-latest", capabilities: capabilities({ ocr: true, function_calling: true }) },
				{ id: "mistral-moderation-2603", capabilities: capabilities({ moderation: true }) },
				{ id: "voxtral-mini-transcribe-3", capabilities: capabilities({ audio_transcription: true }) },
				{ id: "voxtral-mini-tts-latest", capabilities: capabilities({ audio_speech: true }) },
			],
		});

		expect(models.map(model => model.id)).toEqual(["mistral-small-latest"]);
	});

	it("reads context, vision, and reasoning from the row's capabilities", async () => {
		const models = await discoverMistralModels({
			data: [
				{
					id: "labs-unbundled-chat-2611",
					max_context_length: 262144,
					capabilities: capabilities({ completion_chat: true, vision: true, reasoning: true }),
				},
				{
					id: "labs-unbundled-text-2611",
					max_context_length: 32768,
					capabilities: capabilities({ completion_chat: true }),
				},
			],
		});

		const multimodal = models.find(model => model.id === "labs-unbundled-chat-2611");
		expect(multimodal?.contextWindow).toBe(262144);
		expect(multimodal?.input).toEqual(["text", "image"]);
		expect(multimodal?.reasoning).toBe(true);

		const text = models.find(model => model.id === "labs-unbundled-text-2611");
		expect(text?.contextWindow).toBe(32768);
		expect(text?.input).toEqual(["text"]);
		expect(text?.reasoning).toBe(false);
	});

	it("keeps rows without a capabilities object", async () => {
		const models = await discoverMistralModels({ data: [{ id: "gateway-model" }] });

		expect(models.map(model => model.id)).toEqual(["gateway-model"]);
	});
});
