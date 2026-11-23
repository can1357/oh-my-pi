import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { matchesReplacementCredential } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

async function loginOtari(options: OAuthController): Promise<string> {
	const login = getProviderDefinition("otari")?.login;
	if (!login) throw new Error("Otari login is not registered");
	const result = await login(options);
	if (typeof result !== "string") throw new Error("Expected Otari API-key credential");
	return result;
}

function recordingFetch(calls: Array<{ url: string; authorization: string }>): OAuthController["fetch"] {
	return (input, init) => {
		calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") ?? "" });
		return Promise.resolve(Response.json({ object: "list", data: [] }));
	};
}

// A discovered row: its baseUrl is whatever endpoint discovery ran against.
const otariModel = {
	provider: "otari",
	id: "anthropic/claude-haiku-4.5",
	api: "openai-completions",
	reasoning: true,
	baseUrl: "https://api.otari.ai/api/v1",
} as const;

describe("Otari login", () => {
	let previousBaseUrl: string | undefined;
	beforeEach(() => {
		previousBaseUrl = Bun.env.OTARI_BASE_URL;
		delete Bun.env.OTARI_BASE_URL;
	});
	afterEach(() => {
		if (previousBaseUrl === undefined) delete Bun.env.OTARI_BASE_URL;
		else Bun.env.OTARI_BASE_URL = previousBaseUrl;
	});

	test("US (default) validates against the US gateway and stores a plain key", async () => {
		const calls: Array<{ url: string; authorization: string }> = [];
		const prompts = ["", " tk_us "];
		const credential = await loginOtari({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: recordingFetch(calls),
		});

		expect(credential).toBe("tk_us");
		expect(calls).toEqual([{ url: "https://api.otari.ai/api/v1/models", authorization: "Bearer tk_us" }]);
	});

	test("EU validates against the EU gateway and routes requests there", async () => {
		const calls: Array<{ url: string; authorization: string }> = [];
		const prompts = ["2", "tk_eu"];
		const credential = await loginOtari({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: recordingFetch(calls),
		});

		expect(calls).toEqual([{ url: "https://eu.api.otari.ai/api/v1/models", authorization: "Bearer tk_eu" }]);
		expect(JSON.parse(credential)).toEqual({ token: "tk_eu", baseUrl: "https://eu.api.otari.ai/api/v1" });

		const setup = resolveOpenAIRequestSetup(otariModel, { apiKey: credential, messages: [] });
		expect(setup.baseUrl).toBe("https://eu.api.otari.ai/api/v1");
		expect(setup.headers.Authorization).toBe("Bearer tk_eu");
	});

	test("custom URL is validated and stored without its trailing slash", async () => {
		const calls: Array<{ url: string; authorization: string }> = [];
		const prompts = ["3", "https://otari.example.com/api/v1/", "tk_self"];
		const credential = await loginOtari({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: recordingFetch(calls),
		});

		expect(calls[0]?.url).toBe("https://otari.example.com/api/v1/models");
		expect(JSON.parse(credential)).toEqual({ token: "tk_self", baseUrl: "https://otari.example.com/api/v1" });
	});

	test("OTARI_BASE_URL skips the region prompt", async () => {
		Bun.env.OTARI_BASE_URL = "https://otari.example.com/api/v1";
		const calls: Array<{ url: string; authorization: string }> = [];
		const messages: string[] = [];
		const credential = await loginOtari({
			onAuth: () => {},
			onPrompt: async prompt => {
				messages.push(prompt.message);
				return "tk_env";
			},
			fetch: recordingFetch(calls),
		});

		expect(messages).toEqual(["Paste your Otari workspace API key"]);
		expect(calls[0]?.url).toBe("https://otari.example.com/api/v1/models");
		expect(JSON.parse(credential)).toEqual({ token: "tk_env", baseUrl: "https://otari.example.com/api/v1" });
	});

	test("a plain key keeps the model's own endpoint", () => {
		const setup = resolveOpenAIRequestSetup(otariModel, { apiKey: "tk_us", messages: [] });
		expect(setup.baseUrl).toBe("https://api.otari.ai/api/v1");
		expect(setup.headers.Authorization).toBe("Bearer tk_us");
	});

	test("logging the same key in to another region replaces the stored row", () => {
		const existing = { type: "api_key", key: "tk_same" } as const;
		const incoming = {
			type: "api_key",
			key: JSON.stringify({ token: "tk_same", baseUrl: "https://eu.api.otari.ai/api/v1" }),
		} as const;
		expect(matchesReplacementCredential("otari", existing, null, incoming)).toBe(true);
	});
});
