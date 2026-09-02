import { describe, expect, it } from "bun:test";
import { loginOpenzoo, OPENZOO_LOCAL_TOKEN } from "@oh-my-pi/pi-ai/registry/openzoo";

describe("openzoo login", () => {
	it("stores the keyless local placeholder when no bearer is entered", async () => {
		const apiKey = await loginOpenzoo({
			onPrompt: async () => "",
		});
		expect(apiKey).toBe(OPENZOO_LOCAL_TOKEN);
	});

	it("keeps a pasted tunnel bearer", async () => {
		const apiKey = await loginOpenzoo({
			onPrompt: async () => "  oz_tunnel-bearer  ",
		});
		expect(apiKey).toBe("oz_tunnel-bearer");
	});
});
