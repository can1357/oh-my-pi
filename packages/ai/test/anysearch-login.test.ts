import { afterEach, describe, expect, it } from "bun:test";
import { loginAnySearch } from "@oh-my-pi/pi-ai/registry/anysearch";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

const originalAnySearchApiKey = Bun.env.ANYSEARCH_API_KEY;

afterEach(() => {
	if (originalAnySearchApiKey === undefined) {
		delete Bun.env.ANYSEARCH_API_KEY;
	} else {
		Bun.env.ANYSEARCH_API_KEY = originalAnySearchApiKey;
	}
});

describe("AnySearch login", () => {
	it("is registered as a selectable /login provider", () => {
		const provider = getOAuthProviders().find(candidate => candidate.id === "anysearch");
		expect(provider?.name).toBe("AnySearch");
	});

	it("resolves ANYSEARCH_API_KEY from the environment", () => {
		Bun.env.ANYSEARCH_API_KEY = "anysearch-env-key";
		expect(getEnvApiKey("anysearch")).toBe("anysearch-env-key");
	});

	it("opens the AnySearch console and returns a trimmed key without validation requests", async () => {
		let authUrl: string | undefined;
		let promptMessage: string | undefined;

		const apiKey = await loginAnySearch({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				return "  anysearch-test-key  ";
			},
			fetch: () => {
				throw new Error("AnySearch login must not make a network request");
			},
		});

		expect(authUrl).toBe("https://www.anysearch.com/console");
		expect(promptMessage).toBe("Paste your AnySearch API key");
		expect(apiKey).toBe("anysearch-test-key");
	});
});
