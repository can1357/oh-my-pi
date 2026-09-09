import { afterEach, describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";

const ORIGINAL_ENV = {
	SAKANA_BASE_URL: Bun.env.SAKANA_BASE_URL,
	FUGU_BASE_URL: Bun.env.FUGU_BASE_URL,
} as const;

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	restoreEnvVar("SAKANA_BASE_URL");
	restoreEnvVar("FUGU_BASE_URL");
});

describe("Sakana AI request base URL override", () => {
	const sakanaModel = {
		provider: "sakana",
		id: "fugu",
		baseUrl: "https://api.sakana.ai/v1",
	};

	test("uses SAKANA_BASE_URL and appends /v1 for bundled Sakana models", () => {
		Bun.env.SAKANA_BASE_URL = "https://gateway.sakana.test/";
		delete Bun.env.FUGU_BASE_URL;

		const setup = resolveOpenAIRequestSetup(sakanaModel, {
			apiKey: "sakana-key",
			messages: [],
		});

		expect(setup.baseUrl).toBe("https://gateway.sakana.test/v1");
	});

	test("falls back to FUGU_BASE_URL when SAKANA_BASE_URL is unset", () => {
		delete Bun.env.SAKANA_BASE_URL;
		Bun.env.FUGU_BASE_URL = "https://fugu.sakana.test/v1";

		const setup = resolveOpenAIRequestSetup(sakanaModel, {
			apiKey: "sakana-key",
			messages: [],
		});

		expect(setup.baseUrl).toBe("https://fugu.sakana.test/v1");
	});

	test("does not redirect other OpenAI-compatible providers", () => {
		Bun.env.SAKANA_BASE_URL = "https://gateway.sakana.test";

		const setup = resolveOpenAIRequestSetup(
			{ provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
			{ apiKey: "openai-key", messages: [] },
		);

		expect(setup.baseUrl).toBe("https://api.openai.com/v1");
	});
});
