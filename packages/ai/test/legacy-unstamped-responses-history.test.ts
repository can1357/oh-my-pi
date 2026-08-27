import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { openAIResponsesHistoryItemsAreEndpointOwned } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

// Responses history persisted before reference stamping existed carries no
// target at all, so a reroute cannot be detected by comparing fingerprints.
// History that carries endpoint-owned state must therefore be treated as
// foreign rather than replayed blind to whichever endpoint is dispatched to.

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ENDPOINT_OWNED_ITEMS = [
	{ type: "reasoning", id: "rs_endpoint_a", encrypted_content: "enc_endpoint_a", summary: [] },
	{
		type: "message",
		role: "assistant",
		id: "msg_endpoint_a",
		status: "completed",
		content: [{ type: "output_text", text: "answer", annotations: [] }],
	},
];

const PORTABLE_ITEMS = [
	{
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "portable answer", annotations: [] }],
	},
];

function responsesModel(baseUrl: string): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	} satisfies ModelSpec<"openai-responses">);
}

function legacyAssistant(
	items: Array<Record<string, unknown>>,
	overrides: { provider: string; model: string; api: string },
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "weighing options",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_endpoint_a",
					encrypted_content: "enc_endpoint_a",
					summary: [],
				}),
			},
			{ type: "text", text: "answer", textSignature: "msg_endpoint_a" },
		],
		timestamp: 0,
		usage: ZERO_USAGE,
		stopReason: "stop",
		...overrides,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: overrides.provider,
			dt: true,
			items,
		},
	} as unknown as AssistantMessage;
}

function contextFor(assistant: AssistantMessage): Context {
	return { messages: [assistant, { role: "user", content: "continue", timestamp: 1 }] };
}

function assistantMessageItem(items: unknown[]): { id?: string; content?: unknown } | undefined {
	return items.find(
		item => (item as { type?: string }).type === "message" && (item as { role?: string }).role === "assistant",
	) as { id?: string; content?: unknown } | undefined;
}

describe("legacy unstamped Responses history", () => {
	it("classifies endpoint-owned items and leaves portable items alone", () => {
		expect(openAIResponsesHistoryItemsAreEndpointOwned(ENDPOINT_OWNED_ITEMS)).toBe(true);
		expect(openAIResponsesHistoryItemsAreEndpointOwned(PORTABLE_ITEMS)).toBe(false);
		expect(openAIResponsesHistoryItemsAreEndpointOwned([{ type: "reasoning", summary: [] }])).toBe(true);
		expect(
			openAIResponsesHistoryItemsAreEndpointOwned([
				{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			]),
		).toBe(false);
	});

	it("drops unstamped endpoint-owned history instead of replaying it to a rerouted endpoint", () => {
		const model = responsesModel("https://responses-proxy.example.invalid/v1");
		const assistant = legacyAssistant(ENDPOINT_OWNED_ITEMS, {
			provider: "openai",
			model: "gpt-5.4",
			api: "openai-responses",
		});
		const items = buildResponsesInput({
			model,
			context: contextFor(assistant),
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			nativeHistory: { replay: true, filterReasoning: false },
		});

		expect(items.some(item => item.type === "reasoning")).toBe(false);
		expect(JSON.stringify(items)).not.toContain("enc_endpoint_a");
		expect(JSON.stringify(items)).not.toContain("rs_endpoint_a");
		const message = assistantMessageItem(items);
		expect(message?.id).toBeUndefined();
		expect(message?.content).toEqual([{ type: "output_text", text: "answer", annotations: [] }]);
	});

	it("keeps replaying unstamped history that carries no endpoint-owned state", () => {
		const model = responsesModel("https://responses-proxy.example.invalid/v1");
		const assistant = legacyAssistant(PORTABLE_ITEMS, {
			provider: "openai",
			model: "gpt-5.4",
			api: "openai-responses",
		});
		const items = buildResponsesInput({
			model,
			context: contextFor(assistant),
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
			nativeHistory: { replay: true, filterReasoning: false },
		});

		expect(JSON.stringify(items)).toContain("portable answer");
	});

	it("drops unstamped endpoint-owned Codex history on the canonical fallback too", () => {
		const model = createCodexModel("gpt-5.5", { baseUrl: "https://codex-proxy.example.invalid/api/codex" });
		const assistant = legacyAssistant(ENDPOINT_OWNED_ITEMS, {
			provider: "openai-codex",
			model: "gpt-5.5",
			api: "openai-codex-responses",
		});
		const items = convertCodexResponsesMessages(model, contextFor(assistant));

		expect(items.some(item => (item as { type?: string }).type === "reasoning")).toBe(false);
		expect(JSON.stringify(items)).not.toContain("enc_endpoint_a");
		expect(JSON.stringify(items)).not.toContain("rs_endpoint_a");
		expect(assistantMessageItem(items)?.id).toBeUndefined();
	});
});
