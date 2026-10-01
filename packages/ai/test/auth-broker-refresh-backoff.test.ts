import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, withAuth, withOAuthAccess } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AuthBrokerRefresher,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { OAuthError } from "@oh-my-pi/pi-ai/error";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-broker-refresh-backoff";
const SOURCE = "auth-broker-refresh-backoff-test";
const TOKEN = "auth-broker-refresh-backoff-bearer";
const HOUR_MS = 60 * 60_000;

describe("auth broker OAuth refresh backoff", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	let refreshCalls = 0;

	beforeEach(async () => {
		refreshCalls = 0;
		registerOAuthProvider({
			id: PROVIDER,
			name: "Broker Refresh Backoff Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login-access", refresh: "login-refresh", expires: Date.now() + HOUR_MS };
			},
			async refreshToken(credentials: OAuthCredentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: `access-${refreshCalls}`,
					refresh: `refresh-${refreshCalls}`,
					expires: Date.now() + HOUR_MS,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-refresh-backoff-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		await store.saveOAuth(PROVIDER, {
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() + HOUR_MS,
			accountId: "broker-refresh-backoff-account",
		});
		brokerStorage = new AuthStorage(store);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE);
		clientStorage?.close();
		remote?.close();
		await handle?.close();
		brokerStorage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("reuses a recent broker mint without extending its original cooldown", async () => {
		if (!handle || !brokerStorage) throw new Error("test setup failed");
		const start = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		const mintingClient = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const initial = await mintingClient.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		const credentialId = initial.snapshot.credentials[0]!.id;
		await mintingClient.refreshCredential(credentialId);
		expect(refreshCalls).toBe(1);

		clock.mockReturnValue(start + 299_000);
		const recoveryClient = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const refreshedSnapshot = await recoveryClient.fetchSnapshot();
		if (refreshedSnapshot.status !== 200) throw new Error("expected refreshed broker snapshot");
		remote = new RemoteAuthCredentialStore({
			client: recoveryClient,
			initialSnapshot: refreshedSnapshot.snapshot,
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.credentials.reload();
		const authError = Object.assign(new Error("401 invalid_api_key"), { status: 401 });
		const firstBearers: string[] = [];
		await expect(
			withAuth(clientStorage.keys.resolver(PROVIDER, { sessionId: "late-recovery" }), async key => {
				firstBearers.push(key);
				throw authError;
			}),
		).rejects.toBe(authError);
		expect(firstBearers).toEqual(["access-1"]);
		expect(refreshCalls).toBe(1);

		// The 60 s credential block has elapsed and the broker's original mint is
		// older than five minutes. A cached response received at t=4:59 must not
		// restart the cooldown in this client process.
		clock.mockReturnValue(start + 389_000);
		const secondBearers: string[] = [];
		await expect(
			withAuth(clientStorage.keys.resolver(PROVIDER, { sessionId: "post-cooldown" }), async key => {
				secondBearers.push(key);
				throw authError;
			}),
		).rejects.toBe(authError);
		expect(secondBearers).toEqual(["access-1", "access-2"]);
		expect(refreshCalls).toBe(2);
	});

	test("delegated durable refresh does not establish a local mint cooldown", async () => {
		if (!store) throw new Error("test setup failed");
		let delegatedCalls = 0;
		clientStorage = new AuthStorage(store, {
			async refreshOAuthCredential(_provider, _id, credential) {
				delegatedCalls += 1;
				return { ...credential, access: `delegated-${delegatedCalls}`, expires: Date.now() + HOUR_MS };
			},
		});
		await clientStorage.credentials.reload();
		const id = store.listAuthCredentials(PROVIDER)[0]!.id;
		await clientStorage.oauth.refresh(id);
		const recovered = await clientStorage.oauth.refresh(id, undefined, { reuseRecentMint: true });
		expect(recovered.credential.type === "oauth" && recovered.credential.access).toBe("delegated-2");
		expect(delegatedCalls).toBe(2);
	});

	test("generic forced refresh mints while only a provider 401 opts into reuse", async () => {
		if (!handle) throw new Error("test setup failed");
		const client = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.credentials.reload();
		expect(await clientStorage.keys.get(PROVIDER, "generic", { forceRefresh: true })).toBe("access-1");
		expect(await clientStorage.keys.get(PROVIDER, "generic", { forceRefresh: true })).toBe("access-2");
		const resolve = clientStorage.keys.resolver(PROVIDER, { sessionId: "generic" });
		expect(
			await resolve({ lastChance: false, error: Object.assign(new Error("server error"), { status: 500 }) }),
		).toMatchObject({ apiKey: "access-3" });
		expect(
			await resolve({ lastChance: false, error: Object.assign(new Error("unauthorized"), { status: 401 }) }),
		).toMatchObject({ apiKey: "access-3" });
		expect(refreshCalls).toBe(3);
	});

	test("auth gateway reuses a recent mint only for provider 401 recovery", async () => {
		if (!brokerStorage) throw new Error("test setup failed");
		const model = { provider: PROVIDER, id: "gateway-model", api: "openai-responses", baseUrl: "http://gateway" };
		const resolve = buildGatewayApiKeyResolver(
			brokerStorage,
			model as Model<Api>,
			"gateway",
			{ apiKey: "access-0" },
			new AbortController().signal,
			"openai",
			"peer",
		);
		const unauthorized = Object.assign(new Error("401 invalid_api_key"), { status: 401 });
		expect(await resolve({ lastChance: false, error: unauthorized })).toMatchObject({ apiKey: "access-1" });
		expect(await resolve({ lastChance: false, error: unauthorized })).toMatchObject({ apiKey: "access-1" });
		expect(
			await resolve({ lastChance: false, error: Object.assign(new Error("server error"), { status: 500 }) }),
		).toMatchObject({ apiKey: "access-2" });
		expect(refreshCalls).toBe(2);
	});

	test("generic delegated force refresh leaves recovery intent unset", async () => {
		if (!store) throw new Error("test setup failed");
		clientStorage = new AuthStorage(store, {
			async refreshOAuthCredential(_provider, _id, credential, _signal, reason) {
				// A delegate may return its cached token only for explicit recovery.
				return {
					...credential,
					access: reason === "auth-recovery" ? credential.access : `${credential.access}-renewed`,
					expires: Date.now() + HOUR_MS,
				};
			},
		});
		await clientStorage.credentials.reload();
		expect(await clientStorage.keys.get(PROVIDER, "generic", { forceRefresh: true })).toBe("access-0-renewed");
		expect(await clientStorage.keys.get(PROVIDER, "generic", { forceRefresh: true })).toBe(
			"access-0-renewed-renewed",
		);
	});

	test("typed token-refresh replay mints instead of reusing a recent broker token", async () => {
		if (!handle) throw new Error("test setup failed");
		const client = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		await client.refreshCredential(initial.snapshot.credentials[0]!.id);
		const minted = await client.fetchSnapshot();
		if (minted.status !== 200) throw new Error("expected minted snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: minted.snapshot,
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.credentials.reload();
		const attempted: string[] = [];
		const result = await withOAuthAccess(clientStorage, PROVIDER, async access => {
			attempted.push(access.accessToken);
			if (access.accessToken === "access-1") {
				throw new OAuthError("token expired before request", { kind: "token-refresh" });
			}
			return access.accessToken;
		});
		expect(result).toBe("access-2");
		expect(attempted).toEqual(["access-1", "access-2"]);
		expect(refreshCalls).toBe(2);
	});

	test("scheduled expiry refresh bypasses recent-mint reuse", async () => {
		if (!handle || !brokerStorage) throw new Error("test setup failed");
		const client = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		const credentialId = initial.snapshot.credentials[0]!.id;

		await client.refreshCredential(credentialId);
		expect(refreshCalls).toBe(1);
		await new AuthBrokerRefresher({ storage: brokerStorage, refreshSkewMs: 2 * HOUR_MS }).tick();
		expect(refreshCalls).toBe(2);
	});
});
