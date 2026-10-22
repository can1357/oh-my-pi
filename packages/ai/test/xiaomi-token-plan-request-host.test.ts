import { describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";

describe("Xiaomi Token Plan request-time host", () => {
	// Mirrors the bundled `mimo-v2.6-pro` catalog entry, whose baseUrl is
	// hardcoded to the standard platform (`api.xiaomimimo.com`).
	const xiaomiModel = {
		provider: "xiaomi",
		id: "mimo-v2.6-pro",
		baseUrl: "https://api.xiaomimimo.com/v1",
	};

	test("routes a tp- key to the token-plan host on a cold start", () => {
		const setup = resolveOpenAIRequestSetup(xiaomiModel, {
			apiKey: "tp-test-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
	});

	test("uses the region stored at login, else sgp", () => {
		const storedHost = resolveOpenAIRequestSetup(
			{ provider: "xiaomi", id: "mimo-v2.6-pro", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(storedHost.baseUrl).toBe("https://token-plan-ams.xiaomimimo.com/v1");
		const storedProvider = resolveOpenAIRequestSetup(
			{ provider: "xiaomi-token-plan-ams", id: "mimo-v2.6-pro", baseUrl: "https://api.xiaomimimo.com/v1" },
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(storedProvider.baseUrl).toBe("https://token-plan-ams.xiaomimimo.com/v1");
	});

	test("reads each region's host from the auth policy", () => {
		for (const region of ["sgp", "ams", "cn"]) {
			const setup = resolveOpenAIRequestSetup(
				{ provider: `xiaomi-token-plan-${region}`, id: "mimo-v2.6-pro", baseUrl: "https://api.xiaomimimo.com/v1" },
				{ apiKey: "tp-test-key", messages: [] },
			);
			expect(setup.baseUrl).toBe(`https://token-plan-${region}.xiaomimimo.com/v1`);
		}
	});

	test("keeps the standard host for a pay-as-you-go key", () => {
		const setup = resolveOpenAIRequestSetup(xiaomiModel, {
			apiKey: "sk-standard-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://api.xiaomimimo.com/v1");
	});

	test("does not redirect other openai-completions providers with a tp- key", () => {
		const setup = resolveOpenAIRequestSetup(
			{ provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://api.openai.com/v1");
	});
});
