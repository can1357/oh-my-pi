import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";

const OPENZOO_LOCAL_TOKEN = "openzoo-local";
const openzoo = getProviderDefinition("openzoo")!;
const loginOpenzoo = openzoo.login!;

describe("openzoo login", () => {
	it("stores the keyless local placeholder when no bearer is entered", async () => {
		const apiKey = await loginOpenzoo({ onPrompt: async () => "" });
		expect(apiKey).toBe(OPENZOO_LOCAL_TOKEN);
	});

	it("keeps a pasted tunnel bearer", async () => {
		const apiKey = await loginOpenzoo({ onPrompt: async () => "  oz_tunnel-bearer  " });
		expect(apiKey).toBe("oz_tunnel-bearer");
	});

	it("counts as authenticated with no env var, and OPENZOO_API_KEY still wins", () => {
		const resolve = openzoo.envKeys as () => string | undefined;
		delete Bun.env.OPENZOO_API_KEY;
		expect(resolve()).toBe(OPENZOO_LOCAL_TOKEN);
		Bun.env.OPENZOO_API_KEY = "oz_tunnel-bearer";
		expect(resolve()).toBe("oz_tunnel-bearer");
		delete Bun.env.OPENZOO_API_KEY;
	});
});
