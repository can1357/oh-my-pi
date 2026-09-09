import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("setConfigApiKey beats OAuth access token for getApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");

			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");
			expect(await authStorage.peekApiKey("anthropic")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats setConfigApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			authStorage.setRuntimeApiKey("anthropic", "cli-flag-bearer");

			expect(await authStorage.getApiKey("anthropic")).toBe("cli-flag-bearer");
		});
	});

	test("removeConfigApiKey restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");

			authStorage.removeConfigApiKey("anthropic");
			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-from-broker");
		});
	});

	test("clearConfigApiKeys drops every config override at once", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-anthropic");
			await seedOAuth("openai-codex", "oauth-codex");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer-A");
			authStorage.setConfigApiKey("openai-codex", "gateway-bearer-B");

			authStorage.clearConfigApiKeys();

			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-anthropic");
			expect(await authStorage.getApiKey("openai-codex")).toBe("oauth-codex");
		});
	});

	test("setConfigApiKey suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.getOAuthAccountId("anthropic")).toBe("acc-123");

			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			// With an explicit config bearer in play, OAuth account attribution
			// must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(authStorage.getOAuthAccountId("anthropic")).toBeUndefined();
		});
	});

	test("describeCredentialSource reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			expect(authStorage.describeCredentialSource("anthropic")).toBe("config override (models.yml)");
		});
	});
});
