import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type CredentialDisabledEvent,
	isActionableCredentialDisable,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	discoverAuthStorage,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clientStorage?.close();
		clientStorage = undefined;
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("authoritative org-scope adoption rechecks a stale same-account plan report", async () => {
		if (!storage || !store || !handle) throw new Error("test setup failed");
		const credential = {
			type: "oauth" as const,
			access: "orgless-access",
			refresh: "orgless-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "same-account",
		};
		await storage.set("openai-codex", credential);
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token }),
		});
		await remote.refreshSnapshot();
		clientStorage = new AuthStorage(remote);
		await clientStorage.reload();
		const [row] = remote.listAuthCredentials("openai-codex");
		if (!row) throw new Error("expected stored OAuth credential");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const usageOrgs: Array<string | undefined> = [];
		remote.getUsageReport = async (_provider, current) => {
			usageOrgs.push(current.orgId);
			if (usageOrgs.length === 1) {
				started.resolve();
				await release.promise;
			}
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { planType: current.orgId ? "free" : "pro" },
			};
		};
		const resolution = clientStorage.getOAuthAccessByCredentialId("openai-codex", row.id, {
			modelId: "gpt-5.3-codex-spark",
		});
		try {
			await started.promise;
			store.updateAuthCredential(row.id, {
				...credential,
				access: "scoped-access",
				refresh: "scoped-refresh",
				orgId: "org-free",
			});
			await storage.reload();
			await remote.refreshSnapshot();
			release.resolve();
			expect(await resolution).toMatchObject({ ok: false, credentialId: row.id });
			expect(usageOrgs).toEqual([undefined, "org-free"]);
		} finally {
			release.resolve();
			await resolution;
		}
	});

	test("authoritative token and display changes reuse the same routing plan report", async () => {
		if (!storage || !store || !handle) throw new Error("test setup failed");
		const credential = {
			type: "oauth" as const,
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "same-account",
			email: "USER@example.com",
			orgId: "org-pro",
			orgName: "Old display name",
			projectId: "project-pro",
			enterpriseUrl: "https://enterprise.example.com",
		};
		await storage.set("openai-codex", credential);
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token }),
		});
		await remote.refreshSnapshot();
		clientStorage = new AuthStorage(remote);
		await clientStorage.reload();
		const [row] = remote.listAuthCredentials("openai-codex");
		if (!row) throw new Error("expected stored OAuth credential");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let usageCalls = 0;
		remote.getUsageReport = async () => {
			usageCalls++;
			started.resolve();
			await release.promise;
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { planType: "pro" },
			};
		};
		const resolution = clientStorage.getOAuthAccessByCredentialId("openai-codex", row.id, {
			modelId: "gpt-5.3-codex-spark",
		});
		try {
			await started.promise;
			store.updateAuthCredential(row.id, {
				...credential,
				access: "renewed-access",
				refresh: "renewed-refresh",
				expires: Date.now() + 7_200_000,
				email: "user@example.com",
				orgName: "New display name",
			});
			await storage.reload();
			await remote.refreshSnapshot();
			release.resolve();
			expect(await resolution).toMatchObject({ ok: true, accessToken: "renewed-access", orgId: "org-pro" });
			expect(usageCalls).toBe(1);
		} finally {
			release.resolve();
			await resolution;
		}
	});

	test("announces broker refresh disables to an already-listening session", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote);
		clientStorage.onCredentialDisabled(event => {
			events.push(event);
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const id = remote.snapshot.credentials[0]!.id;
		const failure = new Error("invalid_grant: refresh_token=live-refresh-secret client_secret=live-client-secret");
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(failure);
		await storage!.forceRefreshCredentialById(id).catch(() => {});
		await waitUntil(() => events.length > 0);
		expect(events).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				credentialId: id,
				credentialType: "oauth",
				email: "a@example.com",
				accountId: "account-a",
				disabledCause: expect.stringContaining("invalid_grant"),
			}),
		]);
		expect(remote.listAuthCredentials()).toEqual([]);
		// Bearers never appear in an event; the forensic cause does, and every
		// display surface renders it through `summarizeDisableCause`.
		const notice = JSON.stringify(events);
		for (const secret of ["access-a", "refresh-a"]) {
			expect(notice).not.toContain(secret);
		}
		for (const event of events) {
			const rendered = summarizeDisableCause(event.disabledCause);
			expect(rendered).not.toContain("live-refresh-secret");
			expect(rendered).not.toContain("live-client-secret");
		}
		expect((await store!.listDisabledCredentials())[0]!.cause).toContain("live-refresh-secret");
	});

	test("peer disable notices respect account pools and exclude logout and replacement", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("hidden", Date.now() + 60_000));
		await storage!.set("manual-provider", [{ type: "api_key", key: "old-key" }]);
		const initial = storage!.exportSnapshot();
		const allowed = initial.credentials.find(entry => entry.identityKey?.includes("a@example.com"))!;
		const hidden = initial.credentials.find(entry => entry.identityKey?.includes("hidden@example.com"))!;
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const lookups = vi.spyOn(client, "listDisabledCredentials");
		remote = new RemoteAuthCredentialStore({
			client,
			accountPool: new Map([["anthropic", new Set([allowed.identityKey!])]]),
		});
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		const originalId = remote.snapshot.credentials.find(entry => entry.provider === "manual-provider")!.id;
		await storage!.set("manual-provider", [{ type: "api_key", key: "replacement-key" }]);
		await waitUntil(() => !remote!.snapshot.credentials.some(entry => entry.id === originalId));
		await storage!.remove("manual-provider");
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		await peer.disableCredential(hidden.id, "oauth refresh failed: invalid_grant");
		await peer.disableCredential(allowed.id, "oauth refresh failed: invalid_grant");
		await waitUntil(() => remote!.snapshot.credentials.length === 0);
		await Promise.all(lookups.mock.results.map(result => result.value));
		expect(events).toEqual([expect.objectContaining({ credentialId: allowed.id, email: "a@example.com" })]);
	});

	test.each([true, false])(
		"coalesced disable and re-login only announce unrecovered accounts (SSE=%s)",
		async streamSnapshots => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 60_000));
			// Tombstone cleanup is best-effort; older brokers can also retain recovered history.
			const failureDb = new Database(path.join(tempDir, "agent.db"));
			try {
				failureDb.run(`
				CREATE TRIGGER retain_disabled_history
				BEFORE DELETE ON auth_credentials
				WHEN OLD.disabled_cause IS NOT NULL
				BEGIN
					SELECT RAISE(ABORT, 'forced tombstone cleanup failure');
				END;
			`);
			} finally {
				failureDb.close();
			}
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const lookups = vi.spyOn(client, "listDisabledCredentials");
			remote = new RemoteAuthCredentialStore({ client, streamSnapshots });
			const events: CredentialDisabledEvent[] = [];
			clientStorage = new AuthStorage(remote, {
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await waitUntil(() => remote!.snapshot.credentials.length === 2);
			const before = remote.snapshot.credentials;
			const recovered = before.find(entry => entry.identityKey === "email:a@example.com")!;
			const unrecovered = before.find(entry => entry.identityKey === "email:b@example.com")!;
			// Synchronous changes coalesce before the broker builds its next snapshot.
			// Its SSE diff sends replacement entries before the old row removals.
			storage!.disableCredentialById(recovered.id, "oauth refresh failed: invalid_grant");
			storage!.disableCredentialById(unrecovered.id, "oauth refresh failed: invalid_grant");
			storage!.upsertCredential("anthropic", {
				type: "oauth",
				access: "opaque-recovered-access",
				refresh: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ email: "a@example.com" })).toString("base64url")}.sig`,
				orgId: "org-recovered",
				expires: Date.now() + 60_000,
			});
			storage!.upsertCredential("anthropic", {
				type: "oauth",
				access: "unidentified-access",
				refresh: "unidentified-refresh",
				expires: Date.now() + 60_000,
			});
			await waitUntil(() => before.every(old => !remote!.snapshot.credentials.some(entry => entry.id === old.id)));
			await Promise.all(lookups.mock.results.map(result => result.value));
			expect(remote.snapshot.credentials.map(entry => entry.identityKey).sort()).toEqual([
				"email:a@example.com|org:org-recovered",
				null,
			]);
			expect((await store!.listDisabledCredentials()).map(summary => summary.id).sort()).toEqual(
				[recovered.id, unrecovered.id].sort(),
			);
			expect(events).toEqual([expect.objectContaining({ credentialId: unrecovered.id, email: "b@example.com" })]);
			expect((await clientStorage.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([
				unrecovered.id,
			]);
			const history = await clientStorage.listDisabledCredentials();
			const identities = clientStorage.listCredentialAccountIdentities();
			expect(
				history.filter(summary => isActionableCredentialDisable(summary, identities)).map(summary => summary.id),
			).toEqual([unrecovered.id]);
			const wire = await client.fetchSnapshot();
			if (wire.status !== 200) throw new Error("expected full snapshot");
			for (const entry of wire.snapshot.credentials) {
				if (entry.credential.type === "oauth") expect(entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
			}
			const serialized = JSON.stringify({ snapshot: wire.snapshot, identities, history, events });
			for (const entry of store!.listAuthCredentials()) {
				if (entry.credential.type === "oauth") expect(serialized).not.toContain(entry.credential.refresh);
			}
		},
	);

	test("refresh-only account keys keep contradictory shared-email identities actionable within the pool", async () => {
		const provider = "google-gemini-cli";
		const credential = (accountId: string) => ({
			type: "oauth" as const,
			access: "opaque-shared-access",
			refresh: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: accountId })).toString("base64url")}.sig`,
			expires: Date.now() + 60_000,
			email: "shared@example.com",
		});
		storage!.upsertCredential(provider, { ...credential("account-a"), refresh: "opaque-old-refresh" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const lookups = vi.spyOn(client, "listDisabledCredentials");
		remote = new RemoteAuthCredentialStore({
			client,
			accountPool: new Map([[provider, new Set(["email:shared@example.com", "account:account-b"])]]),
		});
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.some(entry => entry.provider === provider));
		const old = remote.snapshot.credentials.find(entry => entry.provider === provider)!;
		storage!.disableCredentialById(old.id, "oauth refresh failed: invalid_grant");
		storage!.upsertCredential(provider, credential("account-b"));
		storage!.upsertCredential(provider, credential("account-c"));
		await waitUntil(() => events.some(event => event.credentialId === old.id));
		await clientStorage.revalidateCredentials();
		expect(clientStorage.listStoredCredentials(provider).map(entry => entry.identityKey)).toEqual([
			"account:account-b",
		]);
		expect(
			clientStorage
				.exportSnapshot()
				.credentials.filter(entry => entry.provider === provider)
				.map(entry => entry.identityKey),
		).toEqual(["account:account-b"]);
		expect((await clientStorage.listActionableDisabledCredentials(provider)).map(summary => summary.id)).toEqual([
			old.id,
		]);
		const hidden = store!
			.listAuthCredentials(provider)
			.find(
				entry => entry.credential.type === "oauth" && entry.credential.refresh === credential("account-c").refresh,
			)!;
		storage!.disableCredentialById(hidden.id, "oauth refresh failed: invalid_grant");
		await clientStorage.revalidateCredentials();
		const history = await clientStorage.listDisabledCredentials(provider);
		const identities = clientStorage.listCredentialAccountIdentities(provider);
		expect(history.map(summary => summary.id)).toEqual([old.id]);
		expect(
			history.filter(summary => isActionableCredentialDisable(summary, identities)).map(summary => summary.id),
		).toEqual([old.id]);
		await Promise.all(lookups.mock.results.map(result => result.value));
		expect(events.map(event => event.credentialId)).toEqual([old.id]);
		const wire = await client.fetchSnapshot();
		if (wire.status !== 200) throw new Error("expected full snapshot");
		const projected = JSON.stringify({ snapshot: wire.snapshot, identities, history, events });
		expect(projected).not.toContain("opaque-old-refresh");
		for (const accountId of ["account-a", "account-b", "account-c"]) {
			expect(projected).not.toContain(credential(accountId).refresh);
		}
	});

	test("local credential replacement drops old broker identity authority before reload", async () => {
		storage!.upsertCredential("google-gemini-cli", {
			type: "oauth",
			access: "opaque-access",
			refresh: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "old-account" })).toString("base64url")}.sig`,
			expires: Date.now() + 60_000,
		});
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected full snapshot");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		clientStorage = new AuthStorage(remote);
		const row = remote.listAuthCredentials("google-gemini-cli")[0]!;
		if (row.credential.type !== "oauth") throw new Error("expected oauth credential");
		const summary = {
			id: 999,
			provider: "google-gemini-cli",
			type: "oauth" as const,
			cause: "invalid_grant",
			accountId: "old-account",
		};
		remote.updateAuthCredential(row.id, { ...row.credential });
		await clientStorage.reload();
		expect(isActionableCredentialDisable(summary, clientStorage.listCredentialAccountIdentities())).toBe(false);
		remote.updateAuthCredential(row.id, {
			...row.credential,
			access: "replacement-access",
			accountId: "new-account",
		});
		await clientStorage.reload();
		expect(isActionableCredentialDisable(summary, clientStorage.listCredentialAccountIdentities())).toBe(true);
		expect(
			isActionableCredentialDisable(
				{ ...summary, accountId: "new-account" },
				clientStorage.listCredentialAccountIdentities(),
			),
		).toBe(false);
		remote.updateAuthCredential(row.id, { ...row.credential, access: "unidentified-access" });
		await clientStorage.reload();
		expect(isActionableCredentialDisable(summary, clientStorage.listCredentialAccountIdentities())).toBe(true);
	});

	test("a re-login received while the tombstone lookup is pending suppresses the stale notice", async () => {
		const responseReady = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const listDisabled = client.listDisabledCredentials.bind(client);
		const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
			const disabled = await listDisabled(...args);
			responseReady.resolve();
			await releaseResponse.promise;
			return disabled;
		});
		remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const id = remote.snapshot.credentials[0]!.id;
		await client.disableCredential(id, "oauth refresh failed: invalid_grant");
		try {
			await responseReady.promise;
			storage!.upsertCredential("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
			await waitUntil(() => remote!.snapshot.credentials.some(entry => entry.id !== id));
		} finally {
			releaseResponse.resolve();
			await Promise.all(lookups.mock.results.map(result => result.value));
		}
		expect(events).toEqual([]);
	});

	test("a client-initiated automatic disable is announced once when SSE beats the write response", async () => {
		const releaseResponse = Promise.withResolvers<void>();
		const fetchImpl: typeof fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const response = await fetch(input, init);
				if (String(input).endsWith("/disable")) await releaseResponse.promise;
				return response;
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: handle!.url, token, fetchImpl });
		const lookups = vi.spyOn(client, "listDisabledCredentials");
		remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const entry = remote.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected OAuth credential");
		const rotation = clientStorage.rotateSessionCredential("anthropic", "local-disable", {
			error: new Error("Encountered invalidated oauth token for user, failing request"),
			apiKey: entry.credential.access,
			credentialId: entry.id,
		});
		try {
			await waitUntil(() => remote!.snapshot.credentials.length === 0);
			await Promise.all(lookups.mock.results.map(result => result.value));
		} finally {
			releaseResponse.resolve();
			await rotation;
		}
		expect(events).toEqual([
			expect.objectContaining({
				credentialId: entry.id,
				disabledCause: expect.stringContaining("invalidated oauth token"),
			}),
		]);
	});

	test.each(["local", "peer"] as const)("overlapping local disables announce one sign-out won by %s", async winner => {
		const startRequests = Promise.withResolvers<void>();
		const releaseSuccess = Promise.withResolvers<void>();
		let requests = 0;
		let accepted = false;
		let completed = 0;
		const fetchImpl: typeof fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const disabling = String(input).endsWith("/disable");
				if (disabling) {
					requests++;
					await startRequests.promise;
				}
				const response = await fetch(input, init);
				if (disabling && response.ok) {
					accepted = true;
					await releaseSuccess.promise;
				}
				return response;
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: handle!.url, token, fetchImpl });
		const lookups = vi.spyOn(client, "listDisabledCredentials");
		remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const entry = remote.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected OAuth credential");
		const apiKey = entry.credential.access;
		const rotations = ["first", "second"].map(session =>
			clientStorage!
				.rotateSessionCredential("anthropic", session, {
					error: new Error("Encountered invalidated oauth token for user, failing request"),
					apiKey,
					credentialId: entry.id,
				})
				.finally(() => {
					completed++;
				}),
		);
		const settled = Promise.allSettled(rotations);
		try {
			await waitUntil(() => requests === 2);
			if (winner === "peer") {
				await new AuthBrokerClient({ url: handle!.url, token }).disableCredential(
					entry.id,
					"oauth refresh failed: invalid_grant",
				);
			}
			startRequests.resolve();
			await waitUntil(
				() =>
					(winner === "local" ? accepted && completed === 1 : completed === 2) &&
					remote!.snapshot.credentials.length === 0,
			);
			await Promise.all(lookups.mock.results.map(result => result.value));
		} finally {
			startRequests.resolve();
			releaseSuccess.resolve();
			await settled;
		}
		expect(events).toEqual([expect.objectContaining({ credentialId: entry.id })]);
	});

	test("long-poll removal buffers a notice for the first listener and does not replay it twice", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const lookups = vi.spyOn(client, "listDisabledCredentials");
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		clientStorage = new AuthStorage(remote);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const id = remote.snapshot.credentials[0]!.id;
		await client.disableCredential(id, "oauth refresh failed: invalid_grant");
		await waitUntil(() => remote!.snapshot.credentials.length === 0);
		await Promise.all(lookups.mock.results.map(result => result.value));
		const events: CredentialDisabledEvent[] = [];
		const unsubscribe = clientStorage.onCredentialDisabled(event => {
			events.push(event);
		});
		unsubscribe();
		clientStorage.onCredentialDisabled(event => {
			events.push(event);
		});
		expect(events).toEqual([expect.objectContaining({ credentialId: id })]);
	});

	test("closing a session while its tombstone lookup is pending prevents a late notice", async () => {
		const responseReady = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const listDisabled = client.listDisabledCredentials.bind(client);
		const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
			const disabled = await listDisabled(...args);
			responseReady.resolve();
			await releaseResponse.promise;
			return disabled;
		});
		remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		clientStorage = new AuthStorage(remote, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		await client.disableCredential(remote.snapshot.credentials[0]!.id, "oauth refresh failed: invalid_grant");
		try {
			await responseReady.promise;
			clientStorage.close();
		} finally {
			releaseResponse.resolve();
			await Promise.all(lookups.mock.results.map(result => result.value));
		}
		expect(events).toEqual([]);
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("pollExternalChanges reports broker-side changes so a wrapping AuthStorage reloads", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		// Mirror `auth-gateway serve`'s boot: fetch the initial snapshot so the
		// store seeds its acknowledged generation, then wrap the broker-backed
		// store in its own AuthStorage whose credential view only refreshes on
		// reload().
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		const gatewayStorage = new AuthStorage(remote, { sourceLabel: `broker ${handle!.url}` });
		try {
			await gatewayStorage.reload();
			await waitUntil(() => remote!.snapshot.credentials.length === 1);
			// Boot generation is acknowledged: no spurious reload before any change.
			expect(await gatewayStorage.pollExternalChanges()).toBe(false);
			expect(gatewayStorage.exportSnapshot().credentials.map(c => c.provider)).toEqual(["anthropic"]);

			// Another process logs in a new provider; the change reaches the remote
			// store over SSE.
			storage!.upsertCredential("deepseek", { type: "api_key", key: "sk-repro" });
			await waitUntil(() => remote!.snapshot.credentials.some(c => c.provider === "deepseek"));

			// The poll now reports the change and the reload widens the gateway view.
			expect(await gatewayStorage.pollExternalChanges()).toBe(true);
			expect(
				gatewayStorage
					.exportSnapshot()
					.credentials.map(c => c.provider)
					.sort(),
			).toEqual(["anthropic", "deepseek"]);
			// One true per observed change: an unchanged generation reports false.
			expect(await gatewayStorage.pollExternalChanges()).toBe(false);

			// A logout in another process removes the credential over SSE, and the
			// next poll drops it from the gateway view.
			const deepseekId = remote!.snapshot.credentials.find(c => c.provider === "deepseek")?.id;
			expect(deepseekId).toBeDefined();
			expect(storage!.disableCredentialById(deepseekId!, "logged out by test")).toBe(true);
			await waitUntil(() => !remote!.snapshot.credentials.some(c => c.provider === "deepseek"));
			expect(await gatewayStorage.pollExternalChanges()).toBe(true);
			expect(gatewayStorage.exportSnapshot().credentials.map(c => c.provider)).toEqual(["anthropic"]);
		} finally {
			gatewayStorage.close();
		}
	});

	test("accepts a lower-generation authoritative snapshot after broker restart", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		const gatewayStorage = new AuthStorage(remote, { sourceLabel: `broker ${handle!.url}` });
		try {
			await gatewayStorage.reload();

			// Drive the original broker above the generation its replacement will
			// start at, then acknowledge that complete credential view.
			storage!.upsertCredential("deepseek", { type: "api_key", key: "sk-deepseek" });
			storage!.upsertCredential("openai", { type: "api_key", key: "sk-openai" });
			storage!.upsertCredential("xai", { type: "api_key", key: "sk-xai" });
			await waitUntil(() => remote!.snapshot.credentials.length === 4);
			const previousGeneration = remote.snapshot.generation;
			expect(await gatewayStorage.pollExternalChanges()).toBe(true);
			expect(await gatewayStorage.pollExternalChanges()).toBe(false);

			// Stop the broker, replace its persisted credential set, and boot a
			// fresh AuthStorage whose in-memory generation starts below the
			// client's previously acknowledged value.
			const brokerUrl = new URL(handle!.url);
			const bind = `${brokerUrl.hostname}:${brokerUrl.port}`;
			await handle!.close();
			storage!.close();

			store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			for (const provider of ["anthropic", "deepseek", "openai", "xai"]) {
				store.deleteProvider(provider);
			}
			store.saveApiKey("google", "sk-restarted");
			storage = new AuthStorage(store);
			await storage.reload();
			expect(storage.getGeneration()).toBeLessThan(previousGeneration);
			handle = startAuthBroker({
				storage,
				bind,
				bearerTokens: [token],
				disableRefresher: true,
			});

			// The reconnect's first SSE frame is authoritative despite its lower
			// generation. The wrapping AuthStorage must reload that content.
			await waitUntil(
				() =>
					remote!.snapshot.generation < previousGeneration &&
					remote!.snapshot.credentials.length === 1 &&
					remote!.snapshot.credentials[0]?.provider === "google",
				4_000,
			);
			expect(await gatewayStorage.pollExternalChanges()).toBe(true);
			expect(gatewayStorage.exportSnapshot().credentials.map(c => c.provider)).toEqual(["google"]);

			// Incremental events are now ordered against the replacement
			// baseline, not the previous broker process's higher generation.
			storage!.upsertCredential("deepseek", { type: "api_key", key: "sk-after-restart" });
			await waitUntil(() => remote!.snapshot.credentials.some(c => c.provider === "deepseek"));
			expect(remote.snapshot.generation).toBeLessThan(previousGeneration);
			expect(await gatewayStorage.pollExternalChanges()).toBe(true);
			expect(
				gatewayStorage
					.exportSnapshot()
					.credentials.map(c => c.provider)
					.sort(),
			).toEqual(["deepseek", "google"]);
		} finally {
			gatewayStorage.close();
		}
	});

	test("batches observed usage and reports it to the broker as per-install client usage", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, observedUsageFlushMs: 25 });

		const at = Date.now();
		// Two requests for the same (provider, model) must merge into one entry;
		// a second model produces its own entry in the same flush.
		remote.recordObservedUsage([
			{
				at,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
				costUsd: 0.5,
			},
		]);
		remote.recordObservedUsage([
			{
				at: at + 1,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 200,
				outputTokens: 100,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				costUsd: 1.0,
			},
			{
				at: at + 2,
				provider: "openai-codex",
				model: "gpt-y",
				requests: 1,
				inputTokens: 30,
				outputTokens: 15,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			},
		]);

		await waitUntil(() => storage!.getClientUsageSummary(0).clients.length === 1);
		const summary = storage!.getClientUsageSummary(0);
		const reported = summary.clients[0];
		expect(reported.installId.length).toBeGreaterThan(0);
		expect(reported.hostname).toBe(os.hostname());
		// Default identity carries the app label so broker-side attribution can
		// answer "what did app X use" even for broker-direct installs.
		expect(reported.providers.every(p => p.app === "omp")).toBe(true);

		const anthropic = reported.providers.find(p => p.provider === "anthropic");
		expect(anthropic).toMatchObject({
			requests: 2,
			inputTokens: 300,
			outputTokens: 150,
			cacheReadTokens: 30,
			cacheWriteTokens: 15,
		});
		expect(anthropic?.costUsd).toBeCloseTo(1.5, 10);
		expect(reported.providers.find(p => p.provider === "openai-codex")).toMatchObject({
			requests: 1,
			inputTokens: 30,
		});

		// A follow-up report — routed through the client-side AuthStorage facade,
		// like the coding-agent does per assistant message — merges into the same
		// 5-minute bucket row instead of accreting a new row per flush.
		const clientStorage = new AuthStorage(remote);
		clientStorage.recordObservedUsage({
			provider: "anthropic",
			model: "claude-x",
			at: at + 3,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		});
		await waitUntil(() => {
			const current = storage!.getClientUsageSummary(0).clients[0];
			return current?.providers.find(p => p.provider === "anthropic")?.requests === 3;
		});
		// An explicit identity (the auth-gateway attributing a caller) must
		// produce its own client row instead of folding into this install.
		remote.recordObservedUsage(
			[
				{
					at: at + 4,
					provider: "anthropic",
					model: "claude-x",
					requests: 1,
					inputTokens: 7,
					outputTokens: 3,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0.05,
				},
			],
			{ installId: "robomp-install", hostname: "robomp-box", app: "robomp" },
		);
		await waitUntil(() => storage!.getClientUsageSummary(0).clients.length === 2);
		const attributed = storage!.getClientUsageSummary(0).clients.find(c => c.installId === "robomp-install");
		expect(attributed?.hostname).toBe("robomp-box");
		expect(attributed?.providers).toEqual([
			{
				app: "robomp",
				provider: "anthropic",
				requests: 1,
				inputTokens: 7,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.05,
			},
		]);
	});

	test("background sync parks after the idle window and resumes on the next store use", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const openSpy = vi.spyOn(client, "openSnapshotStream");
		remote = new RemoteAuthCredentialStore({ client, backgroundIdleMs: 150 });

		// Stream opens immediately (construction counts as activity).
		await waitUntil(() => openSpy.mock.calls.length === 1);
		const firstSignal = openSpy.mock.calls[0]![0]!.signal!;

		// Idle window elapses with no foreground use: the in-flight SSE request
		// is aborted without close(). A leaked store would otherwise hold this
		// connection forever and pin the process (the git-tui hang).
		await waitUntil(() => firstSignal.aborted);

		// Parked: no reconnect attempts while the store stays unused.
		// Real delay on purpose: the idle watchdog runs on real unref'd timers
		// against a live SSE server, so fake timers cannot drive this path.
		await Bun.sleep(300);
		expect(openSpy.mock.calls.length).toBe(1);

		// Any foreground use wakes the loop and re-establishes the stream.
		remote.listAuthCredentials();
		await waitUntil(() => openSpy.mock.calls.length === 2);
		expect(openSpy.mock.calls[1]![0]!.signal!.aborted).toBe(false);
	});

	test("calls onSnapshot for broker snapshots but not the constructor snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const callbacks: Array<{ snapshot: SnapshotResponse; generation: number }> = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			onSnapshot: (snapshot, generation) => {
				callbacks.push({ snapshot, generation });
			},
		});
		expect(callbacks).toHaveLength(0);

		const refreshed = await remote.refreshSnapshot();

		expect(callbacks).toHaveLength(1);
		expect(callbacks[0].generation).toBe(refreshed.generation);
		expect(callbacks[0].snapshot).toEqual(refreshed);
	});

	test("filters configured OAuth identities while preserving API keys and raw snapshot callbacks", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		storage!.upsertCredential("anthropic", { type: "api_key", key: "visible-api-key" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const identities = new Set([allowed.identityKey]);
		const callbacks: SnapshotResponse[] = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", identities]]),
			onSnapshot: snapshot => {
				callbacks.push(snapshot);
			},
		});

		identities.add(excluded.identityKey);
		expect(
			remote
				.listAuthCredentials("anthropic")
				.map(entry => entry.credential.type)
				.sort(),
		).toEqual(["api_key", "oauth"]);
		const refreshed = await remote.refreshSnapshot();
		expect(refreshed.credentials.filter(entry => entry.credential.type === "oauth")).toHaveLength(1);
		expect(callbacks.at(-1)?.credentials).toHaveLength(3);
	});

	test.each(["selected", "empty"] as const)(
		"rejects provider logout for a %s account pool without deleting visible or hidden state",
		async pool => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
			storage!.upsertCredential("anthropic", mintOAuthCredential("disabled", Date.now() + 120_000));
			storage!.upsertCredential("anthropic", { type: "api_key", key: "visible-api-key" });
			const entries = storage!.exportSnapshot().credentials;
			const allowed = entries.find(entry => entry.identityKey?.includes("a@example.com"))!;
			const disabled = entries.find(entry => entry.identityKey?.includes("disabled@example.com"))!;
			expect(storage!.disableCredentialById(disabled.id, "invalid_grant")).toBe(true);
			const client = new AuthBrokerClient({ url: handle!.url, token });
			remote = new RemoteAuthCredentialStore({
				client,
				streamSnapshots: false,
				accountPool: new Map([["anthropic", new Set(pool === "selected" ? [allowed.identityKey!] : [])]]),
			});
			const clientStorage = new AuthStorage(remote);
			await clientStorage.revalidateCredentials();
			expect(clientStorage.listOAuthAccounts("anthropic").map(account => account.email)).toEqual(
				pool === "selected" ? ["a@example.com"] : [],
			);
			expect(await clientStorage.listDisabledCredentials("anthropic")).toEqual([]);
			const localCredentials = clientStorage.listStoredCredentials("anthropic");
			const localSnapshot = remote.snapshot;
			const brokerSnapshot = storage!.exportSnapshot();
			const brokerCredentials = store!.listAuthCredentials("anthropic");
			const brokerHistory = await client.listDisabledCredentials("anthropic");
			expect(brokerHistory.map(row => row.id)).toEqual([disabled.id]);

			await expect(clientStorage.remove("anthropic")).rejects.toMatchObject({ name: "ConfigurationError" });

			expect(clientStorage.listStoredCredentials("anthropic")).toEqual(localCredentials);
			expect(remote.snapshot).toEqual(localSnapshot);
			expect(storage!.exportSnapshot()).toMatchObject({
				credentials: brokerSnapshot.credentials,
				generation: brokerSnapshot.generation,
			});
			expect(store!.listAuthCredentials("anthropic")).toEqual(brokerCredentials);
			expect(await client.listDisabledCredentials("anthropic")).toEqual(brokerHistory);
		},
	);

	test("logs out a provider absent from the account pool and clears its prior history", async () => {
		storage!.upsertCredential("openai-codex", mintOAuthCredential("disabled", Date.now() + 120_000));
		const disabled = store!.listAuthCredentials("openai-codex")[0]!;
		expect(storage!.disableCredentialById(disabled.id, "invalid_grant")).toBe(true);
		storage!.upsertCredential("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		const active = store!.listAuthCredentials("openai-codex")[0]!;
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({
			client,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set()]]),
		});
		const clientStorage = new AuthStorage(remote);
		await clientStorage.revalidateCredentials();
		const restrictedCredentials = store!.listAuthCredentials("anthropic");
		expect(clientStorage.listStoredCredentials("openai-codex").map(row => row.id)).toEqual([active.id]);
		expect((await clientStorage.listDisabledCredentials("openai-codex")).map(row => row.id)).toEqual([disabled.id]);

		await clientStorage.remove("openai-codex");

		expect(clientStorage.listStoredCredentials("openai-codex")).toEqual([]);
		expect(remote.listAuthCredentials("openai-codex")).toEqual([]);
		expect(storage!.listStoredCredentials("openai-codex")).toEqual([]);
		expect(store!.listAuthCredentials("openai-codex")).toEqual([]);
		expect(
			(await client.listDisabledCredentials("openai-codex")).map(row => ({ id: row.id, cause: row.cause })),
		).toEqual([{ id: active.id, cause: "deleted by user" }]);
		expect(store!.listAuthCredentials("anthropic")).toEqual(restrictedCredentials);
	});

	test("keeps disabled history within the same account pool as the active view", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		storage!.upsertCredential("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		const snapshot = storage!.exportSnapshot();
		const a = snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"))!;
		const b = snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"))!;
		const codex = snapshot.credentials.find(entry => entry.provider === "openai-codex")!;
		expect(storage!.disableCredentialById(b.id, "invalid_grant")).toBe(true);
		expect(storage!.disableCredentialById(codex.id, "invalid_grant")).toBe(true);
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({
			client,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set([a.identityKey!])]]),
		});
		const clientStorage = new AuthStorage(remote);
		await clientStorage.revalidateCredentials();
		expect(clientStorage.listOAuthAccounts("anthropic").map(account => account.email)).toEqual(["a@example.com"]);
		expect((await clientStorage.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([codex.id]);
		expect(storage!.disableCredentialById(a.id, "invalid_grant")).toBe(true);
		expect((await clientStorage.listActionableDisabledCredentials()).map(summary => summary.id).sort()).toEqual(
			[a.id, codex.id].sort(),
		);
		// Pool routing does not erase the broker-wide forensic history.
		expect((await client.listDisabledCredentials()).map(summary => summary.id).sort()).toEqual(
			[a.id, b.id, codex.id].sort(),
		);
	});

	test("advances the SSE generation without exposing an excluded entry", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials[0];
		if (!allowed?.identityKey) throw new Error("expected OAuth identity key");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			accountPool: new Map([["anthropic", new Set([allowed.identityKey])]]),
		});
		const initialGeneration = remote.snapshot.generation;

		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.generation > initialGeneration);

		expect(remote.snapshot.credentials).toHaveLength(1);
		expect(remote.snapshot.credentials[0]?.identityKey).toBe(allowed.identityKey);
	});

	test("treats a missing provider as unrestricted and an empty provider pool as OAuth-disabled", async () => {
		storage!.upsertCredential("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set()]]),
		});

		expect(remote.listAuthCredentials("anthropic")).toEqual([]);
		expect(remote.listAuthCredentials("openai-codex")).toHaveLength(1);
	});

	test("loads the account pool once for broker-backed discovery", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const poolPath = path.join(tempDir, "account-pool.json");
		await Bun.write(poolPath, JSON.stringify({ anthropic: [allowed.identityKey] }));

		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "snapshot-cache.enc"),
				});
				try {
					expect(discovered.listOAuthAccounts("anthropic").map(account => account.email)).toEqual([
						"a@example.com",
					]);

					await Bun.write(poolPath, JSON.stringify({ anthropic: [allowed.identityKey, excluded.identityKey] }));
					await discovered.reload();
					expect(discovered.listOAuthAccounts("anthropic").map(account => account.email)).toEqual([
						"a@example.com",
					]);
				} finally {
					discovered.close();
				}
			},
		);
	});

	test("prefers a programmatic SDK account pool over the environment file", async () => {
		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: path.join(tempDir, "missing-account-pool.json"),
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "sdk-snapshot-cache.enc"),
					accountPool: new Map([["anthropic", new Set()]]),
				});
				try {
					expect(discovered.listOAuthAccounts("anthropic")).toEqual([]);
				} finally {
					discovered.close();
				}
			},
		);
	});
});

/**
 * Snapshot builder for the fake-client tests: only `id`/`provider`/`credential`
 * feed the content fingerprint, so the credential key is what drives change
 * detection.
 */
function buildApiKeySnapshot(
	generation: number,
	creds: { id: number; provider: string; key: string }[],
): SnapshotResponse {
	return {
		generation,
		generatedAt: Date.now(),
		serverNowMs: Date.now(),
		refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
		credentials: creds.map(c => ({
			id: c.id,
			provider: c.provider,
			credential: { type: "api_key", key: c.key },
			identityKey: null,
			rotatesInMs: null,
		})),
	};
}

/**
 * Minimal broker client that serves a test-controlled snapshot. Background
 * long-poll calls (which pass `ifGenerationGt`) always report "unchanged" so
 * the manual `refreshSnapshot()` is the sole driver, keeping the test
 * deterministic.
 */
class FakeBrokerClient {
	current: SnapshotResponse;
	constructor(initial: SnapshotResponse) {
		this.current = initial;
	}
	async fetchSnapshot(opts: { ifGenerationGt?: number } = {}): Promise<FetchSnapshotResult> {
		if (opts.ifGenerationGt !== undefined) return { status: 304, generation: this.current.generation };
		return { status: 200, snapshot: this.current, generation: this.current.generation };
	}
}

describe("RemoteAuthCredentialStore.pollExternalChanges content revision", () => {
	test("detects a replaced credential even when the broker generation repeats", async () => {
		const initial = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-old" }]);
		const client = new FakeBrokerClient(initial);
		const store = new RemoteAuthCredentialStore({
			client: client as unknown as AuthBrokerClient,
			initialSnapshot: initial,
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		try {
			// Boot state is acknowledged: nothing to report yet.
			expect(store.pollExternalChanges()).toBe(false);

			// An identical re-fetch (same generation, same content) stays quiet.
			client.current = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-old" }]);
			await store.refreshSnapshot();
			expect(store.pollExternalChanges()).toBe(false);

			// The broker restarts and replaces the credential's key while its
			// in-memory generation counter lands back on the acknowledged value 5.
			// A generation-equality check would miss this; the content revision
			// catches it.
			client.current = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-new" }]);
			await store.refreshSnapshot();
			expect(store.snapshot.generation).toBe(5);
			expect(store.pollExternalChanges()).toBe(true);
			// One true per observed change.
			expect(store.pollExternalChanges()).toBe(false);
		} finally {
			store.close();
		}
	});
});
