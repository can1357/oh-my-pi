import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { e2eApiKey } from "./oauth";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("xhigh reasoning", () => {
	describe("codex-max (supports xhigh)", () => {
		// Note: codex models only support the responses API, not chat completions
		it("should work with openai-responses", async () => {
			const model = getBundledModel("openai", "gpt-5.1-codex-max");
			const s = stream(model, makeContext(), { reasoning: "xhigh" });
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some(b => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some(b => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-responses when using xhigh", async () => {
			const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
			const s = stream(model, makeContext(), { reasoning: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});

		it("should error with openai-completions when using xhigh", async () => {
			const model: Model<"openai-completions"> = {
				...(getBundledModel("openai", "gpt-5-mini") as Model<"openai-completions">),
				api: "openai-completions",
			};
			const s = stream(model, makeContext(), { reasoning: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});
