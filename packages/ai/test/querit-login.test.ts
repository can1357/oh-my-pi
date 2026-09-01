import { describe, expect, it } from "bun:test";
import { loginQuerit } from "@oh-my-pi/pi-ai/registry/querit";

describe("querit login", () => {
	it("opens Querit API-key settings and returns a trimmed key without validation requests", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginQuerit({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  querit-test-key  ";
			},
			fetch: () => {
				throw new Error("Querit login must not make a network request");
			},
		});

		expect(authUrl).toBe("https://www.querit.ai/en/dashboard/api-keys");
		expect(authInstructions).toBe("Create or copy your API key from the Querit dashboard.");
		expect(promptMessage).toBe("Paste your Querit API key");
		expect(promptPlaceholder).toBe("API key");
		expect(apiKey).toBe("querit-test-key");
	});
});
