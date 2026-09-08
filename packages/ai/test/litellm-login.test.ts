import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

const loginLiteLLM = getProviderDefinition("litellm")?.login;
if (!loginLiteLLM) throw new Error("LiteLLM login is not registered");

describe("LiteLLM login", () => {
	it("mentions LITELLM_BASE_URL for custom proxy endpoints", async () => {
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;

		const apiKey = await loginLiteLLM({
			onAuth: info => {
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				return " sk-litellm-test ";
			},
		});

		expect(authInstructions).toContain("http://localhost:4000/v1");
		expect(authInstructions).toContain("LITELLM_BASE_URL");
		expect(promptMessage).toBe("Paste your LiteLLM API key (master key or virtual key)");
		expect(apiKey).toBe("sk-litellm-test");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginLiteLLM({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});
});
