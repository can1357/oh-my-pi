import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, type FetchImpl } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("issue #5780 post-auth runtime provider refresh", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let dbPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const sourceId = "ext://issue-5780";
	const providerName = "issue-5780-provider";
	const FAKE_KEY = "issue-5780-fake-credential-abc123";
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-5780-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		dbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		vi.useRealTimers();
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function registerAuthGatedProvider(): void {
		const config: ProviderConfigInput = {
			baseUrl: "https://issue-5780.example.com/v1",
			api: "openai-completions",
			authHeader: true,
			// Model appears only once the credential exists.
			fetchDynamicModels: async (apiKey?: string) => {
				if (!apiKey) return [];
				return [
					{
						id: "gated-model",
						name: "Gated Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		registry.registerProvider(providerName, config, sourceId);
	}

	test("provider-scoped online refresh after login re-runs discovery past a fresh empty cache", async () => {
		registerAuthGatedProvider();

		// Refresh before login: stores an authoritative empty runtime-provider cache
		// entry with the 24h TTL (fetchDynamicModels returned [] unauthenticated).
		await registry.refreshRuntimeProviders();
		expect(registry.find(providerName, "gated-model")).toBeUndefined();

		// Login persists a credential.
		await authStorage.set(providerName, { type: "api_key", key: FAKE_KEY });

		// What the fixed /login, /logout, sign-in, and RPC login sites now do: a
		// provider-scoped online refresh. It must bypass the fresh authoritative
		// empty row and re-invoke fetchDynamicModels with the new credential so the
		// model becomes available in-session.
		await registry.refreshProvider(providerName, "online");
		expect(registry.find(providerName, "gated-model")).toBeDefined();
	});
	test("model cache does not serialize provider credentials", async () => {
		// Provider config carries a literal credential + authHeader, mirroring an
		// extension gateway. The dynamic factory itself never returns a credential.
		const config: ProviderConfigInput = {
			baseUrl: "https://issue-5780.example.com/v1",
			api: "openai-completions",
			apiKey: FAKE_KEY,
			authHeader: true,
			fetchDynamicModels: async () => [
				{
					id: "gated-model",
					name: "Gated Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		};
		registry.registerProvider(providerName, config, sourceId);
		await registry.refreshProvider(providerName, "online");

		// The model cache is a plaintext SQLite file; it must not carry the API key.
		const raw = fs.readFileSync(dbPath);
		expect(raw.includes(FAKE_KEY)).toBe(false);
	});
});
