import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type OAuthCredential,
	registerOAuthProvider,
	SqliteAuthCredentialStore,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const DISABLE_CAUSE =
	'oauth refresh failed: OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}';

function mintOAuth(email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
		accountId: `account-${email}`,
	};
}

describe("disabled credential tombstones", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-disabled-creds-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		storage?.close();
		await removeWithRetries(tempDir);
	});

	test("sqlite store lists identity + cause + disabledAtMs and never token material", async () => {
		store!.saveOAuth("anthropic", mintOAuth("dead@example.test"));
		store!.saveOAuth("openai-codex", mintOAuth("alive@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		store!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const all = await storage!.listDisabledCredentials();
		expect(all).toHaveLength(1);
		const summary = all[0];
		expect(summary).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "dead@example.test",
			accountId: "account-dead@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(typeof summary.disabledAtMs).toBe("number");
		// Tombstones are display-only: no token bytes may leak through them.
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("access-dead");
		expect(serialized).not.toContain("refresh-dead");

		// Provider filter is exact; a provider with only active rows yields [].
		expect(await storage!.listDisabledCredentials("anthropic")).toHaveLength(1);
		expect(await storage!.listDisabledCredentials("openai-codex")).toHaveLength(0);
	});

	test("client maps a broker without the endpoint (404) to an empty list", async () => {
		const fetchImpl: typeof fetch = Object.assign(async () => new Response("not found", { status: 404 }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		expect(await client.listDisabledCredentials()).toEqual([]);
	});
});

describe("broker /v1/credentials/disabled round-trip", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "disabled-creds-bearer";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-disabled-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		clientStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: handle.url, token }),
				streamSnapshots: false,
			}),
		);
		await clientStorage.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		await removeWithRetries(tempDir);
	});

	test("a row disabled on the broker surfaces to remote clients as a tombstone", async () => {
		serverStore!.saveOAuth("anthropic", mintOAuth("gone@example.test"));
		const row = serverStore!.listAuthCredentials("anthropic")[0];
		serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const disabled = await clientStorage!.listDisabledCredentials("anthropic");
		expect(disabled).toHaveLength(1);
		expect(disabled[0]).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "gone@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(JSON.stringify(disabled[0])).not.toContain("refresh-gone");
	});

	test("revalidateCredentials re-hydrates broker-side identity changes past a stale snapshot", async () => {
		// Client connected before this credential existed (e.g. a re-login that
		// swapped an org-less row for an org-scoped one while a disk-cached
		// snapshot was still fresh).
		serverStore!.saveOAuth("anthropic", { ...mintOAuth("late@example.test"), orgId: "org-late" });
		await clientStorage!.revalidateCredentials();
		const rows = clientStorage!.getAll().anthropic;
		const list = Array.isArray(rows) ? rows : [rows];
		const late = list.find(entry => entry?.type === "oauth" && entry.email === "late@example.test");
		if (late?.type !== "oauth") throw new Error("expected refreshed oauth credential");
		expect(late.orgId).toBe("org-late");
	});
});

describe("OAuth login stamps authorizedAt", () => {
	const PROVIDER_ID = "test-authorized-at-oauth";
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-authorized-at-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "AuthorizedAt Test",
			sourceId: "authorized-at-test",
			login: async () => ({
				refresh: "refresh-initial",
				access: "access-initial",
				expires: Date.now() + 60_000,
				email: "stamped@example.test",
			}),
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders("authorized-at-test");
		storage?.close();
		await removeWithRetries(tempDir);
	});

	test("login records the interactive-login instant; refresh persists keep it while rotating tokens", async () => {
		const before = Date.now();
		await storage!.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		const stored = store!.listAuthCredentials(PROVIDER_ID)[0];
		if (stored.credential.type !== "oauth") throw new Error("expected oauth credential");
		const authorizedAt = stored.credential.authorizedAt;
		expect(typeof authorizedAt).toBe("number");
		expect(authorizedAt!).toBeGreaterThanOrEqual(before);
		expect(authorizedAt!).toBeLessThanOrEqual(Date.now());

		// Refresh rotates tokens but must not touch the login anchor — the
		// rebuild in refreshCredentialById previously dropped unknown fields.
		const refreshingStorage = new AuthStorage(store!, {
			refreshOAuthCredential: async () => ({
				access: "access-rotated",
				refresh: "refresh-rotated",
				expires: Date.now() + 120_000,
			}),
		});
		try {
			await refreshingStorage.reload();
			await refreshingStorage.forceRefreshCredentialById(stored.id);
			const after = store!.listAuthCredentials(PROVIDER_ID)[0];
			if (after.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(after.credential.refresh).toBe("refresh-rotated");
			expect(after.credential.authorizedAt).toBe(authorizedAt);
		} finally {
			refreshingStorage.close();
		}
	});
});
