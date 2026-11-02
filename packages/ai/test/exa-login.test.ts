import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

const loginExa = getProviderDefinition("exa")?.login;
if (!loginExa) throw new Error("Exa login is not registered");

describe("exa login", () => {
	it("opens Exa API-key settings and returns a trimmed key without validation requests", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginExa({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  exa-test-key  ";
			},
			fetch: () => {
				throw new Error("Exa login must not make a network request");
			},
		});

		expect(authUrl).toBe("https://dashboard.exa.ai/api-keys");
		expect(authInstructions).toBe("Create or copy your API key from the Exa dashboard.");
		expect(promptMessage).toBe("Paste your Exa API key");
		expect(promptPlaceholder).toBe("API key");
		expect(apiKey).toBe("exa-test-key");
	});
});
