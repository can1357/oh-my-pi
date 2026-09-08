import { describe, expect, it } from "bun:test";
import {
	buildCopilotDynamicHeaders,
	getCopilotInitiatorOverride,
	getCopilotPremiumMultiplier,
	hasCopilotVisionInput,
	inferCopilotInitiator,
} from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import type { Message } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("inferCopilotInitiator", () => {
	it("returns 'user' when there are no messages", () => {
		expect(inferCopilotInitiator([])).toBe("user");
	});

	it("returns 'agent' when last message role is assistant", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' when last message is toolResult", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'user' when last message is user with text content", () => {
		const messages: Message[] = [{ role: "user", content: "what time is it?", timestamp: Date.now() }];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("returns 'user' when last message is user with text content blocks", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "explain this image" }],
				timestamp: Date.now(),
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});

	it("prefers explicit attribution over role when attribution is agent", () => {
		const messages: Message[] = [
			{ role: "user", content: "internal reminder", attribution: "agent", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("prefers explicit attribution over role when attribution is user", () => {
		const messages: Message[] = [
			{ role: "developer", content: "forward user note", attribution: "user", timestamp: Date.now() },
		];
		expect(inferCopilotInitiator(messages)).toBe("user");
	});
	it("returns 'agent' when last message is user but last content block is tool_result", () => {
		const messages: unknown[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tc_1", content: "done" }],
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});

	it("returns 'agent' for any non-user role", () => {
		const messages: unknown[] = [
			{
				role: "tool",
				tool_call_id: "call_abc123",
				content: "tool output",
			},
		];
		expect(inferCopilotInitiator(messages)).toBe("agent");
	});
});

describe("getCopilotInitiatorOverride", () => {
	it("returns undefined when no initiator header is configured", () => {
		expect(getCopilotInitiatorOverride(undefined)).toBeUndefined();
		expect(getCopilotInitiatorOverride({})).toBeUndefined();
	});

	it("returns the last valid case-insensitive initiator value", () => {
		const headers = {
			"x-initiator": "agent",
			"X-Initiator": "user",
			"X-INITIATOR": "invalid",
			"x-InItIaToR": "agent",
		};
		expect(getCopilotInitiatorOverride(headers)).toBe("agent");
	});

	it("ignores invalid initiator values", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "system" })).toBeUndefined();
	});
});
describe("hasCopilotVisionInput", () => {
	it("returns false when no messages have images", () => {
		const messages: Message[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns true when a user message has image content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{ type: "image", data: "abc123", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns true when a toolResult has image content", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "screenshot",
				content: [{ type: "image", data: "def456", mimeType: "image/jpeg" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns false when user message has only text content", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "just text" }],
				timestamp: Date.now(),
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
});

describe("getCopilotPremiumMultiplier", () => {
	it("returns bundled multiplier metadata for paid-tier Copilot plans", () => {
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "claude-haiku-4.5").premiumMultiplier, "paid"),
		).toBe(0.33);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "claude-opus-4.6").premiumMultiplier, "paid"),
		).toBe(3);
		expect(getCopilotPremiumMultiplier(getBundledModel("github-copilot", "gpt-4o").premiumMultiplier, "paid")).toBe(
			0,
		);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "gpt-5.4-mini").premiumMultiplier, "paid"),
		).toBe(0.33);
		expect(
			getCopilotPremiumMultiplier(getBundledModel("github-copilot", "grok-code-fast-1").premiumMultiplier, "paid"),
		).toBe(0.25);
	});

	it("treats zero-multiplier models as 1x for free-tier or unknown plans", () => {
		expect(getCopilotPremiumMultiplier(0, "free")).toBe(1);
		expect(getCopilotPremiumMultiplier(0, undefined)).toBe(1);
		expect(getCopilotPremiumMultiplier(0, "enterprise")).toBe(1);
	});

	it("defaults to 1x when multiplier metadata is missing", () => {
		expect(getCopilotPremiumMultiplier(undefined, "paid")).toBe(1);
		expect(getCopilotPremiumMultiplier(undefined, "free")).toBe(1);
	});
});

describe("buildCopilotDynamicHeaders", () => {
	it("uses Copilot CLI identity for user-initiated requests", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0.33,
		});
		expect(headers).toEqual({
			"User-Agent": "copilot/1.0.82",
			"Editor-Version": "copilot/1.0.82",
			"Copilot-Integration-Id": "copilot-developer-cli",
			"Copilot-Harness-Id": "copilot-sdk",
			"Openai-Intent": "conversation-agent",
			"X-Initiator": "user",
			"X-Interaction-Type": "conversation-user",
		});
		expect(premiumRequests).toBe(0.33);
	});

	it("uses 0x multiplier for included models on paid-tier plans", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0,
			planTier: "paid",
		});
		expect(premiumRequests).toBe(0);
	});

	it("treats included models as 1x for free-tier plans", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
			premiumMultiplier: 0,
			planTier: "free",
		});
		expect(premiumRequests).toBe(1);
	});

	it("defaults unknown or missing plan tiers to free-tier behavior", () => {
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				premiumMultiplier: 0,
			}).premiumRequests,
		).toBe(1);
		expect(
			buildCopilotDynamicHeaders({
				messages: [],
				hasImages: false,
				premiumMultiplier: 0,
				planTier: "enterprise",
			}).premiumRequests,
		).toBe(1);
	});

	it("infers agent initiation when bundled model headers are present", () => {
		const model = getBundledModel("github-copilot", "gpt-4o");
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [{ role: "tool", tool_call_id: "call_abc123", content: "done" }],
			hasImages: false,
			premiumMultiplier: 3,
			headers: model.headers,
		});
		expect(headers["X-Initiator"]).toBe("agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-agent");
		expect(premiumRequests).toBe(0);
	});

	it("preserves explicit initiator override over inferred value and sets 0 premium requests for agent", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [
				{
					role: "user",
					content:
						"<conversation>\nuser: summarize the discarded history\nassistant: keep the latest turn\n</conversation>\n\nProvide a compaction summary.",
				},
			],
			hasImages: false,
			premiumMultiplier: 3,
			initiatorOverride: "agent",
		});
		expect(headers["X-Initiator"]).toBe("agent");
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-agent");
		expect(premiumRequests).toBe(0);
	});

	it("sets Copilot-Vision-Request when hasImages is true", () => {
		const { headers, premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: true,
			premiumMultiplier: 3,
		});
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-user");
		expect(headers["Copilot-Vision-Request"]).toBe("true");
		expect(premiumRequests).toBe(3);
	});

	it("defaults to 1x when premium multiplier is not provided", () => {
		const { premiumRequests } = buildCopilotDynamicHeaders({
			messages: [],
			hasImages: false,
		});
		expect(premiumRequests).toBe(1);
	});
});
