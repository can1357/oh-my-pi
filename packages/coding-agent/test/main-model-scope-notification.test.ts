import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { buildModelScopeNotification } from "@oh-my-pi/pi-coding-agent/main";

function scopedModel(id: string): ScopedModel {
	return {
		model: buildModel({
			id,
			name: id,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		explicitThinkingLevel: false,
	};
}

describe("buildModelScopeNotification", () => {
	it("does not emit startup model scope chrome while startup.quiet is enabled", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], true)).toBeNull();
	});
});
