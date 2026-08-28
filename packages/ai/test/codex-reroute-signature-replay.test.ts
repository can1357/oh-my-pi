import { describe, expect, it } from "bun:test";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { getOpenAIResponsesReferenceTarget } from "@oh-my-pi/pi-ai/utils";
import { createCodexModel } from "./helpers";

// Codex reasoning ids and encrypted content are minted by the endpoint that
// produced them. Rerouting the same model to another endpoint must strip that
// state from the canonical fallback as well, not just from the native replay.

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function codexModel(baseUrl: string): Model<"openai-codex-responses"> {
	return createCodexModel("gpt-5.5", { baseUrl });
}

const ENDPOINT_A = codexModel("https://chatgpt.com/backend-api/codex");
const ENDPOINT_B = codexModel("https://codex-proxy.example.invalid/api/codex");

function stampedAssistant(referenceTarget?: string): AssistantMessage {
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
		provider: "openai-codex",
		model: "gpt-5.5",
		api: "openai-codex-responses",
		usage: ZERO_USAGE,
		stopReason: "stop",
		...(referenceTarget !== undefined
			? {
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						referenceTarget,
						items: [
							{ type: "reasoning", id: "rs_endpoint_a", encrypted_content: "enc_endpoint_a", summary: [] },
							{
								type: "message",
								role: "assistant",
								id: "msg_endpoint_a",
								status: "completed",
								content: [{ type: "output_text", text: "answer", annotations: [] }],
							},
						],
					},
				}
			: {}),
	} as unknown as AssistantMessage;
}

function portableAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "portable answer" }],
		timestamp: 0,
		provider: "openai-codex",
		model: "gpt-5.5",
		api: "openai-codex-responses",
		usage: ZERO_USAGE,
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

function assistantMessage(items: unknown[]): { id?: string; content?: unknown } | undefined {
	return items.find(
		item => (item as { type?: string }).type === "message" && (item as { role?: string }).role === "assistant",
	) as { id?: string; content?: unknown } | undefined;
}

function contextFor(assistant: AssistantMessage): Context {
	return { messages: [assistant, { role: "user", content: "continue", timestamp: 1 }] };
}

describe("Codex endpoint reroute signature replay", () => {
	it("distinguishes Codex endpoints", () => {
		expect(getOpenAIResponsesReferenceTarget(ENDPOINT_A)).not.toBe(getOpenAIResponsesReferenceTarget(ENDPOINT_B));
	});

	it("suppresses endpoint-owned reasoning and message ids after a reroute", () => {
		const assistant = stampedAssistant(getOpenAIResponsesReferenceTarget(ENDPOINT_A));
		const items = convertCodexResponsesMessages(ENDPOINT_B, contextFor(assistant));

		expect(items.some(item => (item as { type?: string }).type === "reasoning")).toBe(false);
		expect(JSON.stringify(items)).not.toContain("enc_endpoint_a");
		expect(JSON.stringify(items)).not.toContain("rs_endpoint_a");
		const message = items.find(
			item =>
				(item as { type?: string; role?: string }).type === "message" &&
				(item as { role?: string }).role === "assistant",
		) as { id?: string; content?: unknown } | undefined;
		expect(message?.id).toBeUndefined();
		expect(message?.content).toEqual([{ type: "output_text", text: "answer", annotations: [] }]);
	});

	it("replays the native stamped history on the endpoint that produced it", () => {
		const assistant = stampedAssistant(getOpenAIResponsesReferenceTarget(ENDPOINT_A));
		const items = convertCodexResponsesMessages(ENDPOINT_A, contextFor(assistant));

		expect(items.find(item => (item as { type?: string }).type === "reasoning")).toMatchObject({
			encrypted_content: "enc_endpoint_a",
		});
	});

	it("strips endpoint-owned canonical signatures when no trusted stamp exists", () => {
		const items = convertCodexResponsesMessages(ENDPOINT_B, contextFor(stampedAssistant()));

		expect(items.some(item => (item as { type?: string }).type === "reasoning")).toBe(false);
		expect(JSON.stringify(items)).not.toContain("enc_endpoint_a");
		expect(JSON.stringify(items)).not.toContain("rs_endpoint_a");
		const message = assistantMessage(items);
		expect(message?.id).toBeUndefined();
		expect(JSON.stringify(message?.content)).toContain("answer");
	});

	it("keeps portable unstamped content on the fallback path", () => {
		const items = convertCodexResponsesMessages(ENDPOINT_B, contextFor(portableAssistant()));

		const message = assistantMessage(items);
		expect(message?.id).toBeUndefined();
		expect(JSON.stringify(message?.content)).toContain("portable answer");
	});
});
