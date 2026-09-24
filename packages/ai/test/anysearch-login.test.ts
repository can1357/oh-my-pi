import { afterEach, describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

const originalAnySearchApiKey = Bun.env.ANYSEARCH_API_KEY;
const loginAnySearch = getProviderDefinition("anysearch")?.login;
if (!loginAnySearch) throw new Error("AnySearch login is not registered");

afterEach(() => {
	if (originalAnySearchApiKey === undefined) {
		delete Bun.env.ANYSEARCH_API_KEY;
	} else {
		Bun.env.ANYSEARCH_API_KEY = originalAnySearchApiKey;
	}
});

describe("AnySearch login", () => {
	it("resolves ANYSEARCH_API_KEY from the environment", () => {
		Bun.env.ANYSEARCH_API_KEY = "anysearch-env-key";
		expect(getEnvApiKey("anysearch")).toBe("anysearch-env-key");
	});

	it("opens the AnySearch console and returns a trimmed key without validation requests", async () => {
		let authUrl: string | undefined;

		const apiKey = await loginAnySearch({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "  anysearch-test-key  ",
			fetch: () => {
				throw new Error("AnySearch login must not make a network request");
			},
		});

		expect(authUrl).toBe("https://www.anysearch.com/console");
		expect(apiKey).toBe("anysearch-test-key");
	});
});
