import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

describe("deepseek built-in provider (issue #830)", () => {
	test("registers DeepSeek as an API-key login provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "deepseek");
		expect(provider?.name).toBe("DeepSeek");
		expect(provider?.available).toBe(true);
	});

	test("resolves DEEPSEEK_API_KEY via env", () => {
		const previous = Bun.env.DEEPSEEK_API_KEY;
		Bun.env.DEEPSEEK_API_KEY = "deepseek-test-key";
		try {
			expect(getEnvApiKey("deepseek")).toBe("deepseek-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.DEEPSEEK_API_KEY;
			} else {
				Bun.env.DEEPSEEK_API_KEY = previous;
			}
		}
	});
});
