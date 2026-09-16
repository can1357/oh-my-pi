import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isAutomaticDisableCause,
	AuthStorage,
	type CredentialDisabledEvent,
	type AuthCredentialStore,
	type OAuthCredential,
	registerOAuthProvider,
	SqliteAuthCredentialStore,
	unregisterOAuthProviders,
	projectCredentialDisabledEvent,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AUTH_BROKER_CAPABILITIES_HEADER,
	AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES,
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
	const events: CredentialDisabledEvent[] = [];
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
		await refresh.text();
		const raw = await store.listDisabledCredentials();
		expect(raw[0]?.cause).toContain(echo);
		// In-process events keep the verbatim cause; the extension/SDK boundary
		// projects it (see the canary in `sdk-credential-disabled-bridge.test.ts`).
		expect(JSON.stringify(events)).toContain("diag-refresh-echo");
		expect(JSON.stringify(events.map(projectCredentialDisabledEvent))).not.toContain("diag-refresh-echo");
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
		// The forensic cause survives in the store, the authenticated broker
		// projection, and the event: those share the store's trust domain.
		expect(JSON.stringify({ local, remote })).toContain("diag-refresh-echo");
		// In-process events keep the verbatim cause; the projection applied at the
		// extension/SDK boundary is what withholds it.
		expect(JSON.stringify(events.map(projectCredentialDisabledEvent))).not.toContain("diag-refresh-echo");
		// The disable announcement this change adds carries only the classified
		// cause, so a provider echo never reaches ~/.omp/logs through it.
		const announcements = logs
			.flatMap(log => log.mock.calls)
			.filter(([message]) => message === "Auth credential disabled");
		expect(announcements.length).toBeGreaterThan(0);
		for (const secret of ["diag-refresh-echo", "diag-client-echo", "diag-disable-cause"])
			expect(JSON.stringify(announcements)).not.toContain(secret);
	} finally {
		for (const log of logs) log.mockRestore();
		await broker?.close();
		endpoint.stop(true);
		storage.close();
		await removeWithRetries(tempDir);
	}
});

