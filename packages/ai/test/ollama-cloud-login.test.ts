import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";

const loginOllamaCloud = getProviderDefinition("ollama-cloud")!.login!;

describe("ollama cloud login", () => {
	it("opens Ollama Cloud key settings and trims the pasted key", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginOllamaCloud({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  ollama-cloud-key  ";
			},
		});

		expect(authUrl).toBe("https://ollama.com/settings/keys");
		expect(authInstructions).toContain("Create an Ollama Cloud API key");
		expect(promptMessage).toBe("Paste your Ollama Cloud API key");
		expect(promptPlaceholder).toBe("ollama-cloud-api-key");
		expect(apiKey).toBe("ollama-cloud-key");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginOllamaCloud({
				onPrompt: async () => "   ",
			}),
		).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
	});

	it("requires onPrompt callback", async () => {
		await expect(loginOllamaCloud({})).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
	});
});
