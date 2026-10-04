import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, type FetchImpl } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Extension providers (e.g. nexos-pi-provider) register `apiKey: "<ENV_NAME>"`
// alongside a `/login` flow. With the env var unset, the name resolves to its
// literal text; it must not shadow the key saved by /login, or discovery and
// requests authenticate with "<ENV_NAME>" and the provider's models vanish.
describe("runtime provider apiKey vs /login credential", () => {
	const provider = "login-key-precedence";
	const envName = "LOGIN_KEY_PRECEDENCE_TEST_KEY";
	const sourceId = "ext://login-key-precedence";
	const savedKey = "saved-login-key";
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled"));
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let discoveryKeys: Array<string | undefined>;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-login-key-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
		discoveryKeys = [];
		delete process.env[envName];
	});

	afterEach(() => {
		delete process.env[envName];
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function register(options: { oauth: boolean }): void {
		const config: ProviderConfigInput = {
			apiKey: envName,
			baseUrl: "https://login-key-precedence.example.com/v1",
			api: "openai-completions",
			...(options.oauth ? { oauth: { name: "Test", login: async () => savedKey } } : {}),
			fetchDynamicModels: async apiKey => {
				discoveryKeys.push(apiKey);
				if (apiKey !== savedKey && apiKey !== "env-key") throw new Error("401 invalid key");
				return [
					{
						id: "listed-model",
						name: "Listed",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		registry.registerProvider(provider, config, sourceId);
	}

	async function login(): Promise<void> {
		await authStorage.oauth.login(provider, {
			onAuth() {},
			onPrompt: async () => savedKey,
		});
	}

	test("saved /login key beats an unset env-var apiKey for discovery and requests", async () => {
		register({ oauth: true });
		await login();
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual([savedKey]);
		expect(registry.find(provider, "listed-model")).toBeDefined();
		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
	});

	test("login key survives a static reload that reinstalls runtime keys", async () => {
		register({ oauth: true });
		await login();
		await registry.refresh("online");

		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
		expect(registry.find(provider, "listed-model")).toBeDefined();
	});

	test("without a login, the provider apiKey still resolves from the environment", async () => {
		process.env[envName] = "env-key";
		register({ oauth: true });
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual(["env-key"]);
		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});

	test("providers without a /login flow keep apiKey as an override", async () => {
		process.env[envName] = "env-key";
		register({ oauth: false });
		// A /login-sourced key outranks the fallback tier, so env-key wins only as an override.
		await authStorage.credentials.set(provider, { type: "api_key", key: "stored-key", source: "login" });

		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});
});
