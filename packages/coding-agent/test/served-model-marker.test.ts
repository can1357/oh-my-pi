import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import {
	detectServedModelMismatch,
	ServedModelTracker,
} from "@oh-my-pi/pi-coding-agent/modes/components/served-model-marker";

function turn(parts: {
	model: string;
	served?: string;
	provider?: string;
	upstreamProvider?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: parts.provider ?? "openrouter",
		model: parts.model,
		...(parts.served ? { upstreamModel: parts.served } : {}),
		...(parts.upstreamProvider ? { upstreamProvider: parts.upstreamProvider } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("detectServedModelMismatch", () => {
	it("flags a different family served under the requested id, naming the route", () => {
		expect(
			detectServedModelMismatch(
				turn({
					model: "anthropic/claude-opus-5",
					served: "claude-haiku-4-5-20251001",
					upstreamProvider: "Amazon Bedrock",
				}),
			),
		).toEqual({
			requested: "anthropic/claude-opus-5",
			served: "claude-haiku-4-5-20251001",
			provider: "openrouter",
			upstreamProvider: "Amazon Bedrock",
		});
	});

	it("flags a different revision of the same family", () => {
		expect(detectServedModelMismatch(turn({ model: "claude-opus-4-6", served: "claude-opus-4-7" }))?.served).toBe(
			"claude-opus-4-7",
		);
	});

	it("treats a dated snapshot or gateway prefix of the requested model as the same model", () => {
		expect(
			detectServedModelMismatch(turn({ model: "anthropic/claude-haiku-4.5", served: "claude-haiku-4-5-20251001" })),
		).toBeUndefined();
	});

	it("treats an unclassifiable served id (first-party A/B codename) as unverifiable, not a substitution", () => {
		expect(
			detectServedModelMismatch(
				turn({ model: "claude-opus-4-6", served: "numbat-v6-efforts-20-40-80-ab-prod", provider: "anthropic" }),
			),
		).toBeUndefined();
	});

	it("stays silent when no served id was recovered", () => {
		expect(detectServedModelMismatch(turn({ model: "claude-fable-5-1" }))).toBeUndefined();
	});
});

describe("ServedModelTracker", () => {
	it("reports each substitution pair once, and a new pair after a model switch", () => {
		const tracker = new ServedModelTracker();
		const swapped = turn({ model: "claude-opus-5", served: "claude-haiku-4-5" });
		expect(tracker.check(swapped)).toBeDefined();
		expect(tracker.check(swapped)).toBeUndefined();
		expect(tracker.check(turn({ model: "claude-opus-5", served: "claude-opus-5" }))).toBeUndefined();
		expect(tracker.check(turn({ model: "claude-sonnet-5", served: "claude-haiku-4-5" }))?.requested).toBe(
			"claude-sonnet-5",
		);
		expect(tracker.check(swapped)).toBeUndefined();
	});
});
