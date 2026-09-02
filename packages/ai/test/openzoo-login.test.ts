import { describe, expect, it } from "bun:test";
import { loginOpenzoo, OPENZOO_LOCAL_TOKEN } from "@oh-my-pi/pi-ai/registry/openzoo";

describe("openzoo login", () => {
	it("stores the keyless local placeholder when no bearer is entered", async () => {
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;

		const apiKey = await loginOpenzoo({
			onAuth: info => {
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				return "";
			},
		});

		expect(authInstructions).toContain("http://localhost:8402/v1");
		expect(authInstructions).toContain("OPENZOO_BASE_URL");
		expect(promptMessage).toContain("optional");
		expect(apiKey).toBe(OPENZOO_LOCAL_TOKEN);
	});

	it("keeps a pasted tunnel bearer", async () => {
		const apiKey = await loginOpenzoo({
			onPrompt: async () => "  oz_tunnel-bearer  ",
		});
		expect(apiKey).toBe("oz_tunnel-bearer");
	});
});
