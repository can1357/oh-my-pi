import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
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
	AuthBrokerCredentialDeleteUnsupportedError,
	AuthBrokerError,
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
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage?.close();
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("sqlite store lists identity + cause + disabledAtMs and never token material", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("dead@example.test"));
		await store!.saveOAuth("openai-codex", mintOAuth("alive@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		await store!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const all = await storage!.credentials.listDisabled();
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
		expect(await storage!.credentials.listDisabled("anthropic")).toHaveLength(1);
		expect(await storage!.credentials.listDisabled("openai-codex")).toHaveLength(0);
	});

	test("sqlite disable returns false for missing or already-disabled rows without overwriting the tombstone", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("once@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		expect(await store!.deleteAuthCredential(row.id + 1, "missing")).toBe(false);
		expect(await store!.deleteAuthCredential(row.id, "original cause")).toBe(true);
		expect(await store!.deleteAuthCredential(row.id, "later cause")).toBe(false);
		expect((await store!.listDisabledCredentials("anthropic"))[0]?.cause).toBe("original cause");
	});

	test("removeById permanently removes a disabled identity without refreshing or probing it", async () => {
		const provider = "test-logout-account";
		const refresh = vi.fn(async () => {
			throw new Error("unexpected OAuth refresh");
		});
		const fetchUsage = vi.fn(async () => {
			throw new Error("unexpected account authentication");
		});
		const guardedStorage = new AuthStorage(store!, { refreshOAuthCredential: refresh });
		guardedStorage.usage.setProvider(provider, {
			id: provider,
			supports: () => true,
			fetchUsage,
		});
		await store!.saveOAuth(provider, {
			...mintOAuth("disabled@example.test"),
			expires: 0,
			projectId: "project-disabled",
		});
		const row = store!.listAuthCredentials(provider)[0]!;
		expect(await store!.deleteAuthCredential(row.id, DISABLE_CAUSE)).toBe(true);
		await guardedStorage.credentials.reload();
		expect(await guardedStorage.credentials.listDisabled(provider)).toEqual([
			expect.objectContaining({ id: row.id, projectId: "project-disabled", cause: DISABLE_CAUSE }),
		]);

		expect(await guardedStorage.credentials.removeById(`${provider}-other`, row.id)).toBe(false);
		expect(await guardedStorage.credentials.removeById(provider, Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(await guardedStorage.credentials.removeById(provider, row.id)).toBe(true);
		expect(await guardedStorage.credentials.listDisabled(provider)).toEqual([]);
		expect(await guardedStorage.credentials.removeById(provider, row.id)).toBe(false);
		expect(guardedStorage.credentials.list(provider)).toEqual([]);
		expect(await guardedStorage.usage.reports()).toEqual([]);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetchUsage).not.toHaveBeenCalled();
		guardedStorage.close();
	});

	test("client maps a broker without the endpoint (404) to an empty list", async () => {
		const fetchImpl: typeof fetch = Object.assign(async () => new Response("not found", { status: 404 }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		expect(await client.listDisabledCredentials()).toEqual([]);
	});
});

describe("broker permanent deletion compatibility", () => {
	test.each([404, 405, 501])("status %s requires upgrading without disabling instead", async status => {
		const requests: Array<{ method: string | undefined; path: string }> = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				requests.push({ method: init?.method, path: new URL(url).pathname });
				return Response.json({ error: "secret-old-broker-details" }, { status });
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		const deletion = client.deleteCredential(42);
		await expect(deletion).rejects.toBeInstanceOf(AuthBrokerCredentialDeleteUnsupportedError);
		await expect(deletion).rejects.toMatchObject({
			status,
			body: undefined,
		});
		await expect(deletion).rejects.toThrow(/does not support permanent credential deletion.*Update the broker/);
		expect(requests).toEqual([{ method: "DELETE", path: "/v1/credential/42" }]);
	});

	test("a validated matching coded missing response returns false", async () => {
		const fetchImpl: typeof fetch = Object.assign(
			async () =>
				Response.json({ error: "No credential with id=42", code: "credential_not_found", id: 42 }, { status: 404 }),
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		expect(await client.deleteCredential(42)).toEqual({ ok: false });
	});

	test.each([
		"not found",
		JSON.stringify({ error: "missing", code: "credential_not_found", id: 43 }),
		JSON.stringify({ error: "missing", code: "credential_not_found", id: "42" }),
		JSON.stringify({ code: "credential_not_found", id: 42 }),
		JSON.stringify({ error: "missing", code: "credential_not_found", id: 42, extra: true }),
	])("unvalidated or mismatched 404 body does not confirm missing: %s", async body => {
		const fetchImpl: typeof fetch = Object.assign(async () => new Response(body, { status: 404 }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		await expect(client.deleteCredential(42)).rejects.toBeInstanceOf(AuthBrokerCredentialDeleteUnsupportedError);
	});

	test("storage errors stay distinct from unsupported permanent deletion", async () => {
		const fetchImpl: typeof fetch = Object.assign(
			async () => Response.json({ error: "Failed to permanently delete credential" }, { status: 500 }),
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		const deletion = client.deleteCredential(42);
		await expect(deletion).rejects.toBeInstanceOf(AuthBrokerError);
		await expect(deletion).rejects.not.toBeInstanceOf(AuthBrokerCredentialDeleteUnsupportedError);
		await expect(deletion).rejects.toMatchObject({ status: 500 });
	});

	test("invalid successful delete responses reject instead of reporting persisted success", async () => {
		const fetchImpl: typeof fetch = Object.assign(async () => Response.json({ ok: "true" }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		await expect(client.deleteCredential(42)).rejects.toMatchObject({
			name: "AuthBrokerError",
			message: "Auth broker response failed schema validation",
			status: 200,
		});
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
		await serverStorage.credentials.reload();
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
		await clientStorage.credentials.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("a row disabled on the broker surfaces to remote clients as a tombstone", async () => {
		await serverStore!.saveOAuth("anthropic", mintOAuth("gone@example.test"));
		const row = serverStore!.listAuthCredentials("anthropic")[0];
		await serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const disabled = await clientStorage!.credentials.listDisabled("anthropic");
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

	test.each(["arbitrary manual reason", "deleted by user"])(
		"POST disable retains a tombstone for cause %s",
		async cause => {
			await serverStorage!.credentials.set("test-logout-account", mintOAuth("disabled@example.test"));
			const row = serverStorage!.credentials.list("test-logout-account")[0]!;
			const client = new AuthBrokerClient({ url: handle!.url, token });
			expect(await client.disableCredential(row.id, cause)).toEqual({ ok: true });
			expect(serverStore!.listAuthCredentials("test-logout-account")).toEqual([]);
			expect(await client.listDisabledCredentials("test-logout-account")).toEqual([
				expect.objectContaining({ id: row.id, cause, email: "disabled@example.test" }),
			]);
		},
	);

	test("DELETE removes active and disabled rows and reports a coded missing id", async () => {
		await serverStorage!.credentials.set("test-logout-account", [
			mintOAuth("active@example.test"),
			mintOAuth("disabled@example.test"),
			mintOAuth("sibling@example.test"),
		]);
		const [active, disabled, sibling] = serverStorage!.credentials.list("test-logout-account");
		const client = new AuthBrokerClient({ url: handle!.url, token });
		expect(await client.disableCredential(disabled.id, DISABLE_CAUSE)).toEqual({ ok: true });
		for (const row of [active, disabled]) {
			const response = await fetch(`${handle!.url}/v1/credential/${row.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
		}
		expect(serverStore!.listAuthCredentials("test-logout-account")).toEqual([sibling]);
		expect(await client.listDisabledCredentials("test-logout-account")).toEqual([]);
		const response = await fetch(`${handle!.url}/v1/credential/${active.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: `No credential with id=${active.id}`,
			code: "credential_not_found",
			id: active.id,
		});
		expect(await client.deleteCredential(active.id)).toEqual({ ok: false });
	});

	test("remote hard deletion uses DELETE only, while legacy deletion remains POST disable", async () => {
		await serverStorage!.credentials.set("test-logout-account", [
			mintOAuth("remove@example.test"),
			mintOAuth("disable@example.test"),
		]);
		const mutations: Array<{ method: string; path: string; body: string | undefined }> = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (init?.method === "POST" || init?.method === "DELETE") {
					mutations.push({
						method: init.method,
						path: new URL(url).pathname,
						body: typeof init.body === "string" ? init.body : undefined,
					});
				}
				return fetch(input, init);
			},
			{ preconnect: fetch.preconnect },
		);
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token, fetchImpl }),
			streamSnapshots: false,
		});
		try {
			await remote.refreshSnapshot();
			const [removed, disabled] = remote.listAuthCredentials("test-logout-account");
			expect(await remote.hardDeleteAuthCredential(removed.id)).toBe(true);
			expect(remote.listAuthCredentials("test-logout-account")).toEqual([disabled]);
			expect(await remote.deleteAuthCredential(disabled.id, "deleted by user")).toBe(true);
			expect(remote.listAuthCredentials("test-logout-account")).toEqual([]);
			expect(mutations).toEqual([
				{ method: "DELETE", path: `/v1/credential/${removed.id}`, body: undefined },
				{
					method: "POST",
					path: `/v1/credential/${disabled.id}/disable`,
					body: JSON.stringify({ cause: "deleted by user" }),
				},
			]);
			expect(await remote.listDisabledCredentials("test-logout-account")).toEqual([
				expect.objectContaining({ id: disabled.id, cause: "deleted by user" }),
			]);
		} finally {
			remote.close();
		}
	});

	test("remote removal hard-deletes exactly one active row and preserves its sibling", async () => {
		await serverStorage!.credentials.set("test-logout-account", [
			mintOAuth("first@example.test"),
			mintOAuth("sibling@example.test"),
		]);
		await clientStorage!.credentials.revalidate();
		const [target, sibling] = clientStorage!.credentials.list("test-logout-account");
		expect(await clientStorage!.credentials.removeById("test-logout-account-other", target.id)).toBe(false);
		expect(await clientStorage!.credentials.removeById("test-logout-account", target.id)).toBe(true);
		expect(clientStorage!.credentials.list("test-logout-account")).toEqual([sibling]);
		expect(serverStore!.listAuthCredentials("test-logout-account").map(entry => entry.id)).toEqual([sibling.id]);
		expect(await clientStorage!.credentials.listDisabled("test-logout-account")).toEqual([]);
		expect(await clientStorage!.credentials.removeById("test-logout-account", target.id)).toBe(false);
	});

	test("remote removal deletes tombstones with no OAuth refresh or account authentication", async () => {
		const provider = "test-logout-account";
		const refresh = vi.fn(async () => {
			throw new Error("unexpected OAuth refresh");
		});
		const fetchUsage = vi.fn(async () => {
			throw new Error("unexpected account authentication");
		});
		vi.spyOn(serverStorage!.oauth, "refresh").mockImplementation(refresh);
		serverStorage!.usage.setProvider(provider, { id: provider, supports: () => true, fetchUsage });
		await serverStore!.saveOAuth(provider, {
			...mintOAuth("expired@example.test"),
			expires: 0,
			projectId: "project-remote",
		});
		const row = serverStore!.listAuthCredentials(provider)[0]!;
		await serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);
		// The tombstone never existed in either in-memory active pool.
		expect(clientStorage!.credentials.list(provider)).toEqual([]);
		expect(await clientStorage!.credentials.listDisabled(provider)).toEqual([
			expect.objectContaining({ id: row.id, projectId: "project-remote" }),
		]);
		expect(await clientStorage!.credentials.removeById(`${provider}-other`, row.id)).toBe(false);
		expect(await clientStorage!.credentials.removeById(provider, row.id)).toBe(true);
		expect(await serverStorage!.credentials.listDisabled(provider)).toEqual([]);
		expect(await clientStorage!.credentials.listDisabled(provider)).toEqual([]);
		expect(await clientStorage!.usage.reports()).toEqual([]);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetchUsage).not.toHaveBeenCalled();

		const client = new AuthBrokerClient({ url: handle!.url, token });
		expect(await client.deleteCredential(row.id)).toEqual({ ok: false });
	});

	test("concurrent removal preserves confirmed delete-miss and legacy disable-error contracts", async () => {
		await serverStorage!.credentials.set("test-logout-account", mintOAuth("raced@example.test"));
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
			// Keep the stale snapshot until the explicit operations observe the race.
			backgroundIdleMs: 0,
			streamSnapshots: false,
		});
		try {
			await remote.refreshSnapshot();
			const row = remote.listAuthCredentials("test-logout-account")[0]!;
			expect(await serverStorage!.credentials.removeById(row.provider, row.id)).toBe(true);
			expect(await remote.hardDeleteAuthCredential(row.id)).toBe(false);
			await expect(remote.deleteAuthCredential(row.id, "deleted by user")).rejects.toMatchObject({ status: 404 });
			expect(remote.listAuthCredentials("test-logout-account")).toEqual([row]);
		} finally {
			remote.close();
		}
	});

	test("remote permanent removal surfaces safe storage failures and preserves snapshots", async () => {
		await serverStorage!.credentials.set("test-logout-account", mintOAuth("kept@example.test"));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		const failureDb = new Database(path.join(tempDir, "broker.db"));
		try {
			await remote.refreshSnapshot();
			const row = remote.listAuthCredentials("test-logout-account")[0]!;
			const serverBefore = serverStorage!.credentials.list("test-logout-account");
			failureDb.run(`
				CREATE TRIGGER reject_credential_delete BEFORE DELETE ON auth_credentials
				BEGIN SELECT RAISE(ABORT, 'secret-refresh-token-storage-failure'); END;
			`);
			const deletion = remote.hardDeleteAuthCredential(row.id);
			await expect(deletion).rejects.toBeInstanceOf(AuthBrokerError);
			await expect(deletion).rejects.toMatchObject({
				status: 500,
				body: JSON.stringify({ error: "Failed to permanently delete credential" }),
			});
			expect(remote.listAuthCredentials("test-logout-account")).toEqual([row]);
			expect(serverStorage!.credentials.list("test-logout-account")).toEqual(serverBefore);
			expect(serverStore!.listAuthCredentials("test-logout-account")).toEqual(serverBefore);
			expect(await serverStore!.listDisabledCredentials("test-logout-account")).toEqual([]);
		} finally {
			failureDb.run("DROP TRIGGER IF EXISTS reject_credential_delete");
			failureDb.close();
			remote.close();
		}
	});

	test("revalidateCredentials re-hydrates broker-side identity changes past a stale snapshot", async () => {
		// Client connected before this credential existed (e.g. a re-login that
		// swapped an org-less row for an org-scoped one while a disk-cached
		// snapshot was still fresh).
		await serverStore!.saveOAuth("anthropic", { ...mintOAuth("late@example.test"), orgId: "org-late" });
		await clientStorage!.credentials.revalidate();
		const rows = clientStorage!.credentials.all().anthropic;
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
		await storage.credentials.reload();
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
		await storage!.oauth.login(PROVIDER_ID, {
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
			await refreshingStorage.credentials.reload();
			await refreshingStorage.oauth.refresh(stored.id);
			const after = store!.listAuthCredentials(PROVIDER_ID)[0];
			if (after.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(after.credential.refresh).toBe("refresh-rotated");
			expect(after.credential.authorizedAt).toBe(authorizedAt);
		} finally {
			refreshingStorage.close();
		}
	});
});
