import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { rebakeBundledModel } from "../scripts/generate-models";

describe("provider-local model rebakes", () => {
	test("rederives stale serialized thinking metadata", () => {
		const rebaked = rebakeBundledModel({
			id: "claude-opus-4-5",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			thinking: { mode: "budget", efforts: [Effort.High] },
		});

		expect(rebaked.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});
});