function mintOAuth(email?: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
		accountId: email ? `account-${email}` : undefined,
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

	test("a login retains every unidentified tombstone", async () => {
		// Two accounts signed out without any recoverable identity (no email, no
		// account id, no identity key). Retention keeps an unidentified automatic
		// tombstone until explicit provider logout or expiry, so a single login
		// clears neither — it cannot prove which account it replaces.
		const anonymous = (access: string): OAuthCredential => ({
			type: "oauth",
			access,
			refresh: `refresh-${access}`,
			expires: Date.now() + 60_000,
		});
		store!.saveOAuth("anthropic", anonymous("first"));
		store!.saveOAuth("anthropic", anonymous("second"));
		const rows = store!.listAuthCredentials("anthropic");
		expect(rows).toHaveLength(2);
		for (const row of rows) store!.deleteAuthCredential(row.id, "oauth refresh failed: invalid_grant");
		expect(await store!.listDisabledCredentials("anthropic")).toHaveLength(2);

		// A fresh login writes one new credential.
		store!.saveOAuth("anthropic", mintOAuth("back@example.test"));

		const remaining = await store!.listDisabledCredentials("anthropic");
		expect(remaining.map(entry => entry.id).sort()).toEqual(rows.map(row => row.id).sort());
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

	test("current clients accept old disabled shapes but require per-call support before trusting empty history", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const provider = new URL(request.url).searchParams.get("provider");
				if (provider === "missing") {
					started.resolve();
					await release.promise;
					return new Response("not found", { status: 404 });
				}
				return Response.json({
					generatedAt: Date.now(),
					disabled:
						provider === "empty"
							? []
							: [
									{
										id: 1,
										provider: "anthropic",
										type: "oauth",
										email: "legacy@example.test",
										cause: "invalid_grant",
									},
								],
				});
			},
		});
		const client = new AuthBrokerClient({ url: broker.url.href, token: "unused", maxRetries: 0 });
		const remote = new AuthStorage(new RemoteAuthCredentialStore({ client, streamSnapshots: false }));
		try {
			expect(await remote.listDisabledCredentials("old", undefined, { requireSupported: true })).toMatchObject([
				{ id: 1, email: "legacy@example.test" },
			]);
			const unsupported = remote
				.listDisabledCredentials("missing", undefined, { requireSupported: true })
				.catch((error: unknown) => error);
			await started.promise;
			expect(await remote.listDisabledCredentials("empty", undefined, { requireSupported: true })).toEqual([]);
			release.resolve();
			expect(await unsupported).toMatchObject({ status: 404 });
			expect(await remote.listDisabledCredentials("missing")).toEqual([]);
			expect(await remote.listDisabledCredentials("empty", undefined, { requireSupported: true })).toEqual([]);
		} finally {
			release.resolve();
			remote.close();
			broker.stop(true);
		}
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

	test("legacy strict clients receive only their known disabled fields while current clients retain project scope", async () => {
		serverStore!.saveOAuth("google", {
			...mintOAuth("scoped@example.test"),
			projectId: "project-a",
			orgId: "org-a",
			orgName: "Team",
		});
		const row = serverStore!.listAuthCredentials("google")[0]!;
		serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);
		// Exact strict disabled response schema from source base 1091f70, before projectId.
		const legacySchema = type({
			"+": "reject",
			generatedAt: "number",
			disabled: type({
				"+": "reject",
				id: "number.integer",
				provider: type("string").atLeastLength(1),
				type: "'oauth' | 'api_key'",
				"email?": "string",
				"accountId?": "string",
				"orgId?": "string",
				"orgName?": "string",
				cause: "string",
				"disabledAtMs?": "number",
			}).array(),
		});
		for (const capabilities of ["", AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES]) {
			const response = await fetch(handle!.url + "/v1/credentials/disabled", {
				headers: { Authorization: "Bearer " + token, [AUTH_BROKER_CAPABILITIES_HEADER]: capabilities },
			});
			expect(response.status).toBe(200);
			const body: unknown = await response.json();
			const parsed = legacySchema(body);
			expect(parsed).not.toBeInstanceOf(type.errors);
			if (parsed instanceof type.errors) throw new Error(parsed.summary);
			expect(parsed.disabled).toMatchObject([{ id: row.id, orgId: "org-a", orgName: "Team" }]);
		}
		expect(
			await clientStorage!.listDisabledCredentials("google", undefined, { requireSupported: true }),
		).toMatchObject([{ id: row.id, projectId: "project-a" }]);
	});

	test("an unsupported backing store never becomes authoritative empty broker history", async () => {
		const source: AuthCredentialStore = serverStore!;
		source.listDisabledCredentials = undefined;
		expect(await serverStorage!.listDisabledCredentials()).toEqual([]);
		await expect(
			serverStorage!.listDisabledCredentials(undefined, undefined, { requireSupported: true }),
		).rejects.toThrow();
		await expect(
			clientStorage!.listDisabledCredentials(undefined, undefined, { requireSupported: true }),
		).rejects.toThrow();
	});

	test.each([true, false])("provider logout clears unidentified history with active account: %s", async active => {
		serverStore!.saveOAuth("anthropic", mintOAuth());
		const prior = serverStore!.listAuthCredentials("anthropic")[0]!;
		serverStore!.deleteAuthCredential(prior.id, DISABLE_CAUSE);
		serverStore!.saveOAuth("openai-codex", mintOAuth("peer-dead@example.test"));
		const peerPrior = serverStore!.listAuthCredentials("openai-codex")[0]!;
		serverStore!.deleteAuthCredential(peerPrior.id, DISABLE_CAUSE);
		serverStore!.saveOAuth("openai-codex", mintOAuth("peer-live@example.test"));
		if (active) serverStore!.saveOAuth("anthropic", mintOAuth("b@example.test"));
		await serverStorage!.reload();
		await clientStorage!.revalidateCredentials();
		const activeRows = serverStore!.listAuthCredentials("anthropic");
		const peerRows = serverStore!.listAuthCredentials("openai-codex");
		const peerHistory = await clientStorage!.listDisabledCredentials("openai-codex");
		expect((await clientStorage!.listDisabledCredentials("anthropic")).map(row => row.id)).toEqual([prior.id]);
		const serverEvents: CredentialDisabledEvent[] = [];
		const clientEvents: CredentialDisabledEvent[] = [];
		serverStorage!.onCredentialDisabled(event => {
			serverEvents.push(event);
		});
		clientStorage!.onCredentialDisabled(event => {
			clientEvents.push(event);
		});

		await clientStorage!.remove("anthropic");

		expect(clientStorage!.listStoredCredentials("anthropic")).toEqual([]);
		expect(serverStorage!.listStoredCredentials("anthropic")).toEqual([]);
		expect(serverStore!.listAuthCredentials("anthropic")).toEqual([]);
		expect(
			(await clientStorage!.listDisabledCredentials("anthropic")).map(row => ({ id: row.id, cause: row.cause })),
		).toEqual(activeRows.map(row => ({ id: row.id, cause: "deleted by user" })));
		expect(serverStore!.listAuthCredentials("openai-codex")).toEqual(peerRows);
		expect(await clientStorage!.listDisabledCredentials("openai-codex")).toEqual(peerHistory);
		const db = new Database(path.join(tempDir, "broker.db"), { readonly: true });
		try {
			expect(
				db.query("SELECT id, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id").all("anthropic"),
			).toEqual(activeRows.map(row => ({ id: row.id, disabled_cause: "deleted by user" })));
		} finally {
			db.close();
		}
		expect(serverEvents).toEqual([]);
		expect(clientEvents).toEqual([]);
	});

	test("removing one named account preserves unidentified automatic history", async () => {
		serverStore!.saveOAuth("anthropic", mintOAuth());
		const prior = serverStore!.listAuthCredentials("anthropic")[0]!;
		serverStore!.deleteAuthCredential(prior.id, DISABLE_CAUSE);
		serverStore!.saveOAuth("anthropic", mintOAuth("b@example.test"));
		await serverStorage!.reload();
		await clientStorage!.revalidateCredentials();
		const active = clientStorage!.listStoredCredentials("anthropic")[0]!;

		expect(await clientStorage!.removeCredential("anthropic", active.id)).toBe(true);

		expect(serverStore!.listAuthCredentials("anthropic")).toEqual([]);
		expect((await clientStorage!.listActionableDisabledCredentials("anthropic")).map(row => row.id)).toEqual([
			prior.id,
		]);
	});

	test("explicit remote account removal clears a peer tombstone and is idempotent", async () => {
		serverStore!.saveOAuth("anthropic", mintOAuth());
		const unrelated = serverStore!.listAuthCredentials("anthropic")[0]!;
		serverStore!.deleteAuthCredential(unrelated.id, DISABLE_CAUSE);
		serverStorage!.upsertCredential("anthropic", mintOAuth("selected@example.test"));
		await clientStorage!.revalidateCredentials();
		const selected = clientStorage!.listStoredCredentials("anthropic")[0]!;
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		await peer.disableCredential(selected.id, DISABLE_CAUSE);
		expect(clientStorage!.listStoredCredentials("anthropic").map(row => row.id)).toContain(selected.id);
		const db = new Database(path.join(tempDir, "broker.db"));
		try {
			db.run(`CREATE TRIGGER reject_selected_removal BEFORE DELETE ON auth_credentials
				WHEN OLD.id = ${selected.id} BEGIN SELECT RAISE(ABORT, 'removal rejected'); END`);
			await expect(clientStorage!.removeCredential("anthropic", selected.id)).rejects.toMatchObject({ status: 500 });
			expect(clientStorage!.listStoredCredentials("anthropic").map(row => row.id)).toContain(selected.id);
			expect(await serverStore!.listDisabledCredentials("anthropic")).toContainEqual(
				expect.objectContaining({ id: selected.id, cause: DISABLE_CAUSE }),
			);
			db.run("DROP TRIGGER reject_selected_removal");
		} finally {
			db.close();
		}
		expect(await clientStorage!.removeCredential("anthropic", selected.id)).toBe(true);
		expect(clientStorage!.listStoredCredentials("anthropic")).toEqual([]);
		expect((await serverStore!.listDisabledCredentials("anthropic")).map(row => row.id)).toEqual([unrelated.id]);
		expect((await clientStorage!.listActionableDisabledCredentials("anthropic")).map(row => row.id)).toEqual([
			unrelated.id,
		]);
		await expect(peer.disableCredential(selected.id, "deleted by user")).resolves.toEqual({ ok: true });
		await expect(peer.disableCredential(selected.id, DISABLE_CAUSE)).rejects.toMatchObject({ status: 404 });
	});

	test("remote tombstone removal cannot cross the client account pool", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("hidden@example.test"));
		const hidden = serverStore!.listAuthCredentials("anthropic")[0]!;
		const client = new AuthBrokerClient({ url: handle!.url, token });
		await client.disableCredential(hidden.id, DISABLE_CAUSE);
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		const restricted = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set<string>()]]),
		});
		try {
			expect(await restricted.deleteAuthCredentialRemote(hidden.id, "deleted by user")).toBe(false);
			expect(await serverStore!.listDisabledCredentials("anthropic")).toContainEqual(
				expect.objectContaining({ id: hidden.id, cause: DISABLE_CAUSE }),
			);
		} finally {
			restricted.close();
		}
	});

	test("a logout the client already lost from its snapshot reports complete, not skipped", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("departed@example.test"));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		const departed = snapshot.snapshot.credentials[0]!;
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: false,
		});
		try {
			// A peer logs the account out; the refresh drops it from this client's
			// snapshot and the deliberate removal leaves no tombstone behind.
			await client.disableCredential(departed.id, "deleted by user");
			await store.refreshSnapshot();
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			const db = new Database(path.join(tempDir, "broker.db"));
			try {
				db.run("DELETE FROM auth_credentials WHERE id = ?", [departed.id]);
			} finally {
				db.close();
			}
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);

			// The requested logout is already complete.
			expect(await store.deleteAuthCredentialRemote(departed.id, "deleted by user")).toBe(true);
			// An id this client never held stays refused.
			expect(await store.deleteAuthCredentialRemote(departed.id + 9_000, "deleted by user")).toBe(false);
		} finally {
			store.close();
		}
	});

	test("a streamed peer removal also makes the completed logout idempotent", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("streamed@example.test"));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		const departed = snapshot.snapshot.credentials[0]!;
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: true,
		});
		try {
			// The removal arrives as a stream `removed` frame, never as a diffed snapshot.
			await client.disableCredential(departed.id, "deleted by user");
			const deadline = Date.now() + 5_000;
			while (store.listAuthCredentials("anthropic").length > 0 && Date.now() < deadline) {
				await Bun.sleep(10);
			}
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			const db = new Database(path.join(tempDir, "broker.db"));
			try {
				db.run("DELETE FROM auth_credentials WHERE id = ?", [departed.id]);
			} finally {
				db.close();
			}
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
			expect(await store.deleteAuthCredentialRemote(departed.id, "deleted by user")).toBe(true);
		} finally {
			store.close();
		}
	});

	test("provider logout falls back to per-row removal on a broker without the route", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("b@example.test"));
		const upstreamUrl = handle!.url;
		const oldBroker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/provider/logout") return new Response("not found", { status: 404 });
				return fetch(new Request(`${upstreamUrl}${url.pathname}${url.search}`, req));
			},
		});
		const oldClient = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: oldBroker.url.href, token }),
				streamSnapshots: false,
			}),
		);
		try {
			await oldClient.revalidateCredentials();
			expect(oldClient.listStoredCredentials("anthropic").length).toBeGreaterThan(0);

			// Failing outright would leave a current client unable to log out at all
			// against a broker predating this route. Fall back to the per-credential
			// disable every broker has always supported.
			await oldClient.remove("anthropic");

			expect(oldClient.listStoredCredentials("anthropic")).toEqual([]);
			expect(serverStore!.listAuthCredentials("anthropic")).toEqual([]);
			// The degraded path soft-deletes instead of clearing history, but it
			// never fabricates an automatic cause — so nothing it leaves behind can
			// reach the "recently signed out" surface, which filters on exactly that.
			const residue = await serverStorage!.listDisabledCredentials("anthropic");
			expect(residue.map(entry => entry.cause)).toEqual(residue.map(() => "deleted by user"));
			expect(residue.some(entry => isAutomaticDisableCause(entry.cause))).toBe(false);
		} finally {
			oldClient.close();
			oldBroker.stop(true);
		}
	});

	test("the legacy logout fallback also removes an account the cached snapshot missed", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("known@example.test"));
		const upstreamUrl = handle!.url;
		const oldBroker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/provider/logout") return new Response("not found", { status: 404 });
				return fetch(new Request(`${upstreamUrl}${url.pathname}${url.search}`, req));
			},
		});
		const oldClient = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: oldBroker.url.href, token }),
				streamSnapshots: false,
			}),
		);
		try {
			await oldClient.revalidateCredentials();
			expect(oldClient.listStoredCredentials("anthropic")).toHaveLength(1);

			// A peer adds an account after this client's last read. Enumerating the
			// cached snapshot would leave it signed in while reporting success.
			serverStorage!.upsertCredential("anthropic", mintOAuth("unseen@example.test"));

			await oldClient.remove("anthropic");
			expect(serverStore!.listAuthCredentials("anthropic")).toEqual([]);
		} finally {
			oldClient.close();
			oldBroker.stop(true);
		}
	});

	test("a peer winning the legacy fallback race still reports the logout done", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("raced-out@example.test"));
		const upstreamUrl = handle!.url;
		let firstDisable = true;
		const oldBroker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/provider/logout") return new Response("not found", { status: 404 });
				if (url.pathname.endsWith("/disable") && firstDisable) {
					// A peer logs the same provider out first; this request loses.
					firstDisable = false;
					await serverStorage!.remove("anthropic");
					return new Response(JSON.stringify({ error: "gone" }), { status: 404 });
				}
				return fetch(new Request(`${upstreamUrl}${url.pathname}${url.search}`, req));
			},
		});
		const oldClient = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: oldBroker.url.href, token }),
				streamSnapshots: false,
			}),
		);
		try {
			await oldClient.revalidateCredentials();
			expect(oldClient.listStoredCredentials("anthropic").length).toBeGreaterThan(0);

			// The row is gone, which is what was asked for. Reporting a failure here
			// would tell the operator the logout failed for an empty provider.
			await oldClient.remove("anthropic");
			expect(serverStore!.listAuthCredentials("anthropic")).toEqual([]);
		} finally {
			oldClient.close();
			oldBroker.stop(true);
		}
	});

	test("a failed per-row disable in the fallback leaves the local snapshot intact", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("kept@example.test"));
		const upstreamUrl = handle!.url;
		const oldBroker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/provider/logout") return new Response("not found", { status: 404 });
				// The fallback route is reachable but refuses: authorization,
				// connectivity or a broker error mid-logout.
				if (url.pathname.endsWith("/disable")) return new Response("boom", { status: 500 });
				return fetch(new Request(`${upstreamUrl}${url.pathname}${url.search}`, req));
			},
		});
		const oldClient = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: oldBroker.url.href, token }),
				streamSnapshots: false,
			}),
		);
		try {
			await oldClient.revalidateCredentials();
			const before = oldClient.listStoredCredentials("anthropic");
			expect(before.length).toBeGreaterThan(0);

			// Reporting success here would clear the local snapshot while the broker
			// still holds the credential, and the next refresh would resurrect it.
			await expect(oldClient.remove("anthropic")).rejects.toMatchObject({ status: 500 });
			expect(oldClient.listStoredCredentials("anthropic")).toEqual(before);
			expect(serverStore!.listAuthCredentials("anthropic").map(row => row.id)).toEqual(before.map(row => row.id));
		} finally {
			oldClient.close();
			oldBroker.stop(true);
		}
	});

	test("provider logout requires bearer authorization and an explicit provider", async () => {
		serverStorage!.upsertCredential("anthropic", mintOAuth("b@example.test"));
		const before = serverStore!.listAuthCredentials();
		const unauthorized = new AuthBrokerClient({ url: handle!.url, token: "wrong-token" });
		await expect(unauthorized.logoutProvider("anthropic")).rejects.toMatchObject({ status: 401 });
		const invalid = await fetch(`${handle!.url}/v1/provider/logout`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "" }),
		});
		await invalid.arrayBuffer();
		expect(invalid.status).toBe(400);
		expect(serverStore!.listAuthCredentials()).toEqual(before);
	});

	test("provider logout propagates persistence failure without clearing history or snapshots", async () => {
		serverStore!.saveOAuth("anthropic", mintOAuth());
		const prior = serverStore!.listAuthCredentials("anthropic")[0]!;
		serverStore!.deleteAuthCredential(prior.id, DISABLE_CAUSE);
		serverStore!.saveOAuth("anthropic", mintOAuth("b@example.test"));
		await serverStorage!.reload();
		await clientStorage!.revalidateCredentials();
		const before = clientStorage!.listStoredCredentials("anthropic");
		const db = new Database(path.join(tempDir, "broker.db"));
		try {
			db.run(`CREATE TRIGGER reject_logout BEFORE UPDATE ON auth_credentials
				WHEN NEW.disabled_cause = 'deleted by user'
				BEGIN SELECT RAISE(ABORT, 'logout write rejected'); END`);

			await expect(clientStorage!.remove("anthropic")).rejects.toMatchObject({ status: 500 });

			expect(clientStorage!.listStoredCredentials("anthropic")).toEqual(before);
			expect(serverStorage!.listStoredCredentials("anthropic").map(row => row.id)).toEqual(
				before.map(row => row.id),
			);
			expect(serverStore!.listAuthCredentials("anthropic").map(row => row.id)).toEqual(before.map(row => row.id));
			expect((await clientStorage!.listDisabledCredentials("anthropic")).map(row => row.id)).toEqual([prior.id]);
		} finally {
			db.close();
		}
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

describe("broker history against a store without tombstones", () => {
	/**
	 * `requireSupported` exists so the broker never reports an authoritative
	 * empty history it cannot vouch for. The failure mode that matters is what
	 * the client does next: a store that simply has no tombstone table is a
	 * permanent capability gap, and answering `500` made the client's removal
	 * lookup retry it with backoff for the life of the process.
	 */
	test("answers 501 so the client latches it off instead of retrying", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-nohistory-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		// A store that legitimately omits the optional hook.
		(store as { listDisabledCredentials?: unknown }).listDisabledCredentials = undefined;
		const storage = new AuthStorage(store);
		await storage.reload();
		const token = "no-history-bearer";
		const handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const response = await fetch(`${handle.url}/v1/credentials/disabled`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(501);
			await response.text();

			const client = new AuthBrokerClient({ url: handle.url, token });
			// Default lookups treat it as "no history", exactly like a 404 from a
			// broker predating the endpoint.
			expect(await client.listDisabledCredentials()).toEqual([]);
			// A caller that needs authority still gets an error rather than a
			// silent empty list.
			await expect(
				client.listDisabledCredentials(undefined, undefined, { requireSupported: true }),
			).rejects.toThrow();
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
