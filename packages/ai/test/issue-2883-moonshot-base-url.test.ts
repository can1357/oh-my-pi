import { afterEach, describe, expect, test, vi } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginMoonshot = getProviderDefinition("moonshot")!.login!;

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

	test("validates login against the configured Moonshot endpoint", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1/";
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.moonshot.cn/v1/models");
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		});

		const apiKey = await loginMoonshot({
			onPrompt: async () => " sk-china-key ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-china-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
