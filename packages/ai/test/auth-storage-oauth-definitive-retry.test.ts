import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-definitive-retry";
const SOURCE = "auth-storage-oauth-definitive-retry-test";
const RETRY_DELAY_ENV = "OAUTH_DEFINITIVE_REFRESH_RETRY_DELAY_MS";
const PREVIOUS_RETRY_DELAY = process.env[RETRY_DELAY_ENV];
const EXPECTED_ATTEMPTS = 3; // 1 initial + OAUTH_DEFINITIVE_REFRESH_RETRIES

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

function invalidGrantError(): Error {
	return new Error('400 {"error":"invalid_grant","error_description":"Bad Request"}');
}

describe("AuthStorage definitive OAuth refresh retry", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		process.env[RETRY_DELAY_ENV] = "1";
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-definitive-retry-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		if (PREVIOUS_RETRY_DELAY === undefined) delete process.env[RETRY_DELAY_ENV];
		else process.env[RETRY_DELAY_ENV] = PREVIOUS_RETRY_DELAY;
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function registerProvider(refreshToken: () => Promise<OAuthCredentials>): void {
		registerOAuthProvider({
			id: PROVIDER,
			name: "Definitive Retry Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			refreshToken,
			getApiKey: credentials => credentials.access,
		});
	}

	test("transient invalid_grant is retried; the credential survives and serves the refreshed token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(async () => {
			refreshCalls += 1;
			if (refreshCalls === 1) throw invalidGrantError();
			return { access: "recovered-access", refresh: "recovered-refresh", expires: farExpiry() };
		});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);

		const key = await authStorage.keys.get(PROVIDER, "s-retry");
		expect(key).toBe("recovered-access");
		expect(refreshCalls).toBe(2);

		// The grant was NOT disabled and the refreshed token is persisted.
		const active = store.listAuthCredentials(PROVIDER);
		expect(active).toHaveLength(1);
		expect(active[0]?.credential.type).toBe("oauth");
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.access).toBe("recovered-access");
		}
		expect(await store.listDisabledCredentials(PROVIDER)).toHaveLength(0);
	});

	test("persistent invalid_grant exhausts the retries, then disables the credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(async () => {
			refreshCalls += 1;
			throw invalidGrantError();
		});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);

		const key = await authStorage.keys.get(PROVIDER, "s-exhausted");
		expect(key).toBeUndefined();
		expect(refreshCalls).toBe(EXPECTED_ATTEMPTS);

		expect(store.listAuthCredentials(PROVIDER)).toHaveLength(0);
		const disabled = await store.listDisabledCredentials(PROVIDER);
		expect(disabled).toHaveLength(1);
		expect(String(disabled[0]?.cause)).toContain("invalid_grant");
	});

	test("a revoked or unauthorized grant still disables on the first failure", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(async () => {
			refreshCalls += 1;
			throw new Error('400 {"error":"unauthorized_client","error_description":"client is not authorized"}');
		});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);

		const key = await authStorage.keys.get(PROVIDER, "s-revoked");
		expect(key).toBeUndefined();
		// Only `invalid_grant` is retried: a dead grant must not cost two more
		// token requests before the credential is disabled.
		expect(refreshCalls).toBe(1);
		expect(store.listAuthCredentials(PROVIDER)).toHaveLength(0);
		expect(await store.listDisabledCredentials(PROVIDER)).toHaveLength(1);
	});

	test("non-definitive failures are not retried", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(async () => {
			refreshCalls += 1;
			throw new Error("fetch failed: network unreachable");
		});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);

		const key = await authStorage.keys.get(PROVIDER, "s-transient");
		expect(key).toBeUndefined();
		// Exactly one attempt — transient errors keep the pre-existing no-retry behavior.
		expect(refreshCalls).toBe(1);
		// The credential is kept (temporarily blocked), not disabled.
		expect(store.listAuthCredentials(PROVIDER)).toHaveLength(1);
		expect(await store.listDisabledCredentials(PROVIDER)).toHaveLength(0);
	});
});
