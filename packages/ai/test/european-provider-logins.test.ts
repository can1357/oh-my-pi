import { describe, expect, test, vi } from "bun:test";
import { loginAkiIo } from "@oh-my-pi/pi-ai/registry/aki-io";
import { loginCortecs } from "@oh-my-pi/pi-ai/registry/cortecs";
import { loginEURouter } from "@oh-my-pi/pi-ai/registry/eurouter";
import { loginMelious } from "@oh-my-pi/pi-ai/registry/melious";
import { loginNebius } from "@oh-my-pi/pi-ai/registry/nebius";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { loginOpper } from "@oh-my-pi/pi-ai/registry/opper";
import { loginOvhcloud } from "@oh-my-pi/pi-ai/registry/ovhcloud";
import { loginScaleway } from "@oh-my-pi/pi-ai/registry/scaleway";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginCases = [
	{
		id: "nebius",
		name: "Nebius Token Factory",
		login: loginNebius,
		key: "nebius-test-key",
		modelsUrl: "https://api.tokenfactory.nebius.com/v1/models",
	},
] as const;

const chatCompletionsLoginCases = [
	{
		id: "aki-io",
		name: "AKI.IO",
		login: loginAkiIo,
		key: "aki-test-key",
		validationUrl: "https://aki.io/openai/v1/chat/completions",
		model: "kimi-k2.7-code-1100b",
	},
	{
		id: "melious",
		name: "Melious",
		login: loginMelious,
		key: "sk-mel-test",
		validationUrl: "https://api.melious.ai/v1/chat/completions",
		model: "gpt-oss-120b",
	},
	{
		id: "cortecs",
		name: "Cortecs",
		login: loginCortecs,
		key: "cortecs-test-key",
		validationUrl: "https://api.cortecs.ai/v1/chat/completions",
		model: "gpt-oss-120b",
	},
	{
		id: "eurouter",
		name: "EUrouter",
		login: loginEURouter,
		key: "eur_test_key",
		validationUrl: "https://api.eurouter.ai/api/v1/chat/completions",
		model: "mistral-large-3",
	},
	{
		id: "ovhcloud",
		name: "OVHcloud AI Endpoints",
		login: loginOvhcloud,
		key: "ovh-test-key",
		validationUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
		model: "gpt-oss-120b",
	},
	{
		id: "opper",
		name: "Opper",
		login: loginOpper,
		key: "opper-test-key",
		validationUrl: "https://api.opper.ai/v3/compat/chat/completions",
		model: "mistral/devstral-2512",
	},
	{
		id: "scaleway",
		name: "Scaleway Generative APIs",
		login: loginScaleway,
		key: "scw-test-key",
		validationUrl: "https://api.scaleway.ai/v1/chat/completions",
		model: "glm-5.2",
	},
] as const;

describe("European gateway provider logins", () => {
	test("registers European gateways in the login provider selector", () => {
		const loginProviders = getOAuthProviders();
		for (const provider of [...loginCases, ...chatCompletionsLoginCases]) {
			expect(loginProviders).toContainEqual(expect.objectContaining({ id: provider.id, name: provider.name }));
		}
	});

	for (const provider of loginCases) {
		test(`${provider.id} validates API keys against its models endpoint`, async () => {
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				expect(url).toBe(provider.modelsUrl);
				expect(init?.method).toBe("GET");
				expect(init?.headers).toEqual({ Authorization: `Bearer ${provider.key}` });
				return new Response(JSON.stringify({ object: "list", data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const apiKey = await provider.login({
				onPrompt: async () => provider.key,
				fetch: fetchMock,
			});

			expect(apiKey).toBe(provider.key);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		test(`${provider.id} surfaces validation failures`, async () => {
			const fetchMock: FetchImpl = vi.fn(async () => new Response('{"error":"invalid_api_key"}', { status: 401 }));

			await expect(
				provider.login({
					onPrompt: async () => provider.key,
					fetch: fetchMock,
				}),
			).rejects.toThrow(`${provider.name} API key validation failed (401)`);
		});
	}

	for (const provider of chatCompletionsLoginCases) {
		test(`${provider.id} validates API keys with an authenticated chat completions request`, async () => {
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				expect(url).toBe(provider.validationUrl);
				expect(init?.method).toBe("POST");
				expect(init?.headers).toEqual({
					"Content-Type": "application/json",
					Authorization: `Bearer ${provider.key}`,
				});
				expect(JSON.parse(String(init?.body))).toEqual({
					model: provider.model,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					temperature: 0,
				});
				return new Response(JSON.stringify({ id: "validation", choices: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const apiKey = await provider.login({
				onPrompt: async () => provider.key,
				fetch: fetchMock,
			});

			expect(apiKey).toBe(provider.key);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		test(`${provider.id} surfaces chat validation failures`, async () => {
			const fetchMock: FetchImpl = vi.fn(async () => new Response('{"error":"invalid_api_key"}', { status: 401 }));

			await expect(
				provider.login({
					onPrompt: async () => provider.key,
					fetch: fetchMock,
				}),
			).rejects.toThrow(`${provider.name} API key validation failed (401)`);
		});
	}
});
