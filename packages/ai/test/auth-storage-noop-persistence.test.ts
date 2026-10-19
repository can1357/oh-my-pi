import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-noop-persist-oauth";
const SOURCE = "auth-storage-noop-persistence-test";
const STICKY_KEY_PREFIX = `session:sticky:${PROVIDER}:`;

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

describe("AuthStorage skips no-op agent.db writes", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;
	let minted = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-noop-persist-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		minted = 0;
		registerOAuthProvider({
			id: PROVIDER,
			name: "No-op Persist Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				minted += 1;
				return { ...credentials, access: `minted-${minted}`, refresh: `refresh-${minted}`, expires: farExpiry() };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Reads the cross-process change counter and the row's write stamp through a separate connection. */
	function readPersistedState(id: number): { revision: number; updatedAt: number; data: string } {
		const db = new Database(dbPath, { readonly: true });
		try {
			const revision = db.query<{ revision: number }, []>("SELECT revision FROM auth_change_revision").get();
			const row = db
				.query<{ updated_at: number; data: string }, [number]>(
					"SELECT updated_at, data FROM auth_credentials WHERE id = ?",
				)
				.get(id);
			if (!revision || !row) throw new Error("expected persisted credential state");
			return { revision: revision.revision, updatedAt: row.updated_at, data: row.data };
		} finally {
			db.close();
		}
	}

	test("resolving an unchanged token leaves the credential row and revision untouched; a real refresh bumps both", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "cached-access",
			refresh: "cached-refresh",
			expires: farExpiry(),
		});
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected stored OAuth row");
		// Backdate the write stamp so a same-second rewrite is still observable.
		const writer = new Database(dbPath);
		try {
			writer.run("UPDATE auth_credentials SET updated_at = 1 WHERE id = ?", [row.id]);
		} finally {
			writer.close();
		}
		await authStorage.credentials.reload();
		const before = readPersistedState(row.id);

		expect(await authStorage.keys.get(PROVIDER, "session-a")).toBe("cached-access");
		expect(await authStorage.keys.get(PROVIDER, "session-b")).toBe("cached-access");
		expect(minted).toBe(0);
		expect(readPersistedState(row.id)).toEqual(before);

		expect(await authStorage.keys.get(PROVIDER, "session-c", { forceRefresh: true })).toBe("minted-1");
		const after = readPersistedState(row.id);
		expect(after.revision).toBeGreaterThan(before.revision);
		expect(after.updatedAt).toBeGreaterThan(1);
		expect(JSON.parse(after.data)).toMatchObject({ access: "minted-1", refresh: "refresh-1" });
	});

	test("repeated requests in one session rewrite the persisted sticky only after the persist window", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "cached-access",
			refresh: "cached-refresh",
			expires: farExpiry(),
		});
		const sessionId = "sticky-session";
		const persistedLastUsed = (): unknown => {
			const raw = store?.getCache(`${STICKY_KEY_PREFIX}${sessionId}`);
			return raw ? JSON.parse(raw).lastUsedAtMs : undefined;
		};

		const t0 = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		await authStorage.keys.get(PROVIDER, sessionId);
		expect(persistedLastUsed()).toBe(t0);

		now.mockReturnValue(t0 + 30_000);
		await authStorage.keys.get(PROVIDER, sessionId);
		expect(persistedLastUsed()).toBe(t0);
		// Routing still sees the exact last use; only the persisted copy lags.
		expect(authStorage.oauth.accounts(PROVIDER, sessionId).find(account => account.active)?.lastUsedAtMs).toBe(
			t0 + 30_000,
		);

		now.mockReturnValue(t0 + 61_000);
		await authStorage.keys.get(PROVIDER, sessionId);
		expect(persistedLastUsed()).toBe(t0 + 61_000);
	});

	test("selection with recordAffinity false persists no sticky for OAuth or API-key credentials", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const apiKeyProvider = "unit-noop-persist-key";
		await authStorage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "cached-access",
			refresh: "cached-refresh",
			expires: farExpiry(),
		});
		await authStorage.credentials.set(apiKeyProvider, { type: "api_key", key: "stored-key" });

		expect(await authStorage.keys.get(PROVIDER, "probe", { recordAffinity: false })).toBe("cached-access");
		expect(await authStorage.keys.get(apiKeyProvider, "probe", { recordAffinity: false })).toBe("stored-key");
		expect(store.getCache(`${STICKY_KEY_PREFIX}probe`)).toBeNull();
		expect(store.getCache(`session:sticky:${apiKeyProvider}:probe`)).toBeNull();
	});
});
