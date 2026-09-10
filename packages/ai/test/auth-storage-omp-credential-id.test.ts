import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const PROVIDER = "unit-omp-credential-id";
const PROVIDER_KEY = `${PROVIDER}:oauth`;
const FUTURE_BLOCK_MS = Date.now() + 60 * 60_000;

function oauthCredential(access: string) {
	return {
		type: "oauth" as const,
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${access}`,
		email: `${access}@example.com`,
	};
}

describe("AuthStorage OMP_CREDENTIAL_ID env pin", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-omp-credential-id-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER];
			if (!credential) return null;
			return { apiKey: credential.access, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function storage(): AuthStorage {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage;
	}

	test("OMP_CREDENTIAL_ID=abc getApiKey throws for a non-integer id", async () => {
		await storage().set(PROVIDER, [oauthCredential("stored-access")]);

		await withEnv({ OMP_CREDENTIAL_ID: "abc" }, async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-invalid")).rejects.toThrow(
				/OMP_CREDENTIAL_ID must be a positive integer/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=99999 getApiKey throws when credential is not found", async () => {
		await storage().set(PROVIDER, [oauthCredential("stored-access")]);

		await withEnv({ OMP_CREDENTIAL_ID: "99999" }, async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-missing")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=99999 does not match any OAuth credential/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey returns the pinned stored access token", async () => {
		await storage().set(PROVIDER, [oauthCredential("pinned-access")]);

		await withEnv({ OMP_CREDENTIAL_ID: "1" }, async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "omp-credential-pinned");
			expect(apiKey).toBe("pinned-access");
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when the credential is disabled", async () => {
		await storage().set(PROVIDER, [oauthCredential("disabled-access")]);
		expect(storage().disableCredentialById(1, "disabled for test")).toBe(true);

		await withEnv({ OMP_CREDENTIAL_ID: "1" }, async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-disabled")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=1 is disabled/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when the credential is blocked", async () => {
		if (!store?.upsertCredentialBlock) throw new Error("test setup failed");
		await storage().set(PROVIDER, [oauthCredential("blocked-access")]);
		store.upsertCredentialBlock({
			credentialId: 1,
			providerKey: PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		await withEnv({ OMP_CREDENTIAL_ID: "1" }, async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-blocked")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=1 is temporarily blocked/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when a scoped block applies", async () => {
		if (!store?.upsertCredentialBlock) throw new Error("test setup failed");
		const anthropicProvider = "anthropic";
		const anthropicProviderKey = `${anthropicProvider}:oauth`;
		await storage().set(anthropicProvider, [oauthCredential("scoped-blocked-access")]);
		store.upsertCredentialBlock({
			credentialId: 1,
			providerKey: anthropicProviderKey,
			blockScope: "tier:fable",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		await withEnv({ OMP_CREDENTIAL_ID: "1" }, async () => {
			await expect(
				storage().getApiKey(anthropicProvider, "omp-credential-scoped-blocked", {
					modelId: "claude-fable-5",
				}),
			).rejects.toThrow(/OMP_CREDENTIAL_ID=1 is temporarily blocked/);
		});
	});

	function setExclusiveHold(sessionId: string, credentialId: number): void {
		if (!store?.setCache) throw new Error("test setup failed");
		const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
		store.setCache(
			`session:exclusive:${PROVIDER}:${credentialId}`,
			JSON.stringify({ sessionId }),
			expiresAtSec,
		);
	}

	test("OMP_CREDENTIAL_ID=2 getApiKey throws when another session holds an exclusive pin", async () => {
		await storage().set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		setExclusiveHold("owner-session", 2);

		await withEnv({ OMP_CREDENTIAL_ID: "2" }, async () => {
			await expect(storage().getApiKey(PROVIDER, "other-session")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=2 is exclusively held by another session/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=2 getApiKey succeeds for the exclusive pin owner", async () => {
		await storage().set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		setExclusiveHold("owner-session", 2);

		await withEnv({ OMP_CREDENTIAL_ID: "2" }, async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "owner-session");
			expect(apiKey).toBe("b");
		});
	});
});
