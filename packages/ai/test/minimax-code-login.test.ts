import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginMiniMaxCode = getProviderDefinition("minimax-code")!.login!;
const loginMiniMaxCodeCn = getProviderDefinition("minimax-code-cn")!.login!;

describe("MiniMax Token Plan login", () => {
	it("opens the international platform and validates against the international API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];

		const fetchMock: FetchImpl = async input => {
			validationUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCode({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk-intl  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-intl");
		expect(authUrls).toEqual(["https://platform.minimax.io/subscribe/token-plan"]);
		expect(validationUrls).toEqual(["https://api.minimax.io/v1/chat/completions"]);
	});

	it("opens the China platform and validates against the China API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];

		const fetchMock: FetchImpl = async input => {
			validationUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCodeCn({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk-cn  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-cn");
		expect(authUrls).toEqual(["https://platform.minimaxi.com/subscribe/token-plan"]);
		expect(validationUrls).toEqual(["https://api.minimaxi.com/v1/chat/completions"]);
	});
});
