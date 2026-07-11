import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@pk-nerdsaver-ai/pi-ai/auth-broker";
import * as oauthUtils from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("RemoteAuthCredentialStore + AuthStorage integration", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "remote-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		serverStore.saveOAuth("anthropic", {
			access: "server-access-1",
			refresh: "server-refresh-1",
			expires: Date.now() - 60_000, // expired so refresh is forced
			accountId: "account-1",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("client-side AuthStorage refreshes via broker override, never via local OAuth path", async () => {
		// Real refresh executed by the broker server; mock surfaces the rotated tokens.
		const rotated = {
			access: "server-access-rotated",
			refresh: "server-refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialSnapshot = initialResult.snapshot;
		expect(initialSnapshot.credentials).toHaveLength(1);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
		});

		let overrideCalls = 0;
		const clientStorage = new AuthStorage(remoteStore, {
			refreshOAuthCredential: async (_provider, credentialId, _credential) => {
				overrideCalls += 1;
				const { entry } = await brokerClient.refreshCredential(credentialId);
				if (entry.credential.type !== "oauth") throw new Error("unexpected");
				return {
					access: entry.credential.access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: entry.credential.expires,
					accountId: entry.credential.accountId,
					email: entry.credential.email,
				};
			},
		});
		await clientStorage.reload();

		const apiKey = await clientStorage.getApiKey("anthropic");
		expect(apiKey).toBe("server-access-rotated");
		expect(overrideCalls).toBe(1);
		// The local oauth refresh helper was used exactly once — by the broker server.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		clientStorage.close();
	});
	test("suspect credential refresh updates the client snapshot from the broker response", async () => {
		const rotated = {
			access: "server-access-after-401",
			refresh: "server-refresh-after-401",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials[0];
		if (!initialEntry) throw new Error("expected credential");

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});

		await remoteStore.markCredentialSuspect(initialEntry.id);
		const rows = remoteStore.listAuthCredentials("anthropic");

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.access).toBe("server-access-after-401");
			expect(rows[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		remoteStore.close();
	});

	test("RemoteAuthCredentialStore rejects writes from the client", () => {
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		expect(() => remoteStore.replaceAuthCredentialsForProvider("anthropic", [])).toThrow(/read-only/);
		expect(() => remoteStore.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "x" })).toThrow(
			/read-only/,
		);
		expect(() => remoteStore.deleteAuthCredentialsForProvider("anthropic", "x")).toThrow(/read-only/);
		remoteStore.close();
	});

	test("getUsageReport coalesces parallel callers and matches by identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const reportForA = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com" },
		};
		const reportForB = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: Date.now(), reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const credB = { ...credA, email: "b@example.com" };

		const [resA, resB] = await Promise.all([
			remoteStore.getUsageReport("anthropic", credA),
			remoteStore.getUsageReport("anthropic", credB),
		]);
		// Parallel callers share a single broker round-trip.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resA?.metadata?.email).toBe("a@example.com");
		expect(resB?.metadata?.email).toBe("b@example.com");

		// Cached on the second call — still one fetch total.
		const cached = await remoteStore.getUsageReport("anthropic", credA);
		expect(cached?.metadata?.email).toBe("a@example.com");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Unknown provider → null, no extra fetch.
		const miss = await remoteStore.getUsageReport("openai-codex", credA);
		expect(miss).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("client AuthStorage.set forwards api_key login to the broker (replace semantics)", async () => {
		// Pre-existing api_key for the same provider on the server side — a fresh
		// login should disable it and replace it with the new key.
		serverStore!.saveApiKey("kagi", "old-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.set("kagi", { type: "api_key", key: "new-key" });

		// Server is the source of truth — only the new key should be active.
		const activeOnServer = serverStore!.listAuthCredentials("kagi");
		expect(activeOnServer).toHaveLength(1);
		expect(activeOnServer[0].credential).toEqual({ type: "api_key", key: "new-key" });

		// Client reflects the new key through the broker's `POST /v1/credential`
		// response without waiting for the long-poll snapshot tick.
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});

	test("client AuthStorage.remove disables every broker-side credential for the provider (logout)", async () => {
		serverStore!.saveApiKey("kagi", "k1");
		serverStore!.saveOAuth("kagi", {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
			accountId: "acct-kagi",
			email: "user@example.com",
		});
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.remove("kagi");

		expect(serverStore!.listAuthCredentials("kagi")).toEqual([]);
		expect(clientStorage.get("kagi")).toBeUndefined();
		clientStorage.close();
	});
});
