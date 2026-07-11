import { afterEach, describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";

const ORIGINAL_MOONSHOT_BASE_URL = Bun.env.MOONSHOT_BASE_URL;

function restoreMoonshotBaseUrl(): void {
	if (ORIGINAL_MOONSHOT_BASE_URL === undefined) {
		delete Bun.env.MOONSHOT_BASE_URL;
		return;
	}
	Bun.env.MOONSHOT_BASE_URL = ORIGINAL_MOONSHOT_BASE_URL;
}

afterEach(() => {
	restoreMoonshotBaseUrl();
});

describe("Moonshot China base URL override (issue #2883)", () => {
	// Mirrors the bundled `kimi-k2.7-code` catalog entry, whose baseUrl is
	// hardcoded to the international platform (`api.moonshot.ai`).
	const moonshotModel = {
		provider: "moonshot",
		id: "kimi-k2.7-code",
		baseUrl: "https://api.moonshot.ai/v1",
	};

	test("redirects the moonshot provider to api.moonshot.cn when MOONSHOT_BASE_URL is set", () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const setup = resolveOpenAIRequestSetup(moonshotModel, {
			apiKey: "sk-china-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://api.moonshot.cn/v1");
	});

	test("keeps the bundled international endpoint when MOONSHOT_BASE_URL is unset", () => {
		delete Bun.env.MOONSHOT_BASE_URL;
		const setup = resolveOpenAIRequestSetup(moonshotModel, {
			apiKey: "sk-intl-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://api.moonshot.ai/v1");
	});

	test("does not redirect other openai-completions providers", () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const setup = resolveOpenAIRequestSetup(
			{ provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
			{ apiKey: "sk-openai", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://api.openai.com/v1");
	});
});
