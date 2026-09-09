import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

describe("AuthStorage OAuth refresh skew", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-refresh-skew-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		unregisterOAuthProviders("auth-storage-refresh-skew-test");
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("refreshes before strict expiry when the credential is inside the 60s skew", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let refreshCalls = 0;
		const refreshedExpires = Date.now() + 60 * 60_000;
		registerOAuthProvider({
			id: "unit-oauth-skew",
			name: "Unit OAuth Skew",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "access-after-skew-refresh",
					refresh: "refresh-after-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew", [
			{
				type: "oauth",
				access: "access-before-skew-refresh",
				refresh: "refresh-before-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-skew", "skew-session");

		expect(apiKey).toBe("access-after-skew-refresh");
		expect(refreshCalls).toBe(1);
		const stored = store.listAuthCredentials("unit-oauth-skew");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("access-after-skew-refresh");
			expect(stored[0].credential.refresh).toBe("refresh-after-skew-refresh");
		}
	});

	test("coalesces concurrent skew refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		registerOAuthProvider({
			id: "unit-oauth-skew-mutex",
			name: "Unit OAuth Skew Mutex",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-after-shared-skew-refresh",
					refresh: "refresh-after-shared-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew-mutex", [
			{
				type: "oauth",
				access: "access-before-shared-skew-refresh",
				refresh: "refresh-before-shared-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const first = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-after-shared-skew-refresh");
		await expect(second).resolves.toBe("access-after-shared-skew-refresh");
		expect(refreshCalls).toBe(1);
	});
});
