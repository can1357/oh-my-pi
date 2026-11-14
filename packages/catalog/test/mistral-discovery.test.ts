import { describe, expect, it } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { mistralModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

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

type ContractFields = Pick<
	ModelSpec,
	"id" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "cost" | "thinking"
>;

/** The metadata an alias row should inherit from the bundled model it aliases. */
function contract(id: string, models: readonly ContractFields[]) {
	const model = models.find(candidate => candidate.id === id);
	return (
		model && {
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: model.cost,
			efforts: model.thinking?.efforts,
		}
	);
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

	it("maps an alias id to the bundled row of the model it aliases and keeps its own id", async () => {
		const chat = capabilities({ completion_chat: true, function_calling: true, reasoning: true, vision: true });
		const models = await discoverMistralModels({
			data: [
				{
					id: "mistral-vibe-cli-latest",
					name: "mistral-medium-latest",
					aliases: ["mistral-medium-latest", "mistral-medium-2604", "mistral-vibe-cli-with-tools"],
					max_context_length: 262144,
					capabilities: chat,
				},
				{
					id: "mistral-vibe-cli-fast",
					name: "mistral-small-2603",
					aliases: ["mistral-small-2603", "mistral-small-latest"],
					max_context_length: 262144,
					capabilities: chat,
				},
			],
		});
		const bundled = getBundledModels("mistral");

		expect(models.map(model => model.id).sort()).toEqual(["mistral-vibe-cli-fast", "mistral-vibe-cli-latest"]);
		expect(contract("mistral-vibe-cli-latest", models)).toEqual(contract("mistral-medium-latest", bundled));
		expect(contract("mistral-vibe-cli-fast", models)).toEqual(contract("mistral-small-2603", bundled));
		expect(contract("mistral-vibe-cli-latest", models)?.cost.input).toBeGreaterThan(0);
	});

	it("keeps discovery defaults when no alias has a bundled row", async () => {
		const models = await discoverMistralModels({
			data: [
				{
					id: "acme-chat-1",
					name: "acme-chat-latest",
					aliases: ["acme-chat-latest"],
					capabilities: capabilities({ completion_chat: true }),
				},
			],
		});

		expect(contract("acme-chat-1", models)).toEqual({
			reasoning: false,
			input: ["text"],
			contextWindow: null,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			efforts: undefined,
		});
	});
});
