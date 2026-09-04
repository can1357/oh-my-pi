import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getOAuthProvider, registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "configured-oauth";

async function writeModelsConfig(tempDir: TempDir, provider = PROVIDER, clientId = "client-id") {
	const configPath = path.join(tempDir.path(), "models.yml");
	await Bun.write(
		configPath,
		`providers:\n  ${provider}:\n    baseUrl: https://api.example.com/v1\n    api: openai-completions\n    authHeader: true\n    oauth:\n      name: Configured OAuth\n      clientId: ${JSON.stringify(clientId)}\n      clientSecret: CONFIGURED_OAUTH_SECRET\n      authorizationUrl: https://accounts.example.com/oauth/authorize\n      tokenUrl: https://accounts.example.com/oauth/token\n      scopes: [openid, email]\n      callbackPort: 0\n    models:\n      - id: configured-model\n        name: Configured Model\n        reasoning: false\n        input: [text]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 128000\n        maxTokens: 32000\n`,
	);
}

afterEach(() => {
	unregisterOAuthProviders("models-config");
	delete Bun.env.CONFIGURED_OAUTH_SECRET;
});

describe("models.yml provider OAuth", () => {
	test("registers OAuth and permits custom models without apiKey", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(tempDir);
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(registry.getError()).toBeUndefined();
			expect(registry.find(PROVIDER, "configured-model")).toBeDefined();
			expect(getOAuthProvider(PROVIDER)?.name).toBe("Configured OAuth");
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("rejects configured OAuth outside the user config", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-scope-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(tempDir);
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			expect(registry.getError()?.message).toContain("configured OAuth is supported only in the user models.yml");
			expect(getOAuthProvider(PROVIDER)).toBeUndefined();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("rejects built-in provider IDs", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-built-in-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(tempDir, "openai-codex");
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(registry.getError()?.message).toContain("configured OAuth cannot replace a built-in provider");
			expect(getOAuthProvider("openai-codex")).toBeUndefined();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("surfaces an unresolved command-backed client ID", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-client-id-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(tempDir, PROVIDER, "!false");
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(String(registry.getError())).toContain("oauth.clientId could not be resolved");
			expect(getOAuthProvider(PROVIDER)).toBeUndefined();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("resolves OAuth client secrets from environment variables", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-env-");
		const authStorage = await AuthStorage.create(":memory:");
		Bun.env.CONFIGURED_OAUTH_SECRET = "resolved-secret";
		try {
			await writeModelsConfig(tempDir);
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { allowConfiguredOAuth: true });
			const provider = getOAuthProvider(PROVIDER);
			expect(provider).toBeDefined();
			let requestBody = "";
			await provider!.login({
				onAuth(info) {
					const url = new URL(info.url);
					void fetch(`${url.searchParams.get("redirect_uri")}?code=code&state=${url.searchParams.get("state")}`);
				},
				onPrompt: async () => "",
				fetch: async (_input, init) => {
					requestBody = String(init?.body);
					return Response.json({
						access_token: "access",
						refresh_token: "refresh",
						expires_in: 3600,
						token_type: "Bearer",
					});
				},
			});
			expect(new URLSearchParams(requestBody).get("client_secret")).toBe("resolved-secret");
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("validates callbackPath as an absolute pathname", () => {
		const base = {
			name: "Configured OAuth",
			clientId: "client-id",
			authorizationUrl: "https://accounts.example.com/oauth/authorize",
			tokenUrl: "https://accounts.example.com/oauth/token",
			scopes: ["openid"],
		};
		for (const callbackPath of ["", "callback", "/callback?tenant=x", "/callback#fragment"]) {
			const result = ModelsConfigSchema({
				providers: {
					[PROVIDER]: {
						baseUrl: "https://api.example.com/v1",
						api: "openai-completions",
						oauth: { ...base, callbackPath },
					},
				},
			});
			expect(result.constructor.name).not.toBe("Object");
		}
		const valid = ModelsConfigSchema({
			providers: {
				[PROVIDER]: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					oauth: { ...base, callbackPath: "/callback" },
				},
			},
		});
		expect(valid.constructor.name).toBe("Object");
	});

	test("rolls back only OAuth providers registered by the failed load", async () => {
		const primaryDir = TempDir.createSync("@models-config-oauth-primary-");
		const secondaryDir = TempDir.createSync("@models-config-oauth-secondary-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(primaryDir, "primary-oauth");
			const primary = new ModelRegistry(authStorage, path.join(primaryDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(primary.getError()).toBeUndefined();
			expect(getOAuthProvider("primary-oauth")?.name).toBe("Configured OAuth");

			await writeModelsConfig(secondaryDir, "openai-codex");
			const secondary = new ModelRegistry(authStorage, path.join(secondaryDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(secondary.getError()?.message).toContain("configured OAuth cannot replace a built-in provider");
			// Failed secondary load must not wipe the primary registration.
			expect(getOAuthProvider("primary-oauth")?.name).toBe("Configured OAuth");
		} finally {
			authStorage.close();
			await primaryDir.remove();
			await secondaryDir.remove();
		}
	});

	test("refuses to overwrite an extension-owned OAuth provider", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-extension-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			registerOAuthProvider({
				id: PROVIDER,
				name: "Extension OAuth",
				sourceId: "extension-source",
				login: async () => ({ access: "x", refresh: "y", expires: Date.now() + 60_000 }),
			});
			await writeModelsConfig(tempDir);
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
				allowConfiguredOAuth: true,
			});
			expect(String(registry.getError())).toContain("already registered by source");
			expect(getOAuthProvider(PROVIDER)?.name).toBe("Extension OAuth");
		} finally {
			unregisterOAuthProviders("extension-source");
			authStorage.close();
			await tempDir.remove();
		}
	});
});
