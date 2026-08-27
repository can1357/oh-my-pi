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
		await authStorage.set("anthropic", [
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
			const apiKey = await authStorage!.getApiKey("anthropic", "session-race");

			// We should have picked up the rotated credential instead of disabling
			// the row that the peer just updated.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(authStorage!.list()).toContain("anthropic");

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

		await authStorage.set("anthropic", [
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
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-race");

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
		await authStorage.set("anthropic", [
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
			const apiKey = await authStorage!.getApiKey("anthropic", "session-real-failure");

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

		await authStorage.set("unit-oauth-preflight", [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires },
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-preflight");
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
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return false;
			},
			replaceAuthCredentialsForProvider() {
				return rows;
			},
			upsertAuthCredentialForProvider() {
				return rows;
			},
			deleteAuthCredentialsForProvider() {},
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
		await storage.reload();

		const apiKey = await storage.getApiKey("unit-oauth-preflight-rotate", "session-preflight-rotate");

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

		await authStorage.set("unit-oauth-mutex", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const first = authStorage.getApiKey("unit-oauth-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-mutex", "same-session");

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

		await authStorage.set("unit-oauth-cross-process", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const secondStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const secondStorage = new AuthStorage(secondStore);
		await secondStorage.reload();
		try {
			const [first, second] = await Promise.all([
				authStorage.getApiKey("unit-oauth-cross-process", "session-first"),
				secondStorage.getApiKey("unit-oauth-cross-process", "session-second"),
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
		let credentialId: number | undefined;

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

		await authStorage.set("unit-oauth-post-lease-race", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);
		credentialId = store.listAuthCredentials("unit-oauth-post-lease-race")[0]?.id;
		expect(credentialId).toBeDefined();

		const apiKey = await authStorage.getApiKey("unit-oauth-post-lease-race", "session-post-lease");
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
		await authStorage.set("unit-oauth-cas-loss", [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires },
			{ type: "oauth", access: "access-target", refresh: "refresh-target", expires },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-cas-loss")[1]?.id;
		expect(credentialId).toBeDefined();
		if (credentialId === undefined) return;

		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-cas-loss", {
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

		await authStorage.set("unit-oauth-peer-sync", [
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
		const apiKey = await authStorage.getApiKey("unit-oauth-peer-sync", "session-peer-sync");
		expect(apiKey).toBe("access-peer");
		expect(refreshCalls).toBe(0);

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-peer-force",
			refresh: "refresh-peer-force",
			expires,
		});
		const forcedKey = await authStorage.getApiKey("unit-oauth-peer-sync", "session-peer-sync", {
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

		await authStorage.set("unit-oauth-rotation", [
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

		const firstKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(firstKey).toBe("access-a");

		const invalidated = await authStorage.invalidateCredentialMatching("unit-oauth-rotation", "access-a", {
			sessionId,
		});
		expect(invalidated).toBe(true);

		const retryKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(retryKey).toBe("access-b");
	});

	test("persists a refreshed token by id when a concurrent disable shifts indices", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const now = Date.now();
		// Three distinct expired accounts → index order A, B, C by id ascending.
		await authStorage.set("anthropic", [
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
				authStorage!.disableCredentialById(idA, "test: concurrent disable");
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
			const refreshed = await authStorage!.forceRefreshCredentialById(idB);
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

		await authStorage.set("unit-oauth-cas-update-error", [
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
			authStorage.refreshStoredOAuthCredential("unit-oauth-cas-update-error", {
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

		await authStorage.set("unit-oauth-cas-disable-error", [
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
			authStorage.refreshStoredOAuthCredential("unit-oauth-cas-disable-error", {
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
		await authStorage.set("unit-oauth-lease-update", [
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
		const updateSpy = vi.spyOn(store, "tryUpdateAuthCredentialIfMatches");

		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-lease-update", {
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async credential => {
				// Keep the credential row bytes unchanged while expiring owner A's
				// lease. A non-lease-fenced final CAS would still persist this token.
				setSystemTime(new Date(now + 16_000));
				expect(stealLease(credentialId, "peer-owner", now + 31_000)).toBe(true);
				return {
					...credential,
					access: "access-from-lost-owner",
					refresh: "refresh-from-lost-owner",
					expires: now + 60 * 60_000,
				};
			},
		});

		expect(updateSpy).toHaveBeenCalled();
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
	});

	test("does not terminal-disable a credential when durable lease ownership is lost before CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T12:30:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.set("unit-oauth-lease-disable", [
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

		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-lease-disable", {
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
		await authStorage.set("unit-oauth-observed-mismatch-expired", [
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
		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-observed-mismatch-expired", {
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
		await authStorage.set("unit-oauth-observed-mismatch-fresh", [
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
		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-observed-mismatch-fresh", {
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

		await authStorage.set("unit-oauth-definitive-cas-loss", [
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
			authStorage.getApiKey("unit-oauth-definitive-cas-loss", "session-cas-loss", {
				signal: controller.signal,
			}),
		).resolves.toBeUndefined();
		expect(refreshCalls).toBe(1);
	});
});
