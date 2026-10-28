import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage OAuth refresh race", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-race-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		oauthUtils.unregisterOAuthProviders("auth-storage-oauth-refresh-race-test");
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("does not disable a credential another process already rotated", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Seed the shared DB with one expired OAuth credential; this simulates the
		// state two cooperating omp processes both load from the persisted row.
		await authStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Simulate the peer's successful refresh: another process called the real
		// `#replaceCredentialAt` path, which rotates the row in place via
		// updateAuthCredential. The in-memory snapshot we hold is now stale.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		// Mock mirrors Anthropic: only the stale refresh token is rejected, because
		// real rotation invalidates the previous refresh token on use.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.keys.get("anthropic", "session-race");

			// We should have picked up the rotated credential instead of disabling
			// the row that the peer just updated.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(authStorage!.credentials.has("anthropic")).toBe(true);

			// The row must still be active in storage; before the fix it would be
			// soft-deleted with disabled_cause set to the invalid_grant error.
			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("does not disable when peer rotates between pre-check and CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Refresh genuinely fails — the pre-check that compares the persisted
		// refresh token to our snapshot will therefore see the SAME stale token
		// and fall through to the disable. We then race a peer rotation into the
		// window between the pre-check and the CAS, which the CAS must detect.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		const sharedStore = store;
		const originalTryDisable = sharedStore.tryDisableAuthCredentialIfMatches.bind(sharedStore);
		const tryDisableSpy = vi
			.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches")
			.mockImplementation((id, expectedData, disabledCause) => {
				// Simulate the peer's successful rotation landing in the window
				// between the pre-check (which saw the stale token) and the CAS
				// disable. The CAS predicate `data = expectedData` must now miss.
				sharedStore.updateAuthCredential(id, {
					type: "oauth",
					access: "fresh-access-from-peer",
					refresh: "fresh-refresh-from-peer",
					expires: Date.now() + 60 * 60_000,
				});
				return originalTryDisable(id, expectedData, disabledCause);
			});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.keys.get("anthropic", "session-cas-race");

			// CAS lost → reload → pick up the peer-rotated credential.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(tryDisableSpy).toHaveBeenCalled();

			// Row must still be active, with the peer's rotated tokens.
			const stored = sharedStore.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
				expect(stored[0].credential.access).toBe("fresh-access-from-peer");
			}
		});
	});

	test("still disables when the failure is real (no concurrent rotation)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Single-process scenario: refresh genuinely fails and no peer updated the
		// row. The credential should still be soft-deleted.
		await authStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.keys.get("anthropic", "session-real-failure");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});
	});
	test("persists every credential refreshed during candidate preflight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-preflight",
			name: "Unit OAuth Preflight",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.credentials.set("unit-oauth-preflight", [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires },
		]);

		const apiKey = await authStorage.keys.get("unit-oauth-preflight");
		expect(apiKey).toBe("access-a-rotated");

		const stored = store.listAuthCredentials("unit-oauth-preflight");
		expect(stored).toHaveLength(2);
		const oauth = stored.map(entry => entry.credential).filter(credential => credential.type === "oauth");
		expect(oauth.map(credential => credential.refresh).sort()).toEqual(["refresh-a-rotated", "refresh-b-rotated"]);
	});

	test("preflight retries a peer-rotated credential instead of stranding it", async () => {
		const staleExpires = Date.now() - 60_000;
		const freshExpires = Date.now() + 60 * 60_000;

		// A store WITHOUT durable-lease support: the lease path in
		// #refreshOAuthCredentialUnshared wraps refresh in refreshStoredOAuthCredential,
		// which absorbs a peer rotation itself. We want the definitive failure to reach
		// #resolveOAuthSelection's own preflight catch so the "peer-rotated" outcome of
		// #disableDefinitiveOAuthFailure is what's actually exercised.
		const rows: StoredAuthCredential[] = [
			{
				id: 1,
				provider: "unit-oauth-preflight-rotate",
				credential: { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: staleExpires },
				disabledCause: null,
			},
		];
		const cache = new Map<string, { value: string; expiresAtSec: number }>();
		const noLeaseStore: AuthCredentialStore = {
			close() {},
			listAuthCredentials(provider) {
				return provider ? rows.filter(row => row.provider === provider) : rows;
			},
			updateAuthCredential(id, credential) {
				const row = rows.find(entry => entry.id === id);
				if (row) row.credential = credential;
			},
			async deleteAuthCredential() {
				return false;
			},
			tryDisableAuthCredentialIfMatches() {
				return false;
			},
			async replaceAuthCredentials() {
				return rows;
			},
			async upsertAuthCredential() {
				return rows;
			},
			async deleteAuthCredentials() {},
			getCache(key) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key, value, expiresAtSec) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-preflight-rotate",
			name: "Unit OAuth Preflight Rotate",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: freshExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				if (credentials.refresh === "stale-refresh") {
					// A peer completed its own refresh mid-flight and rotated the shared row;
					// our stale refresh token is now dead (invalid_grant), but the persisted
					// row holds the peer's freshly rotated credential.
					rows[0]!.credential = {
						type: "oauth",
						access: "fresh-access-from-peer",
						refresh: "fresh-refresh-from-peer",
						expires: freshExpires,
					};
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				}
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		const events: CredentialDisabledEvent[] = [];
		const storage = new AuthStorage(noLeaseStore, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await storage.credentials.reload();

		const apiKey = await storage.keys.get("unit-oauth-preflight-rotate", "session-preflight-rotate");

		// The single stored credential was peer-rotated during preflight refresh. The
		// resolve pass must pick up the reloaded fresh credential instead of adding the
		// candidate to preflightFailures and returning undefined.
		expect(apiKey).toBe("fresh-access-from-peer");
		expect(events).toHaveLength(0);
		// Preflight refreshed once and threw; the final pass reuses the fresh token
		// synced from the reloaded row rather than replaying a second refresh.
		expect(refreshCalls).toBe(1);
		const stored = noLeaseStore.listAuthCredentials("unit-oauth-preflight-rotate");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
		}
	});

	test("coalesces concurrent refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-mutex",
			name: "Unit OAuth Mutex",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.credentials.set("unit-oauth-mutex", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const first = authStorage.keys.get("unit-oauth-mutex", "same-session");
		const second = authStorage.keys.get("unit-oauth-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-rotated");
		await expect(second).resolves.toBe("access-rotated");
		expect(refreshCalls).toBe(1);
	});

	test("serializes rotating provider refresh tokens across AuthStorage instances", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const usedRefreshTokens = new Set<string>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-cross-process",
			name: "Unit OAuth Cross Process",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				if (usedRefreshTokens.has(credentials.refresh)) {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				}
				usedRefreshTokens.add(credentials.refresh);
				await Bun.sleep(50);
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.credentials.set("unit-oauth-cross-process", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const secondStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const secondStorage = new AuthStorage(secondStore);
		await secondStorage.credentials.reload();
		try {
			const [first, second] = await Promise.all([
				authStorage.keys.get("unit-oauth-cross-process", "session-first"),
				secondStorage.keys.get("unit-oauth-cross-process", "session-second"),
			]);

			expect(first).toBe("access-rotated");
			expect(second).toBe("access-rotated");
			expect(refreshCalls).toBe(1);
			expect(secondStore.listAuthCredentials("unit-oauth-cross-process")).toHaveLength(1);
		} finally {
			secondStorage.close();
		}
	});

	test("does not overwrite a peer rotation after releasing the refresh lease", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const sharedStore = store;

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-post-lease-race",
			name: "Unit OAuth Post-Lease Race",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "access-from-this-process",
					refresh: "refresh-from-this-process",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				if (credentialId === undefined) throw new Error("credential id not initialized");
				sharedStore.updateAuthCredential(credentialId, {
					type: "oauth",
					access: "access-from-peer",
					refresh: "refresh-from-peer",
					expires: refreshedExpires,
				});
				return credentials.access;
			},
		});

		await authStorage.credentials.set("unit-oauth-post-lease-race", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-post-lease-race")[0]?.id;
		expect(credentialId).toBeDefined();

		const apiKey = await authStorage.keys.get("unit-oauth-post-lease-race", "session-post-lease");
		expect(apiKey).toBe("access-from-this-process");
		const persisted = store.listAuthCredentials("unit-oauth-post-lease-race")[0]?.credential;
		expect(persisted?.type).toBe("oauth");
		if (persisted?.type === "oauth") {
			expect(persisted.refresh).toBe("refresh-from-peer");
			expect(persisted.access).toBe("access-from-peer");
		}
	});

	test("returns the targeted OAuth row after a compare-and-set refresh loss", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		await authStorage.credentials.set("unit-oauth-cas-loss", [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires },
			{ type: "oauth", access: "access-target", refresh: "refresh-target", expires },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-cas-loss")[1]?.id;
		expect(credentialId).toBeDefined();
		if (credentialId === undefined) return;

		const result = await authStorage.oauth.refreshStored("unit-oauth-cas-loss", {
			credentialId,
			forceRefresh: true,
			credentialFromRow: credential => credential,
			async refresh(current) {
				store!.updateAuthCredential(credentialId, {
					...current,
					access: "access-from-peer",
					refresh: "refresh-from-peer",
				});
				return { ...current, access: "access-from-this-process", refresh: "refresh-from-this-process" };
			},
		});

		expect(result.refreshed).toBe(false);
		expect(result.credential).toMatchObject({ access: "access-from-peer", refresh: "refresh-from-peer" });
		const rows = store.listAuthCredentials("unit-oauth-cas-loss");
		expect(rows[0]?.credential).toMatchObject({ type: "oauth", access: "access-first" });
		expect(rows[1]?.credential).toMatchObject({ type: "oauth", access: "access-from-peer" });
	});

	test("syncs peer-updated SQLite OAuth rows before returning access tokens", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 60 * 60_000;
		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-peer-sync",
			name: "Unit OAuth Peer Sync",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.credentials.set("unit-oauth-peer-sync", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-peer-sync");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-peer",
			refresh: "refresh-peer",
			expires,
		});
		const apiKey = await authStorage.keys.get("unit-oauth-peer-sync", "session-peer-sync");
		expect(apiKey).toBe("access-peer");
		expect(refreshCalls).toBe(0);

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-peer-force",
			refresh: "refresh-peer-force",
			expires,
		});
		const forcedKey = await authStorage.keys.get("unit-oauth-peer-sync", "session-peer-sync", {
			forceRefresh: true,
		});
		expect(forcedKey).toBe("access-peer-force");
		expect(refreshCalls).toBe(0);
	});

	test("invalidating a session-sticky OAuth credential rotates the retry to another active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		let sessionId = "";
		for (let index = 0; index < 32; index++) {
			const candidate = `session-auth-retry-${index}`;
			if (Bun.hash.xxHash32(candidate) % 2 === 0) {
				sessionId = candidate;
				break;
			}
		}
		if (!sessionId) throw new Error("could not find test session id");

		await authStorage.credentials.set("unit-oauth-rotation", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await authStorage.keys.get("unit-oauth-rotation", sessionId);
		expect(firstKey).toBe("access-a");

		const invalidated = await authStorage.limits.invalidateMatching("unit-oauth-rotation", "access-a", {
			sessionId,
		});
		expect(invalidated).toBe(true);

		const retryKey = await authStorage.keys.get("unit-oauth-rotation", sessionId);
		expect(retryKey).toBe("access-b");
	});

	test("persists a refreshed token by id when a concurrent disable shifts indices", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const now = Date.now();
		// Three distinct expired accounts → index order A, B, C by id ascending.
		await authStorage.credentials.set("anthropic", [
			{ type: "oauth", access: "a-acc", refresh: "a-ref", expires: now - 60_000, accountId: "acc-a", email: "a@x" },
			{ type: "oauth", access: "b-acc", refresh: "b-ref", expires: now - 60_000, accountId: "acc-b", email: "b@x" },
			{ type: "oauth", access: "c-acc", refresh: "c-ref", expires: now - 60_000, accountId: "acc-c", email: "c@x" },
		]);
		const seeded = store.listAuthCredentials("anthropic");
		expect(seeded).toHaveLength(3);
		const idA = seeded[0]!.id;
		const idB = seeded[1]!.id;
		const idC = seeded[2]!.id;

		// While B refreshes, a definitive failure disables A — removing index 0 and
		// shifting B from index 1 to index 0. A pre-await positional write would
		// land B's rotated token on C; the id-addressed write must hit B and leave
		// C untouched.
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			if (credential.refresh === "b-ref") {
				await authStorage!.credentials.disable(idA, "test: concurrent disable");
				return {
					access: "b-fresh",
					refresh: "b-fresh-ref",
					expires: now + 60 * 60_000,
					accountId: "acc-b",
					email: "b@x",
				};
			}
			return { ...credential, expires: now + 60 * 60_000 };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const refreshed = await authStorage!.oauth.refresh(idB);
			expect(refreshed.id).toBe(idB);
		});

		const after = store.listAuthCredentials("anthropic");
		const bRow = after.find(row => row.id === idB);
		const cRow = after.find(row => row.id === idC);
		expect(bRow?.credential.type).toBe("oauth");
		if (bRow?.credential.type === "oauth") expect(bRow.credential.refresh).toBe("b-fresh-ref");
		expect(cRow?.credential.type).toBe("oauth");
		if (cRow?.credential.type === "oauth") expect(cRow.credential.refresh).toBe("c-ref");
	});

	test("propagates CAS update storage errors instead of treating them as peer refresh wins", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.credentials.set("unit-oauth-cas-update-error", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		]);

		const failure = new Error("sqlite update failed");
		vi.spyOn(store, "tryUpdateAuthCredentialIfMatches").mockImplementation(() => {
			throw failure;
		});

		await expect(
			authStorage.oauth.refreshStored("unit-oauth-cas-update-error", {
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async credential => ({
					...credential,
					access: "access-fresh",
					refresh: "refresh-fresh",
					expires: Date.now() + 60 * 60_000,
				}),
			}),
		).rejects.toThrow("sqlite update failed");

		const stored = store.listAuthCredentials("unit-oauth-cas-update-error");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("propagates CAS disable storage errors instead of treating them as peer rotations", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.credentials.set("unit-oauth-cas-disable-error", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		]);

		const failure = new Error("sqlite disable failed");
		vi.spyOn(store, "tryDisableAuthCredentialIfMatches").mockImplementation(() => {
			throw failure;
		});

		await expect(
			authStorage.oauth.refreshStored("unit-oauth-cas-disable-error", {
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				},
				isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
				disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			}),
		).rejects.toThrow("sqlite disable failed");

		expect(events).toHaveLength(0);
		const stored = store.listAuthCredentials("unit-oauth-cas-disable-error");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("does not persist a refresh when durable lease ownership is lost before CAS update", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.credentials.set("unit-oauth-lease-update", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: now - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-lease-update");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;
		const stealLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!stealLease) throw new Error("test store does not support refresh leases");
		const save = store.tryUpdateAuthCredentialIfMatches?.bind(store);
		if (!save) throw new Error("test store does not support compare-and-set updates");
		const holderOf = store.getCredentialRefreshLeaseHolder?.bind(store);
		if (!holderOf) throw new Error("test store does not report lease holders");
		// A refused save is retried while the row is unchanged, until the save
		// window ends. Record every attempt, and end the window after four.
		const attempts: { saved: boolean; holder: string | undefined; holderLive: boolean }[] = [];
		vi.spyOn(store, "tryUpdateAuthCredentialIfMatches").mockImplementation((...args) => {
			const holder = holderOf(credentialId);
			const saved = save(...args);
			attempts.push({ saved, holder: holder?.owner, holderLive: (holder?.expiresAtMs ?? 0) > Date.now() });
			if (attempts.length === 4) setSystemTime(new Date(now + 16_000 + 61_000));
			return saved;
		});

		const result = await authStorage.oauth.refreshStored("unit-oauth-lease-update", {
			credentialFromRow: row => row,
			forceRefresh: true,
			// The clock jumps past the save window; keep the caller waiting for the save.
			refreshTimeoutMs: 600_000,
			refresh: async credential => {
				// Keep the credential row bytes unchanged while expiring owner A's
				// lease. A non-lease-fenced final CAS would still persist this token.
				setSystemTime(new Date(now + 16_000));
				// The peer's lease outlives the whole save window.
				expect(stealLease(credentialId, "peer-owner", now + 600_000)).toBe(true);
				return {
					...credential,
					access: "access-from-lost-owner",
					refresh: "refresh-from-lost-owner",
					expires: now + 60 * 60_000,
				};
			},
		});

		expect(attempts).toHaveLength(4);
		for (const attempt of attempts) expect(attempt).toEqual({ saved: false, holder: "peer-owner", holderLive: true });
		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
		const stored = store.listAuthCredentials("unit-oauth-lease-update");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
		expect(holderOf(credentialId)?.owner).toBe("peer-owner");
	});

	test("does not terminal-disable a credential when durable lease ownership is lost before CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T12:30:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.credentials.set("unit-oauth-lease-disable", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: now - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-lease-disable");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;
		const stealLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!stealLease) throw new Error("test store does not support refresh leases");
		const disableSpy = vi.spyOn(store, "tryDisableAuthCredentialIfMatches");

		const result = await authStorage.oauth.refreshStored("unit-oauth-lease-disable", {
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				// The row still contains the same stale refresh token. Only the lease
				// fence distinguishes stale owner A from the current row owner.
				setSystemTime(new Date(now + 16_000));
				expect(stealLease(credentialId, "peer-owner", now + 31_000)).toBe(true);
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		});

		expect(disableSpy).toHaveBeenCalled();
		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
		expect(events).toHaveLength(0);
		const stored = store.listAuthCredentials("unit-oauth-lease-disable");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("refreshes an expired stored credential even when it mismatches the observed copy", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T13:00:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.credentials.set("unit-oauth-observed-mismatch-expired", [
			{
				type: "oauth",
				access: "stored-access-expired",
				refresh: "stored-refresh",
				expires: now - 60_000,
			},
		]);

		// The caller observed a different (also stale) copy of the credential — the
		// exact state the finalize path hits when a concurrent usage-fetch cycle
		// rotates the in-memory credential out from under the request between the
		// selection sync and the refresh read. Before the fix the observed-mismatch
		// guard returned the stored copy verbatim without checking whether it was
		// usable, so the expired token flowed straight into getOAuthApiKey.
		const observed = {
			type: "oauth" as const,
			access: "observed-access-different",
			refresh: "stored-refresh",
			expires: now - 120_000,
		};

		let refreshCalled = false;
		const result = await authStorage.oauth.refreshStored("unit-oauth-observed-mismatch-expired", {
			observedCredential: observed,
			credentialFromRow: row => row,
			forceRefresh: false,
			refresh: async credential => {
				refreshCalled = true;
				return {
					...credential,
					access: "refreshed-access",
					refresh: "stored-refresh",
					expires: now + 60 * 60_000,
				};
			},
		});

		// The expired stored credential must be refreshed, not returned as-is.
		expect(refreshCalled).toBe(true);
		expect(result).toMatchObject({ refreshed: true, removed: false });
		expect(result.credential).toMatchObject({ type: "oauth", access: "refreshed-access" });
		const stored = store.listAuthCredentials("unit-oauth-observed-mismatch-expired");
		expect(stored[0]?.credential).toMatchObject({ type: "oauth", access: "refreshed-access" });
	});

	test("adopts a fresh stored credential without refreshing when it mismatches the observed copy", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T13:30:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.credentials.set("unit-oauth-observed-mismatch-fresh", [
			{
				type: "oauth",
				access: "peer-rotated-access",
				refresh: "peer-rotated-refresh",
				expires: now + 60 * 60_000,
			},
		]);

		// A peer already rotated the row to a fresh token; the caller's observed
		// copy is stale. The fresh stored copy must be adopted without a redundant
		// refresh (which would waste a rotation and could invalidate the peer's
		// token).
		const observed = {
			type: "oauth" as const,
			access: "stale-observed-access",
			refresh: "stale-observed-refresh",
			expires: now - 60_000,
		};

		let refreshCalled = false;
		const result = await authStorage.oauth.refreshStored("unit-oauth-observed-mismatch-fresh", {
			observedCredential: observed,
			credentialFromRow: row => row,
			forceRefresh: false,
			refresh: async credential => {
				refreshCalled = true;
				return { ...credential, access: "should-not-be-used", expires: now + 60 * 60_000 };
			},
		});

		expect(refreshCalled).toBe(false);
		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({ type: "oauth", access: "peer-rotated-access" });
	});

	test("stops after a definitive refresh failure loses its disable CAS", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.credentials.set("unit-oauth-definitive-cas-loss", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		]);
		const controller = new AbortController();
		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-definitive-cas-loss",
			name: "Unit OAuth Definitive CAS Loss",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken() {
				refreshCalls += 1;
				if (refreshCalls > 1) controller.abort(new Error("unexpected retry"));
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		vi.spyOn(store, "tryDisableAuthCredentialIfMatches").mockReturnValue(false);

		await expect(
			authStorage.keys.get("unit-oauth-definitive-cas-loss", "session-cas-loss", {
				signal: controller.signal,
			}),
		).resolves.toBeUndefined();
		expect(refreshCalls).toBe(1);
	});
	test("persists a rotated token when the requesting usage call is canceled", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-caller-abort",
			name: "Unit OAuth Caller Abort",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: 0 };
			},
			async refreshToken(current) {
				started.resolve();
				await release.promise;
				return { ...current, access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
			},
			getApiKey(current) {
				return current.access;
			},
		});
		await authStorage.credentials.set("unit-oauth-caller-abort", [
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-caller-abort")[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		const controller = new AbortController();
		const request = authStorage.oauth.refresh(credentialId, controller.signal);
		await started.promise;
		controller.abort();
		await expect(request).rejects.toThrow();
		release.resolve();
		// A second consumer must see the rotated token rather than replaying the consumed grant.
		expect(await authStorage.keys.get("unit-oauth-caller-abort", "next-session")).toBe("new-access");
		expect(store.listAuthCredentials("unit-oauth-caller-abort")[0]?.credential).toMatchObject({
			type: "oauth",
			refresh: "new-refresh",
		});
	});

	test("a key request cancelled while taking the refresh lease settles without an unhandled rejection", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-abort-during-lease";
		const exchanges = registerSingleUseProvider(provider);
		await authStorage.credentials.set(provider, [
			{ type: "oauth", access: "access-0", refresh: "refresh-0", expires: 0 },
		]);
		const controller = new AbortController();
		const acquire = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!acquire) throw new Error("test store does not support refresh leases");
		// The caller cancels while the refresh it started is still inside its synchronous lease acquisition.
		vi.spyOn(store, "tryAcquireCredentialRefreshLease").mockImplementation((id, owner, expiresAt) => {
			controller.abort();
			return acquire(id, owner, expiresAt);
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				authStorage.keys.get(provider, "cancelled-session", { signal: controller.signal }),
			).resolves.toBeUndefined();
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			expect(exchanges.exchanges()).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("a caller cancelled before refreshing does not hand its cancellation to a joining caller", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-cancelled-owner";
		const exchanges = registerSingleUseProvider(provider);
		await authStorage.credentials.set(provider, [
			{ type: "oauth", access: "access-0", refresh: "refresh-0", expires: 0 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		const cancelled = authStorage.oauth.refresh(credentialId, AbortSignal.abort());
		const live = authStorage.oauth.refresh(credentialId);
		await expect(cancelled).rejects.toThrow("credential refresh aborted");
		expect((await live).credential).toMatchObject({ type: "oauth", access: "access-1" });
		expect(exchanges.exchanges()).toBe(1);
	});

	/** Provider whose refresh tokens are single-use, like Anthropic's; counts exchanges. */
	function registerSingleUseProvider(id: string): { exchanges: () => number } {
		let generation = 0;
		let liveRefresh = "refresh-0";
		oauthUtils.registerOAuthProvider({
			id,
			name: id,
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: 0 };
			},
			async refreshToken(current) {
				if (current.refresh !== liveRefresh) {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				}
				generation += 1;
				liveRefresh = `refresh-${generation}`;
				return {
					...current,
					access: `access-${generation}`,
					refresh: liveRefresh,
					expires: Date.now() + 3_600_000,
				};
			},
			getApiKey(current) {
				return current.access;
			},
		});
		return { exchanges: () => generation };
	}

	/** Store a login with a fresh access token, and return its row id. */
	async function seedLogin(provider: string): Promise<number> {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set(provider, [
			{ type: "oauth", access: "access-0", refresh: "refresh-0", expires: Date.now() + 3_600_000 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		return credentialId;
	}

	test("a provider-401 refresh adopts the token another process rotated to, instead of exchanging again", async () => {
		if (!authStorage || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-401-peer-rotated";
		const peerRotation = registerSingleUseProvider(provider);
		await seedLogin(provider);

		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		try {
			await peer.credentials.reload();
			// The peer's own 401 rotates the row, which revokes access-0 everywhere.
			expect(
				await peer.oauth.access(provider, "peer-session", {
					forceRefresh: true,
					refreshReason: "auth-recovery",
					rejectedAccessToken: "access-0",
				}),
			).toMatchObject({ accessToken: "access-1" });
			// This process reloaded the rotated row before its own in-flight request
			// failed with a 401 on access-0: adopt access-1 rather than exchange.
			await authStorage.credentials.reload();
			expect(
				await authStorage.oauth.access(provider, "own-session", {
					forceRefresh: true,
					refreshReason: "auth-recovery",
					rejectedAccessToken: "access-0",
				}),
			).toMatchObject({ accessToken: "access-1" });
			expect(peerRotation.exchanges()).toBe(1);
			expect(events).toHaveLength(0);
		} finally {
			peer.close();
		}
	});

	test("a provider-401 refresh still exchanges when the stored token is the rejected one", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-401-no-peer";
		const noPeer = registerSingleUseProvider(provider);
		await seedLogin(provider);

		expect(
			await authStorage.oauth.access(provider, "own-session", {
				forceRefresh: true,
				refreshReason: "auth-recovery",
				rejectedAccessToken: "access-0",
			}),
		).toMatchObject({ accessToken: "access-1" });
		expect(noPeer.exchanges()).toBe(1);
	});

	test("a forced refresh adopts the row a peer rotated after this process loaded it", async () => {
		if (!authStorage || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-forced-peer-rotated";
		const forced = registerSingleUseProvider(provider);
		const credentialId = await seedLogin(provider);

		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		try {
			await peer.credentials.reload();
			await peer.oauth.refresh(credentialId);
			// This process still holds access-0 / refresh-0 in memory.
			const refreshed = await authStorage.oauth.refresh(credentialId);
			expect(refreshed.credential).toMatchObject({ type: "oauth", access: "access-1" });
			expect(forced.exchanges()).toBe(1);
			expect(events).toHaveLength(0);
		} finally {
			peer.close();
		}
	});

	test("keeps an exchanged token when the store is busy at save time", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-busy-save";
		const busy = registerSingleUseProvider(provider);
		await authStorage.credentials.set(provider, [
			{ type: "oauth", access: "access-0", refresh: "refresh-0", expires: Date.now() - 60_000 },
		]);
		const original = store.tryUpdateAuthCredentialIfMatches?.bind(store);
		if (!original) throw new Error("test store does not support compare-and-set updates");
		let busyWrites = 0;
		vi.spyOn(store, "tryUpdateAuthCredentialIfMatches").mockImplementation((...args) => {
			if (busyWrites < 2) {
				busyWrites += 1;
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			}
			return original(...args);
		});

		expect(await authStorage.keys.get(provider, "session")).toBe("access-1");
		expect(busyWrites).toBe(2);
		expect(busy.exchanges()).toBe(1);
		expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-1",
			refresh: "refresh-1",
		});
	});

	test.skipIf(process.platform === "win32")("SIGTERM waits for a rotated token to reach SQLite", async () => {
		if (!store || !tempDir) throw new Error("test setup failed");
		const release = path.join(tempDir, "release-response");
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/oauth-sigterm-child.ts"),
				path.join(tempDir, "agent.db"),
				release,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			const first = await Promise.race([
				child.stdout.getReader().read(),
				child.exited.then(() => {
					throw new Error("OAuth child exited before the provider rotated its token");
				}),
			]);
			expect(new TextDecoder().decode(first.value)).toContain("rotated");
			child.kill("SIGTERM");
			await Bun.write(release, "complete");
			expect(await child.exited).toBe(143);
			expect(store.listAuthCredentials("anthropic")[0]?.credential).toMatchObject({
				type: "oauth",
				access: "new",
				refresh: "new-refresh",
			});
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});

	test.skipIf(process.platform === "win32")(
		"quitting while an exchanged token waits on a long write lock still saves it",
		async () => {
			if (!store || !tempDir) throw new Error("test setup failed");
			const dbPath = path.join(tempDir, "agent.db");
			await authStorage!.credentials.set("anthropic", [
				{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 },
			]);
			const release = path.join(tempDir, "release-response");
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/oauth-quit-child.ts"), dbPath, release],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const writer = new Database(dbPath);
			// The child's lease renewal writes too; wait for it rather than fail the lock.
			writer.run("PRAGMA busy_timeout = 5000");
			try {
				const first = await Promise.race([
					child.stdout.getReader().read(),
					child.exited.then(() => {
						throw new Error("OAuth child exited before the provider rotated its token");
					}),
				]);
				expect(new TextDecoder().decode(first.value)).toContain("rotated");
				// Another process holds the write lock for longer than the default 10 s
				// cleanup deadline; the child quits while its save waits on that lock.
				// Real time on purpose: that deadline runs in the child process, which
				// fake timers here cannot advance.
				writer.run("BEGIN IMMEDIATE");
				await Bun.write(release, "complete");
				await Bun.sleep(12_000);
				writer.run("ROLLBACK");
				expect(await child.exited).toBe(0);
				// The quit waited on the save, so it said so where the user can see it.
				expect(await new Response(child.stderr).text()).toContain(
					"Waiting for the login refresh to finish saving (up to",
				);
				expect(store.listAuthCredentials("anthropic")[0]?.credential).toMatchObject({
					type: "oauth",
					access: "new",
					refresh: "new-refresh",
				});
			} finally {
				writer.close();
				if (child.exitCode === null) child.kill();
				await child.exited;
			}
		},
		30_000,
	);

	for (const stage of ["during-pass", "after-pass"] as const) {
		test.skipIf(process.platform === "win32")(
			`a refresh that starts once exit has begun never leaves a spent token (${stage})`,
			async () => {
				if (!store || !tempDir) throw new Error("test setup failed");
				const dbPath = path.join(tempDir, "agent.db");
				const marker = path.join(tempDir, "exchanged");
				await authStorage!.credentials.set("anthropic", [
					{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 },
				]);
				// `during-pass`: the refresh starts in another owner's cleanup; `after-pass`: just before the real exit.
				const child = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "fixtures/oauth-refresh-during-exit-child.ts"),
						dbPath,
						marker,
						stage,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				try {
					expect(await child.exited).toBe(0);
					// Nothing was left to save, so the quit printed no wait line.
					expect(await new Response(child.stderr).text()).not.toContain("Waiting for the login refresh");
					expect(await Bun.file(`${marker}.started`).exists()).toBe(true);
					// Either no exchange started, or the token it got was saved before exit.
					const exchanged = await Bun.file(marker).exists();
					expect(store.listAuthCredentials("anthropic")[0]?.credential).toMatchObject(
						exchanged ? { access: "new", refresh: "new-refresh" } : { access: "old", refresh: "old-refresh" },
					);
				} finally {
					if (child.exitCode === null) child.kill();
					await child.exited;
				}
			},
			30_000,
		);
	}

	test("a 401 names the token of the request that failed, not of the last request started", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-interleaved-401";
		const interleaved = registerSingleUseProvider(provider);
		await seedLogin(provider);
		const resolver = authStorage.keys.resolver(provider, { sessionId: "shared" });

		// Two requests share the resolver and both send access-0.
		const first = await resolver({ lastChance: false, error: undefined });
		const second = await resolver({ lastChance: false, error: undefined });
		expect(first).toMatchObject({ apiKey: "access-0" });
		expect(second).toMatchObject({ apiKey: "access-0" });

		// The first 401 exchanges once; the resolver has now served access-1.
		const unauthorized = Object.assign(new Error("401 revoked"), { status: 401 });
		const recovered = await resolver({ lastChance: false, error: unauthorized, previousKey: "access-0" });
		expect(recovered).toMatchObject({ apiKey: "access-1" });
		expect(interleaved.exchanges()).toBe(1);

		// The second request's 401 arrives late and still names access-0: it adopts
		// the peer's access-1 rather than exchanging the refresh token again.
		const late = await resolver({ lastChance: false, error: unauthorized, previousKey: "access-0" });
		expect(late).toMatchObject({ apiKey: "access-1" });
		expect(interleaved.exchanges()).toBe(1);

		// A 401 on the token the resolver now serves does exchange again.
		const current = await resolver({ lastChance: false, error: unauthorized, previousKey: "access-1" });
		expect(current).toMatchObject({ apiKey: "access-2" });
		expect(interleaved.exchanges()).toBe(2);
	});

	test("a 401 recovery that joins a row refresh landing on the rejected token refreshes again", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-joined-row-refresh";
		const firstAnswer = Promise.withResolvers<void>();
		let exchanges = 0;
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: provider,
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: 0 };
			},
			async refreshToken(current) {
				exchanges += 1;
				const generation = exchanges;
				if (generation === 1) await firstAnswer.promise;
				return {
					...current,
					access: `access-${generation}`,
					refresh: `refresh-${generation}`,
					expires: Date.now() + 3_600_000,
				};
			},
			getApiKey(current) {
				return current.access;
			},
		});
		const credentialId = await seedLogin(provider);

		// An older request starts a row refresh, which will land on access-1.
		const first = authStorage.oauth.refresh(credentialId);
		// A second request already got a 401 for access-1 (it was served access-1 from a
		// peer, say) and recovers while the first refresh is still in flight.
		const recovery = authStorage.oauth.refresh(credentialId, undefined, {
			reason: "auth-recovery",
			rejectedAccess: "access-1",
		});
		firstAnswer.resolve();
		expect((await first).credential).toMatchObject({ access: "access-1" });
		expect((await recovery).credential).toMatchObject({ access: "access-2" });
		expect(exchanges).toBe(2);
	});

	test("a 401 recovery does not adopt a peer row that still carries the rejected access token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-peer-same-access";
		const singleUse = registerSingleUseProvider(provider);
		const credentialId = await seedLogin(provider);
		const resolver = authStorage.keys.resolver(provider, { sessionId: "peer-same-access" });
		expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "access-0" });

		// A peer rewrote the row without replacing its access token: only the expiry moved.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() + 2 * 3_600_000,
		});
		const unauthorized = Object.assign(new Error("401 revoked"), { status: 401 });
		const recovered = await resolver({ lastChance: false, error: unauthorized, previousKey: "access-0" });
		expect(recovered).toMatchObject({ apiKey: "access-1" });
		expect(singleUse.exchanges()).toBe(1);
	});

	test("does not disable a login when its refresh token is rejected after taking over a stalled refresher", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-stalled-owner";
		await seedLogin(provider);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		const takeLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!takeLease) throw new Error("test store does not support refresh leases");
		// A peer took the lease, spent refresh-0 at the provider, and is still
		// retrying its save; its lease has just lapsed.
		expect(takeLease(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);

		const result = await authStorage.oauth
			.refreshStored(provider, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				},
				isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
				disabledCause: () => "oauth refresh failed",
			})
			.then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			);

		expect(String("error" in result ? result.error : "")).toContain("stalled refresher");
		expect(events).toHaveLength(0);
		const stored = store.listAuthCredentials(provider);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toMatchObject({ type: "oauth", refresh: "refresh-0" });
		// The lease went back to the stalled owner so it can still save its token.
		expect(store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner).toBe("stalled-peer");
	});

	test("a caller that keeps its credential on refresh failure gets it back after a takeover rejection", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-stalled-owner-keep";
		await seedLogin(provider);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		const takeLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!takeLease) throw new Error("test store does not support refresh leases");
		expect(takeLease(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
		const failures: unknown[] = [];

		// The options an MCP server refresh passes: keep the current token on any
		// refresh failure that does not disable the login.
		const result = await authStorage.oauth.refreshStored(provider, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			disabledCause: () => "oauth refresh failed",
			keepCredentialOnRefreshFailure: true,
			onRefreshFailure: error => {
				failures.push(error);
			},
		});

		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({ type: "oauth", refresh: "refresh-0" });
		expect(failures).toHaveLength(1);
		expect(String(failures[0])).toContain("stalled refresher");
		expect(events).toHaveLength(0);
		expect(store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner).toBe("stalled-peer");
	});

	test("a store error during the hand-back after a takeover rejection still goes through the failure policy", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-stalled-owner-handback-error";
		await seedLogin(provider);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		expect(store.tryAcquireCredentialRefreshLease?.(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
		vi.spyOn(store, "handBackCredentialRefreshLease").mockImplementation(() => {
			throw new Error("disk I/O error");
		});
		const failures: unknown[] = [];

		const result = await authStorage.oauth.refreshStored(provider, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			disabledCause: () => "oauth refresh failed",
			keepCredentialOnRefreshFailure: true,
			onRefreshFailure: error => {
				failures.push(error);
			},
		});

		expect(result.credential).toMatchObject({ type: "oauth", refresh: "refresh-0" });
		expect(String(failures[0])).toContain("stalled refresher");
		expect(events).toHaveLength(0);
	});

	test("a caller leaving without an exchange does not wait for a busy lease hand-back", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-detached-hand-back";
		await seedLogin(provider);
		const credentialId = store.listAuthCredentials(provider)[0]?.id;
		if (credentialId === undefined) throw new Error("missing stored credential");
		const takeLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		const handBack = store.handBackCredentialRefreshLease?.bind(store);
		if (!takeLease || !handBack) throw new Error("test store does not support lease hand-back");
		expect(takeLease(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
		let storeBusy = true;
		vi.spyOn(store, "handBackCredentialRefreshLease").mockImplementation((...args) => {
			if (storeBusy) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			return handBack(...args);
		});
		let canRefreshCalls = 0;

		const refresh = authStorage.oauth.refreshStored(provider, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			// Allowed before the lease, refused after it: the caller leaves holding a taken-over lease.
			canRefresh: () => ++canRefreshCalls === 1,
			refresh: async () => {
				throw new Error("the caller must leave before any exchange");
			},
		});
		try {
			// The hand-back retries the busy store for up to a minute; the caller must not.
			const first = await Promise.race([refresh.then(() => "returned"), Bun.sleep(2_000).then(() => "waiting")]);
			expect(first).toBe("returned");
			expect((await refresh).credential).toMatchObject({ type: "oauth", refresh: "refresh-0" });
			// The detached hand-back still lands once the store frees up.
			storeBusy = false;
			for (let poll = 0; poll < 100; poll++) {
				if (store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner === "stalled-peer") break;
				await Bun.sleep(50);
			}
			expect(store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner).toBe("stalled-peer");
		} finally {
			storeBusy = false;
			await refresh.catch(() => undefined);
		}
	});

	test("a hung exchange gives up at the backstop even under a longer caller budget", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-backstop-ceiling";
		const credentialId = await seedLogin(provider);
		vi.useFakeTimers();
		try {
			let exchangeSignal: AbortSignal | undefined;
			const started = Promise.withResolvers<void>();
			const refresh = authStorage.oauth.refreshStored(provider, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				// Longer than the 60 s backstop that a peer taking over a lapsed lease relies on.
				refreshTimeoutMs: 300_000,
				refresh: (_current, signal) => {
					exchangeSignal = signal;
					started.resolve();
					return Promise.withResolvers<never>().promise;
				},
			});
			const settled = refresh.then(
				() => "resolved",
				(error: unknown) => String(error),
			);
			await started.promise;
			vi.advanceTimersByTime(59_999);
			expect(exchangeSignal?.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(exchangeSignal?.aborted).toBe(true);
			expect(await settled).toContain("timed out");
		} finally {
			vi.useRealTimers();
		}
	});

	/** Refresh options for a 401 on access-0 whose refresh token the provider already rejects as spent. */
	function refreshSpentToken(
		credentialId: number,
		onExchange: () => void,
	): Parameters<AuthStorage["oauth"]["refreshStored"]>[1] {
		return {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			rejectedAccess: "access-0",
			refresh: async () => {
				onExchange();
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			disabledCause: () => "oauth refresh failed",
		};
	}

	test("keeps a stalled refresher's lease when the store is busy at hand-back", async () => {
		if (!store || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-handback-busy";
		const credentialId = await seedLogin(provider);
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		const laterStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const later = new AuthStorage(laterStore);
		const options = refreshSpentToken(credentialId, () => {});
		try {
			// A refresher spent refresh-0 and is still saving refresh-1; its lease just lapsed.
			expect(store.tryAcquireCredentialRefreshLease?.(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
			const handBack = peerStore.handBackCredentialRefreshLease.bind(peerStore);
			let busyHandBacks = 0;
			vi.spyOn(peerStore, "handBackCredentialRefreshLease").mockImplementation((...args) => {
				if (busyHandBacks === 0) {
					busyHandBacks += 1;
					throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
				}
				return handBack(...args);
			});
			const takeover = await peer.oauth.refreshStored(provider, options).then(
				() => "resolved",
				(error: unknown) => String(error),
			);
			expect(takeover).toContain("stalled refresher");
			expect(busyHandBacks).toBe(1);
			expect(store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner).toBe("stalled-peer");

			// Another process has the same spent token rejected: the login stays.
			const next = await later.oauth.refreshStored(provider, options).then(
				() => "resolved",
				(error: unknown) => String(error),
			);
			expect(next).toContain("stalled refresher");
			expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({ refresh: "refresh-0" });
		} finally {
			peer.close();
			later.close();
		}
	});

	test("keeps a recent lease holder when a busy hand-back never lands", async () => {
		if (!store || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-handback-never";
		const credentialId = await seedLogin(provider);
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		const laterStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const later = new AuthStorage(laterStore);
		// The clock jumps past the hand-back window; keep the caller waiting for the exchange.
		const options = { ...refreshSpentToken(credentialId, () => {}), refreshTimeoutMs: 600_000 };
		try {
			// A refresher spent refresh-0 and is still saving refresh-1; its lease just lapsed.
			expect(store.tryAcquireCredentialRefreshLease?.(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
			let busyHandBacks = 0;
			vi.spyOn(peerStore, "handBackCredentialRefreshLease").mockImplementation(() => {
				busyHandBacks += 1;
				// The store stays busy past the whole hand-back window.
				setSystemTime(new Date(Date.now() + 61_000));
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			});
			const takeover = await peer.oauth.refreshStored(provider, options).then(
				() => "resolved",
				(error: unknown) => String(error),
			);
			expect(takeover).toContain("stalled refresher");
			expect(busyHandBacks).toBeGreaterThan(0);
			// The taker never released its lease, so the row still names a recent holder.
			const holder = store.getCredentialRefreshLeaseHolder?.(credentialId);
			expect(holder).toBeDefined();
			expect(holder?.owner).not.toBe("stalled-peer");

			// Another process has the same spent token rejected: the login stays.
			const next = await later.oauth.refreshStored(provider, options).then(
				() => "resolved",
				(error: unknown) => String(error),
			);
			expect(next).toContain("stalled refresher");
			expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({ refresh: "refresh-0" });
		} finally {
			peer.close();
			later.close();
		}
	});

	/**
	 * A refresher takes over the lapsed lease of one that spent refresh-0 and is
	 * still saving, then leaves without saving; another process then has
	 * refresh-0 rejected. The lease must have gone back to the stalled refresher,
	 * so that rejection is not taken as proof the login is dead.
	 */
	async function expectTakeoverLeftForStalledOwner(
		provider: string,
		takeover: (peer: AuthStorage, peerStore: SqliteAuthCredentialStore, credentialId: number) => Promise<unknown>,
	): Promise<void> {
		if (!store || !tempDir) throw new Error("test setup failed");
		const credentialId = await seedLogin(provider);
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		const laterStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const later = new AuthStorage(laterStore);
		try {
			expect(store.tryAcquireCredentialRefreshLease?.(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
			await takeover(peer, peerStore, credentialId);
			expect(store.getCredentialRefreshLeaseHolder?.(credentialId)?.owner).toBe("stalled-peer");
			const next = await later.oauth
				.refreshStored(
					provider,
					refreshSpentToken(credentialId, () => {}),
				)
				.then(
					() => "resolved",
					(error: unknown) => String(error),
				);
			expect(next).toContain("stalled refresher");
			expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({ refresh: "refresh-0" });
		} finally {
			peer.close();
			later.close();
		}
	}

	test("hands a taken-over lease back when the caller's budget runs out while taking it", async () => {
		await expectTakeoverLeftForStalledOwner("unit-oauth-takeover-budget", async (peer, peerStore, credentialId) => {
			const acquire = peerStore.tryAcquireCredentialRefreshLease.bind(peerStore);
			vi.spyOn(peerStore, "tryAcquireCredentialRefreshLease").mockImplementation((...args) => {
				const acquired = acquire(...args);
				// A write lock held the acquire past the caller's 10 s budget.
				setSystemTime(new Date(Date.now() + 11_000));
				return acquired;
			});
			let exchanges = 0;
			await expect(
				peer.oauth.refreshStored("unit-oauth-takeover-budget", {
					...refreshSpentToken(credentialId, () => {
						exchanges += 1;
					}),
				}),
			).rejects.toThrow("timed out");
			expect(exchanges).toBe(0);
		});
	});

	test("hands a taken-over lease back when it leaves before the exchange", async () => {
		await expectTakeoverLeftForStalledOwner("unit-oauth-takeover-cannot", async (peer, _peerStore, credentialId) => {
			let checks = 0;
			const result = await peer.oauth.refreshStored("unit-oauth-takeover-cannot", {
				...refreshSpentToken(credentialId, () => {}),
				// Refreshable when the lease is taken, no longer once the row is re-read under it.
				canRefresh: () => {
					checks += 1;
					return checks === 1;
				},
			});
			expect(result).toMatchObject({ refreshed: false });
			expect(checks).toBe(2);
		});
	});

	test("hands a taken-over lease back when the exchange fails transiently", async () => {
		await expectTakeoverLeftForStalledOwner(
			"unit-oauth-takeover-transient",
			async (peer, _peerStore, credentialId) => {
				await expect(
					peer.oauth.refreshStored("unit-oauth-takeover-transient", {
						...refreshSpentToken(credentialId, () => {}),
						refresh: async () => {
							throw new Error("HTTP 503 overloaded");
						},
					}),
				).rejects.toThrow("503");
			},
		);
	});

	test("saves an exchanged token when a peer holds the lease handed back to the stalled refresher", async () => {
		if (!authStorage || !store || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-handback-save";
		const credentialId = await seedLogin(provider);
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		const ownerStore = store;
		const save = ownerStore.tryUpdateAuthCredentialIfMatches?.bind(ownerStore);
		if (!save) throw new Error("test store does not support compare-and-set updates");
		// The lease the third refresher gives back once its own exchange is rejected.
		let thirdHandsBackTo: { owner: string; expiresAtMs: number } | undefined;
		vi.spyOn(ownerStore, "tryUpdateAuthCredentialIfMatches").mockImplementation((...args) => {
			const saved = save(...args);
			if (!saved && thirdHandsBackTo) {
				peerStore.handBackCredentialRefreshLease(credentialId, "third", thirdHandsBackTo);
				thirdHandsBackTo = undefined;
			}
			return saved;
		});
		try {
			const result = await authStorage.oauth.refreshStored(provider, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async current => {
					// This exchange stalls past its lease. A peer takes the lease over, has
					// the spent refresh-0 rejected and hands the lease back; a third
					// refresher holds it when this exchange's save lands.
					const holder = peerStore.getCredentialRefreshLeaseHolder(credentialId);
					if (!holder) throw new Error("the refreshing process holds no lease");
					expect(peerStore.renewCredentialRefreshLease(credentialId, holder.owner, Date.now() - 1_000)).toBe(true);
					const takeover = await peer.oauth
						.refreshStored(
							provider,
							refreshSpentToken(credentialId, () => {}),
						)
						.then(
							() => "resolved",
							(error: unknown) => String(error),
						);
					expect(takeover).toContain("stalled refresher");
					thirdHandsBackTo = peerStore.getCredentialRefreshLeaseHolder(credentialId);
					expect(thirdHandsBackTo?.owner).toBe(holder.owner);
					expect(peerStore.tryAcquireCredentialRefreshLease(credentialId, "third", Date.now() + 15_000)).toBe(
						true,
					);
					return { ...current, access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000 };
				},
				isDefinitiveFailure: () => false,
			});

			expect(result).toMatchObject({ refreshed: true, credential: { access: "access-1" } });
			expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
			});
			expect(events).toHaveLength(0);
		} finally {
			peer.close();
		}
	});

	test("saves an exchanged token when its lease renewal finds a takeover peer holding the lease", async () => {
		if (!authStorage || !store || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-renewal-lost";
		const credentialId = await seedLogin(provider);
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		const ownerStore = store;
		// Run the lease-renewal interval and the save backoff without real waits.
		const sleep = Bun.sleep;
		vi.spyOn(Bun, "sleep").mockImplementation((ms: number | Date) =>
			sleep(typeof ms === "number" ? Math.min(ms, 10) : ms),
		);
		let ownerLease: string | undefined;
		const renewalLost = Promise.withResolvers<void>();
		const acquire = ownerStore.tryAcquireCredentialRefreshLease?.bind(ownerStore);
		if (!acquire) throw new Error("test store does not support refresh leases");
		vi.spyOn(ownerStore, "tryAcquireCredentialRefreshLease").mockImplementation((...args) => {
			const acquired = acquire(...args);
			if (!acquired && args[1] === ownerLease) renewalLost.resolve();
			return acquired;
		});
		const ownerSettled = Promise.withResolvers<void>();
		const save = ownerStore.tryUpdateAuthCredentialIfMatches?.bind(ownerStore);
		if (!save) throw new Error("test store does not support compare-and-set updates");
		vi.spyOn(ownerStore, "tryUpdateAuthCredentialIfMatches").mockImplementation((...args) => {
			const saved = save(...args);
			if (!saved) ownerSettled.resolve();
			return saved;
		});
		let takeover: Promise<string> | undefined;
		try {
			const result = await authStorage.oauth
				.refreshStored(provider, {
					credentialId,
					credentialFromRow: row => row,
					forceRefresh: true,
					refresh: async current => {
						// This exchange stalls past its lease, and a peer takes the lease over
						// to send the refresh token this exchange already spent.
						ownerLease = peerStore.getCredentialRefreshLeaseHolder(credentialId)?.owner;
						if (!ownerLease) throw new Error("the refreshing process holds no lease");
						expect(peerStore.renewCredentialRefreshLease(credentialId, ownerLease, Date.now() - 1_000)).toBe(
							true,
						);
						takeover = peer.oauth
							.refreshStored(provider, {
								credentialId,
								credentialFromRow: row => row,
								forceRefresh: true,
								rejectedAccess: "access-0",
								refresh: async () => {
									// The provider rejects the spent token once this exchange has
									// returned and its first save attempt has been refused.
									await ownerSettled.promise;
									throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
								},
								isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
								disabledCause: () => "oauth refresh failed",
							})
							.then(
								() => "resolved",
								(error: unknown) => String(error),
							);
						expect(peerStore.getCredentialRefreshLeaseHolder(credentialId)?.owner).not.toBe(ownerLease);
						// The exchange returns only after a lease renewal found the peer holding the lease.
						await renewalLost.promise;
						return { ...current, access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000 };
					},
					isDefinitiveFailure: () => false,
				})
				.finally(() => ownerSettled.resolve());

			expect(await takeover).toContain("stalled refresher");
			expect(result).toMatchObject({ refreshed: true, credential: { access: "access-1" } });
			expect(store.listAuthCredentials(provider)[0]?.credential).toMatchObject({
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
			});
			expect(events).toHaveLength(0);
		} finally {
			await takeover;
			peer.close();
		}
	});

	test("waits for a stalled refresher's save instead of replaying the refresh token it spent", async () => {
		if (!tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-stalled-replay";
		const credentialId = await seedLogin(provider);
		const stores = await Promise.all(
			[0, 1].map(() => SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"))),
		);
		const processes = stores.map(peerStore => new AuthStorage(peerStore));
		let invalidGrants = 0;
		const options = refreshSpentToken(credentialId, () => {
			invalidGrants += 1;
		});
		try {
			// A refresher spent refresh-0 and is still saving refresh-1; its lease just lapsed.
			expect(stores[0]?.tryAcquireCredentialRefreshLease(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(
				true,
			);
			for (const peer of processes) {
				const first = await peer.oauth.refreshStored(provider, options).then(
					() => "resolved",
					(error: unknown) => String(error),
				);
				expect(first).toContain("stalled refresher");
			}
			expect(invalidGrants).toBe(2);

			// Every process retries its failed requests while that refresher still
			// saves; let the retries re-read the row twice each before it does.
			const rereads = Promise.withResolvers<void>();
			let reads = 0;
			for (const peerStore of stores) {
				const list = peerStore.listAuthCredentials.bind(peerStore);
				vi.spyOn(peerStore, "listAuthCredentials").mockImplementation(listed => {
					reads += 1;
					if (reads >= 8) rereads.resolve();
					return list(listed);
				});
			}
			const retries = processes.flatMap(peer =>
				[0, 1].map(() =>
					peer.oauth.refreshStored(provider, options).then(
						value => ({ value }),
						(error: unknown) => ({ error }),
					),
				),
			);
			await rereads.promise;
			expect(invalidGrants).toBe(2);
			stores[0]?.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 3_600_000,
			});
			for (const retry of await Promise.all(retries)) {
				expect(retry).toMatchObject({ value: { credential: { access: "access-1" }, refreshed: false } });
			}
			expect(invalidGrants).toBe(2);
			expect(events).toHaveLength(0);
		} finally {
			for (const peer of processes) peer.close();
		}
	});

	test("disables a login whose stalled refresher never saved, once its save window has passed", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-stalled-window";
		const credentialId = await seedLogin(provider);
		const takeLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!takeLease) throw new Error("test store does not support refresh leases");
		let invalidGrants = 0;
		const options = refreshSpentToken(credentialId, () => {
			invalidGrants += 1;
		});
		expect(takeLease(credentialId, "stalled-peer", Date.now() - 1_000)).toBe(true);
		const first = await authStorage.oauth.refreshStored(provider, options).then(
			() => "resolved",
			(error: unknown) => String(error),
		);
		expect(first).toContain("stalled refresher");

		// The refresher's exchange backstop and save window have both run out.
		setSystemTime(new Date(Date.now() + 125_000));
		expect(await authStorage.oauth.refreshStored(provider, options)).toMatchObject({ removed: true });
		expect(invalidGrants).toBe(2);
		expect(events).toHaveLength(1);
		expect(store.listAuthCredentials(provider)).toHaveLength(0);
	});

	test("a 401 recovery that joins another request's refresh does not get back the token it was refused", async () => {
		if (!authStorage || !tempDir) throw new Error("test setup failed");
		const provider = "unit-oauth-join-rejected";
		const joined = registerSingleUseProvider(provider);
		await seedLogin(provider);
		const resolver = authStorage.keys.resolver(provider, { sessionId: "shared" });
		expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "access-0" });
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		try {
			await peer.credentials.reload();
			// Another process's 401 rotates access-0 to access-1, and a later request here sends access-1.
			await peer.oauth.access(provider, "peer-session", {
				forceRefresh: true,
				refreshReason: "auth-recovery",
				rejectedAccessToken: "access-0",
			});
			await authStorage.credentials.reload();
			expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "access-1" });

			// Both requests fail at once. The one that sent access-0 adopts access-1;
			// the one that sent access-1 must not get access-1 back from that refresh.
			const unauthorized = Object.assign(new Error("401 revoked"), { status: 401 });
			const [, current] = await Promise.all([
				resolver({ lastChance: false, error: unauthorized, previousKey: "access-0" }),
				resolver({ lastChance: false, error: unauthorized, previousKey: "access-1" }),
			]);
			expect(current).toMatchObject({ apiKey: "access-2" });
			expect(joined.exchanges()).toBe(2);
		} finally {
			peer.close();
		}
	});
});
