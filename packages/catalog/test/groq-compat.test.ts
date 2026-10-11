import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Groq validates request properties strictly: an assistant turn carrying
 * `reasoning_content` answers 400 "property 'reasoning_content' is
 * unsupported", and Qwen's `enable_thinking` answers 400 "property
 * 'enable_thinking' is unsupported".
 */

function discovered(id: string, reasoning: boolean): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id,
		name: id,
		provider: "groq",
		baseUrl: "https://api.groq.com/openai/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 16_384,
		contextWindow: 131_072,
		reasoning,
	};
}

describe("Groq wire compat", () => {
	it("never replays reasoning_content on Kimi tool-call turns", () => {
		for (const id of ["moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905"]) {
			expect(getBundledModel("groq", id).compat).toMatchObject({ requiresReasoningContentForToolCalls: false });
		}
		// A Kimi id discovered at runtime resolves the same way.
		const policy = resolveModelPolicy(discovered("moonshotai/kimi-k2-instruct-1205", false));
		expect(policy.compat).toMatchObject({ requiresReasoningContentForToolCalls: false });
	});

	it("drives Qwen through reasoning_effort, with none as its off value", () => {
		const qwen = getBundledModel("groq", "qwen/qwen3.8-27b");
		expect(qwen.compat).toMatchObject({ thinkingFormat: "openai", reasoningDisableMode: "none-effort" });
		expect(qwen.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(resolveModelPolicy(discovered("qwen/qwen3.9-32b", true)).compat).toMatchObject({
			thinkingFormat: "openai",
			reasoningDisableMode: "none-effort",
		});
	});

	it("offers only the reasoning_effort values Groq accepts for each Qwen", () => {
		// Documented Qwen ladder is low/medium/high; `minimal` is a 400.
		expect(buildModel(discovered("qwen/qwen3.9-32b", true)).thinking?.efforts).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		// Qwen 3.6 takes only `default` (thinking on) or `none`.
		const qwen36 = getBundledModel("groq", "qwen/qwen3.6-27b");
		expect(qwen36.thinking?.efforts).toEqual([Effort.High]);
		expect(qwen36.thinking?.effortMap).toEqual({ high: "default" });
	});

	it("keeps Kimi's reasoning_content replay on other hosts", () => {
		expect(getBundledModel("moonshot", "kimi-k2-0905-preview").compat).toMatchObject({
			requiresReasoningContentForToolCalls: true,
		});
	});
});
