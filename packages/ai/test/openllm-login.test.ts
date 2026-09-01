import { describe, expect, it } from "bun:test";
import { loginOpenLLM } from "@oh-my-pi/pi-ai/registry/openllm";

describe("OpenLLM login", () => {
	it("mentions OPENLLM_BASE_URL for local daemon endpoints", async () => {
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;

		const apiKey = await loginOpenLLM({
			onAuth: info => {
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				return " sk-llm-test ";
			},
		});

		expect(authInstructions).toContain("https://openllm.sh/v1");
		expect(authInstructions).toContain("OPENLLM_BASE_URL");
		expect(promptMessage).toBe("Paste your OpenLLM API key");
		expect(apiKey).toBe("sk-llm-test");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginOpenLLM({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});
});
