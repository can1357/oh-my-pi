import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Amazon Nova streams reasoningContent natively (with no signature — Nova never
// sends one), but rejects that same unsigned reasoningContent when it is echoed
// back in a later request:
//
//   Bedrock HTTP 400: "User messages cannot contain reasoning content.
//   Please remove the reasoning content and try again."
//
// This wedges the agent loop on every turn after the first. The bug was that
// convertMessages() assumed any model that *produces* reasoning also *accepts*
// it echoed back — true for Claude (which signs it), unproven and false for
// Nova. Unsigned thinking blocks must now demote to plain text instead of
// being resent as reasoningContent.
const novaModel: Model<"bedrock-converse-stream"> = buildModel({
	id: "us.amazon.nova-pro-v1:0",
	name: "Nova Pro",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
	contextWindow: 300000,
	maxTokens: 5000,
});

// An opaque application-inference-profile ARN addressing Nova hits the same
// path: it also fails supportsThinkingSignature-style Claude-id detection, so
// it must not be treated as Claude-signature-capable either.
const novaProfileArn = "arn:aws:bedrock:us-east-1:1234567890:application-inference-profile/company-nova-pro";

function contextWithUnsignedThinking(modelId: string): Context {
	return {
		messages: [
			{ role: "user", content: "Plan the change", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the implementation", thinkingSignature: "" },
					{ type: "text", text: "I found the relevant code." },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: modelId,
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
			},
			{ role: "user", content: "Continue", timestamp: 2 },
		],
	};
}

async function captureReplayPayload(model: Model<"bedrock-converse-stream">, context: Context): Promise<unknown> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();

	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		maxTokens: 16,
		onPayload: payload => resolve(payload),
	});

	return promise;
}

describe("Bedrock Nova unsigned reasoning replay", () => {
	test("demotes an unsigned thinking block to text instead of resending reasoningContent", async () => {
		const payload = await captureReplayPayload(novaModel, contextWithUnsignedThinking(novaModel.id));
		const messages = (payload as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> })
			.messages;

		expect(messages[0].role).toBe("user");
		expect(messages[0].content[0]).toMatchObject({ text: "Plan the change" });
		expect(messages[2].role).toBe("user");
		expect(messages[2].content[0]).toMatchObject({ text: "Continue" });

		const assistantMessage = messages[1];
		expect(assistantMessage.role).toBe("assistant");
		// The captured (unsigned) thinking block must be demoted to plain text...
		expect(assistantMessage.content[0]).toMatchObject({
			text: "<thinking>\nInspect the implementation\n</thinking>",
		});
		expect(assistantMessage.content[1]).toMatchObject({ text: "I found the relevant code." });
		// ...and must never resend reasoningContent without a signature — that's exactly
		// what Nova's HTTP 400 rejects.
		for (const block of assistantMessage.content) {
			expect(block).not.toHaveProperty("reasoningContent");
		}
	});

	test("also demotes unsigned thinking for a Nova-backed application-inference-profile ARN", async () => {
		const profileModel: Model<"bedrock-converse-stream"> = buildModel({
			id: novaProfileArn,
			name: "Nova Pro (inference profile)",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
			contextWindow: 300000,
			maxTokens: 5000,
		});

		const payload = await captureReplayPayload(profileModel, contextWithUnsignedThinking(novaProfileArn));

		const assistantMessage = (payload as { messages: Array<{ role: string; content: unknown[] }> }).messages[1];
		for (const block of assistantMessage.content) {
			expect(block).not.toHaveProperty("reasoningContent");
		}
	});
});
