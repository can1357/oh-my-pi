import { afterEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";

/**
 * A session that is already running must see credentials another process
 * committed. `omp auth` in a second terminal writes to the shared SQLite store;
 * without a reload the running session ranks a stale in-memory pool for its
 * whole lifetime, so rotation reports "no usable sibling" while a freshly added
 * account sits unblocked in the database and the turn degrades to the fallback
 * chain instead of switching accounts.
 */
function oauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${id}`,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

interface ExternalStore {
	store: AuthCredentialStore;
	/** Simulates another process committing a credential row. */
	commitExternally: (row: StoredAuthCredential) => void;
	/** Simulates another process deleting a credential row. */
	removeExternally: (id: number) => void;
	/** Blocks written through the store, keyed `credentialId:blockScope`. */
	blocks: Map<string, number>;
}

function makeExternallyMutableStore(rows: StoredAuthCredential[]): ExternalStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	let externalCommitPending = false;
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCredentialBlock: (credentialId: number, _providerKey: string, blockScope: string) =>
			blocks.get(`${credentialId}:${blockScope}`),
		upsertCredentialBlock: block => {
			blocks.set(`${block.credentialId}:${block.blockScope}`, block.blockedUntilMs);
		},
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
		// Mirrors SqliteAuthCredentialStore: true exactly once per external commit.
		pollExternalChanges: () => {
			if (!externalCommitPending) return false;
			externalCommitPending = false;
			return true;
		},
		acknowledgeLocalChanges() {},
	};
	return {
		store,
		blocks,
		commitExternally: row => {
			rows.push(row);
			externalCommitPending = true;
		},
		removeExternally: id => {
			const at = rows.findIndex(row => row.id === id);
			if (at >= 0) rows.splice(at, 1);
			externalCommitPending = true;
		},
	};
}

describe("credential pool visibility across processes", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("rotates onto an account another process added mid-session", async () => {
		const rows = [oauthRow(1)];
		const { store, commitExternally } = makeExternallyMutableStore(rows);
		const storage = new AuthStorage(store, { configValueResolver: async value => value });
		storages.push(storage);
		await storage.reload();

		// Rotation attributes the failure to the session's pinned credential, so
		// establish the pin the way a real turn does.
		expect(await storage.getApiKey("anthropic", "session-1")).toBe("access-1");

		const usageLimitError = Object.assign(new Error("429 usage limit reached"), { status: 429 });

		// Sole account is spent: nothing to rotate onto.
		expect(await storage.rotateSessionCredential("anthropic", "session-1", { error: usageLimitError })).toBe(false);

		commitExternally(oauthRow(2));

		// The new account is usable, so the same session must switch to it rather
		// than report the provider exhausted.
		expect(await storage.rotateSessionCredential("anthropic", "session-1", { error: usageLimitError })).toBe(true);
		expect(await storage.getApiKey("anthropic", "session-1")).toBe("access-2");
	});

	it("selects an account another process added, with no rotation in between", async () => {
		const rows: StoredAuthCredential[] = [];
		const { store, commitExternally } = makeExternallyMutableStore(rows);
		const storage = new AuthStorage(store, { configValueResolver: async value => value });
		storages.push(storage);
		await storage.reload();

		// A session that started before any account existed.
		expect(await storage.getApiKey("anthropic", "session-1")).toBeUndefined();

		commitExternally(oauthRow(1));

		// Selection alone must see the new row: no usage-limit error, no rotation.
		expect(await storage.getApiKey("anthropic", "session-1")).toBe("access-1");
	});

	it("resolves OAuth access for an account another process added", async () => {
		const rows: StoredAuthCredential[] = [];
		const { store, commitExternally } = makeExternallyMutableStore(rows);
		const storage = new AuthStorage(store, { configValueResolver: async value => value });
		storages.push(storage);
		await storage.reload();

		// `withOAuthAccess` consumers start here rather than at `getApiKey`.
		expect(await storage.getOAuthAccess("anthropic", "session-1")).toBeUndefined();

		commitExternally(oauthRow(1));

		const resolved = await storage.getOAuthAccess("anthropic", "session-1");
		expect(resolved?.accessToken).toBe("access-1");
	});

	it("does not reload when no other process committed", async () => {
		const rows = [oauthRow(1), oauthRow(2)];
		const { store } = makeExternallyMutableStore(rows);
		let listCalls = 0;
		const listAuthCredentials = store.listAuthCredentials;
		store.listAuthCredentials = provider => {
			listCalls += 1;
			return listAuthCredentials(provider);
		};
		const storage = new AuthStorage(store, { configValueResolver: async value => value });
		storages.push(storage);
		await storage.reload();
		const afterInitialLoad = listCalls;

		const usageLimitError = Object.assign(new Error("429 usage limit reached"), { status: 429 });
		await storage.rotateSessionCredential("anthropic", "session-1", { error: usageLimitError });

		// An unchanged store is a `PRAGMA data_version` read, never a re-list.
		expect(listCalls).toBe(afterInitialLoad);
	});

	it("does not blame a sibling when another process deletes the pinned account", async () => {
		const rows = [oauthRow(1), oauthRow(2)];
		const { store, removeExternally, blocks } = makeExternallyMutableStore(rows);
		const storage = new AuthStorage(store, { configValueResolver: async value => value });
		storages.push(storage);
		await storage.reload();

		// Pin the session to the first row, the way a real turn does.
		expect(await storage.getApiKey("anthropic", "session-1")).toBe("access-1");

		// The pool is an index-ordered snapshot, so deleting the pinned row moves
		// the sibling into its slot.
		removeExternally(1);

		const usageLimitError = Object.assign(new Error("429 usage limit reached"), { status: 429 });
		const switched = await storage.rotateSessionCredential("anthropic", "session-1", { error: usageLimitError });

		// The failure belongs to an account that is gone; the sibling that took
		// index 0 must not be blocked for it.
		expect(switched).toBe(false);
		expect([...blocks.keys()].filter(key => key.startsWith("2:"))).toEqual([]);
	});
});
