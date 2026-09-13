import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
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

test("broker refresh and disable diagnostics withhold provider echoes while forensic causes and events remain raw", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-diagnostic-"));
	const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
	const echo = JSON.stringify({
		error: "invalid_grant",
		refresh_token: "diag-refresh-echo",
		client_secret: "diag-client-echo",
		error_description: "grant revoked",
	});
	const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(echo, { status: 400 }) });
	const logs = ["info", "warn", "debug", "error"].map(level =>
		spyOn(logger, level as "warn").mockImplementation(() => {}),
	);
	const storage = new AuthStorage(store, {
		refreshOAuthCredential: async () => {
			const response = await fetch(`http://127.0.0.1:${endpoint.port}/token`);
			throw new Error(`OAuth refresh failed: HTTP ${response.status} ${await response.text()}`);
		},
	});
	const events: unknown[] = [];
	storage.onCredentialDisabled(event => {
		events.push(event);
	});
	let broker: AuthBrokerServerHandle | undefined;
	try {
		store.saveOAuth("anthropic", { ...mintOAuth("forensic@example.test"), expires: 0 });
		const row = store.listAuthCredentials("anthropic")[0];
		await storage.reload();
		broker = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: ["diag-broker-auth"],
			disableRefresher: true,
		});
		const headers = { Authorization: "Bearer diag-broker-auth", "Content-Type": "application/json" };
		const refresh = await fetch(`${broker.url}/v1/credential/${row.id}/refresh`, { method: "POST", headers });
		expect(refresh.status).toBe(500);
		const response = await refresh.text();
		const raw = await store.listDisabledCredentials();
		expect(raw[0]?.cause).toContain(echo);
		expect(JSON.stringify(events)).toContain("diag-refresh-echo");
		const local = await storage.listDisabledCredentials();
		const remote = await (await fetch(`${broker.url}/v1/credentials/disabled`, { headers })).text();
		storage.upsertCredential("manual-provider", { type: "api_key", key: "diag-manual-key" });
		const manual = store.listAuthCredentials("manual-provider")[0];
		const cause = "manual client_secret=diag-disable-cause";
		for (const id of [manual.id, 999999]) {
			const disabled = await fetch(`${broker.url}/v1/credential/${id}/disable`, {
				method: "POST",
				headers,
				body: JSON.stringify({ cause }),
			});
			expect(disabled.status).toBe(id === manual.id ? 200 : 404);
		}
		expect((await store.listDisabledCredentials("manual-provider"))[0]?.cause).toBe(cause);
		const diagnostics = JSON.stringify({ response, local, remote, logs: logs.flatMap(log => log.mock.calls) });
		for (const secret of ["diag-refresh-echo", "diag-client-echo", "diag-disable-cause"])
			expect(diagnostics).not.toContain(secret);
	} finally {
		for (const log of logs) log.mockRestore();
		await broker?.close();
		endpoint.stop(true);
		storage.close();
		await removeWithRetries(tempDir);
	}
});

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
