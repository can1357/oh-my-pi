import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

const loginKagi = getProviderDefinition("kagi")?.login;
if (!loginKagi) throw new Error("Kagi login is not registered");

describe("kagi login", () => {
	it("opens Kagi API settings and prompts for key", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginKagi({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  KG_test_key  ";
			},
		});

		expect(authUrl).toBe("https://kagi.com/settings/api");
		expect(authInstructions).toContain("Kagi Search API key");
		expect(authInstructions).toContain("beta-only");
		expect(authInstructions).toContain("support@kagi.com");
		expect(promptMessage).toBe("Paste your Kagi API key");
		expect(promptPlaceholder).toBe("KG_...");
		expect(apiKey).toBe("KG_test_key");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginKagi({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginKagi({})).rejects.toThrow("Kagi login requires onPrompt callback");
	});
});
