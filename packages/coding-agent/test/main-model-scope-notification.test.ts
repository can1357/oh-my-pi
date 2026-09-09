import { describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
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

	it("emits the startup model scope banner when startup.quiet is disabled", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5 (Ctrl+P to cycle)",
		});
	});
	it("includes thinking suffix only when explicitly scoped", () => {
		const withExplicit = {
			...scopedModel("claude-sonnet-4-5"),
			thinkingLevel: "high" as ThinkingLevel,
			explicitThinkingLevel: true,
		};
		expect(buildModelScopeNotification([withExplicit], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5:high (Ctrl+P to cycle)",
		});
	});

	it("hides the suffix when the level was filled from the global default", () => {
		// `applyRootSessionOptions` fills `sessionOptions.scopedModels[*].thinkingLevel`
		// with the global default for Ctrl+P cycling — the banner must not surface that
		// default as if the user had scoped `:high`.
		const withDefault = {
			...scopedModel("claude-sonnet-4-5"),
			thinkingLevel: "high" as ThinkingLevel,
			explicitThinkingLevel: false,
		};
		expect(buildModelScopeNotification([withDefault], false)).toEqual({
			kind: "info",
			message: "Model scope: claude-sonnet-4-5 (Ctrl+P to cycle)",
		});
	});
});
