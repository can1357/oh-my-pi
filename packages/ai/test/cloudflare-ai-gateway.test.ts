import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	parseCloudflareAiGatewayCredential,
	serializeCloudflareAiGatewayCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { withEnv } from "./helpers";

const ANTHROPIC_MODEL = buildModel({
	id: "anthropic/claude-sonnet-4.5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const OPENAI_MODEL = buildModel({
	...ANTHROPIC_MODEL,
	id: "openai/gpt-5.4",
	name: "GPT-5.4",
	api: "anthropic-messages",
	baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
});

const WORKERS_MODEL = buildModel({
	...ANTHROPIC_MODEL,
	id: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
	name: "Llama 4 Scout",
});

const CONTEXT = { messages: [{ role: "user" as const, content: "Say hello", timestamp: 0 }] };

function registeredLogin(options: OAuthController) {
	const login = getProviderDefinition("cloudflare-ai-gateway")?.login;
	if (!login) throw new Error("Cloudflare AI Gateway login is not registered");
	return login(options);
}

async function loginCloudflareAiGateway(options: OAuthController): Promise<string> {
	const result = await registeredLogin(options);
	if (typeof result !== "string") throw new Error("Expected Cloudflare AI Gateway API-key credential");
	return result;
}

interface CapturedRequest {
	url?: string;
	headers?: Headers;
	body?: string;
}

function captureRequest(captured: CapturedRequest): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = String(input instanceof Request ? input.url : input);
			captured.headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			captured.body = typeof init?.body === "string" ? init.body : undefined;
			return Response.json({ error: { message: "captured" } }, { status: 400 });
		},
		{ preconnect: fetch.preconnect },
	);
}

function prepareGatewayRequest(model: Model, apiKey?: string) {
	const provider = getProviderDefinition("cloudflare-ai-gateway");
	const providerModel = provider?.prepareModel?.(model) ?? model;
	return provider?.prepareRequest?.(providerModel, { apiKey });
}

describe("Cloudflare AI Gateway", () => {
	test("login collects the gateway token, account ID, and gateway ID", async () => {
		const prompts = ["cf-gateway-token", "account-id", "default"];
		const promptMessages: string[] = [];
		const result = await loginCloudflareAiGateway({
			onAuth: () => {},
			onPrompt: async prompt => {
				promptMessages.push(prompt.message);
				return prompts.shift() ?? "";
			},
		});

		expect(promptMessages).toEqual([
			"Paste your Cloudflare AI Gateway token/API key",
			"Enter your Cloudflare account ID",
			"Enter your Cloudflare AI Gateway ID",
		]);
		expect(parseCloudflareAiGatewayCredential(result)).toEqual({
			token: "cf-gateway-token",
			accountId: "account-id",
			gatewayId: "default",
		});
	});

	test("stored login metadata materializes the gateway endpoint", () => {
		const model = ANTHROPIC_MODEL;
		const credential = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");
		const prepared = prepareGatewayRequest(model, credential);
		expect(prepared?.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/anthropic");
		expect(prepared?.model.requestModelId).toBe("claude-sonnet-4-5");
		expect(prepared?.options.apiKey).toBe("gateway-token");
	});

	test("uses gateway authorization without leaking it as OpenAI bearer auth", () => {
		const credential = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");
		const prepared = prepareGatewayRequest(
			{
				...OPENAI_MODEL,
				headers: { Authorization: "Bearer upstream-token", "X-Api-Key": "upstream-key" },
			},
			credential,
		);

		expect(prepared?.model.headers?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
		expect(prepared?.model.api).toBe("openai-completions");
		expect(prepared?.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai");
		expect(prepared?.model.requestModelId).toBe("gpt-5.4");
		expect(prepared?.model.headers?.Authorization).toBeUndefined();
		expect(prepared?.model.headers?.["X-Api-Key"]).toBeUndefined();
		expect(prepared?.options.apiKey).toBe("N/A");
	});

	test("keeps the Workers AI provider namespace for streamed compatibility requests", async () => {
		const captured: CapturedRequest = {};
		const credential = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");
		await stream(WORKERS_MODEL, CONTEXT, {
			apiKey: credential,
			fetch: captureRequest(captured),
			maxTokens: 16,
		}).result();

		expect(captured.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/compat/chat/completions");
		expect(captured.headers?.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(JSON.parse(captured.body ?? "{}").model).toBe("workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct");
	});

	test("sends OpenAI-format models through the gateway without upstream bearer auth", async () => {
		const captured: CapturedRequest = {};
		const credential = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");
		await stream(OPENAI_MODEL, CONTEXT, {
			apiKey: credential,
			fetch: captureRequest(captured),
			maxTokens: 16,
		}).result();

		expect(captured.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai/chat/completions");
		expect(captured.headers?.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(captured.headers?.get("authorization")).toBeNull();
		expect(JSON.parse(captured.body ?? "{}").model).toBe("gpt-5.4");
	});
	test("AuthStorage persists gateway routing metadata with the token", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		const prompts = ["persisted-token", "persisted-account", "persisted-gateway"];
		try {
			await authStorage.login("cloudflare-ai-gateway", {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
			});

			expect(parseCloudflareAiGatewayCredential(store.getApiKey("cloudflare-ai-gateway") ?? "")).toEqual({
				token: "persisted-token",
				accountId: "persisted-account",
				gatewayId: "persisted-gateway",
			});
		} finally {
			store.close();
		}
	});

	test("re-login replaces routing metadata for the same gateway token", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		const prompts = [
			"persisted-token",
			"old-account",
			"old-gateway",
			"persisted-token",
			"new-account",
			"new-gateway",
		];
		try {
			const controller = {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
			};
			await authStorage.login("cloudflare-ai-gateway", controller);
			await authStorage.login("cloudflare-ai-gateway", controller);

			const credentials = store.listAuthCredentials("cloudflare-ai-gateway");
			expect(credentials).toHaveLength(1);
			const stored = credentials[0]?.credential;
			expect(stored?.type).toBe("api_key");
			expect(parseCloudflareAiGatewayCredential(stored?.type === "api_key" ? stored.key : "")).toEqual({
				token: "persisted-token",
				accountId: "new-account",
				gatewayId: "new-gateway",
			});
		} finally {
			store.close();
		}
	});
	test("materializes environment-only gateway configuration", async () => {
		await withEnv(
			{
				CLOUDFLARE_AI_GATEWAY_API_KEY: "environment-token",
				CLOUDFLARE_ACCOUNT_ID: "environment-account",
				CLOUDFLARE_GATEWAY_ID: "environment-gateway",
			},
			async () => {
				const prepared = prepareGatewayRequest(ANTHROPIC_MODEL);
				expect(prepared?.model.baseUrl).toBe(
					"https://gateway.ai.cloudflare.com/v1/environment-account/environment-gateway/anthropic",
				);
				expect(prepared?.options.apiKey).toBe("environment-token");
			},
		);
	});

	test("keeps legacy plain tokens working with an explicit base URL", () => {
		const model = {
			...ANTHROPIC_MODEL,
			baseUrl: "https://gateway.ai.cloudflare.com/v1/legacy-account/legacy-gateway/anthropic",
		};
		const prepared = prepareGatewayRequest(model, "legacy-token");

		expect(prepared?.model.baseUrl).toBe(model.baseUrl);
		expect(prepared?.model.requestModelId).toBe("claude-sonnet-4-5");
		expect(prepared?.options.apiKey).toBe("legacy-token");
	});
});
