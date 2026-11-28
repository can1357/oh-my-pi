import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthBrokerUnservedProviderError,
	HybridAuthCredentialStore,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const TOKEN = "test-bearer";
const UNSERVED = "test-unserved-oauth";
const SOURCE = "auth-broker-local-providers-test";
const loginCallbacks = { onAuth: () => {}, onPrompt: async () => "", onProgress: () => {} };

describe("logins an auth broker stores but does not serve", () => {
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore;
	let brokerStorage: AuthStorage;
	let handle: AuthBrokerServerHandle;

	/** Make the broker persist `UNSERVED` rows but leave them out of every snapshot, as a broker that pauses it does. */
	const stopServing = () => {
		const pool = brokerStorage.credentials;
		const snapshot = pool.snapshot.bind(pool);
		return vi.spyOn(pool, "snapshot").mockImplementation(() => {
			const served = snapshot();
			return { ...served, credentials: served.credentials.filter(entry => entry.provider !== UNSERVED) };
		});
	};

	const brokerClientStore = async () => {
		const client = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("broker returned no snapshot");
		return new RemoteAuthCredentialStore({ client, initialSnapshot: snapshot.snapshot, streamSnapshots: false });
	};

	/** A client process: broker store plus this machine's agent.db, as discovery opens it. */
	const openClient = async () => {
		const storage = new AuthStorage(
			new HybridAuthCredentialStore({
				broker: await brokerClientStore(),
				local: await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")),
			}),
		);
		await storage.credentials.reload();
		return storage;
	};

	const readAgentDb = async (provider: string) => {
		const agentDb = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			return agentDb.listAuthCredentials(provider).map(row => row.credential);
		} finally {
			agentDb.close();
		}
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-local-providers-"));
		brokerStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		brokerStorage = new AuthStorage(brokerStore);
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
		await handle.close();
		brokerStorage.close();
		await removeWithRetries(tempDir);
	});

	test("a broker-only client fails the upload instead of reporting a login that vanishes", async () => {
		stopServing();
		const remote = await brokerClientStore();
		try {
			await expect(
				remote.upsertAuthCredential(UNSERVED, {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
				}),
			).rejects.toBeInstanceOf(AuthBrokerUnservedProviderError);
			expect(remote.listAuthCredentials(UNSERVED)).toEqual([]);
		} finally {
			remote.close();
		}
	});

	test("the login is kept in agent.db, survives a restart, and refreshes locally", async () => {
		const refreshToken = vi.fn(async (_credentials: { refresh: string }) => ({
			access: "access-2",
			refresh: "refresh-2",
			expires: Date.now() + 3_600_000,
		}));
		registerOAuthProvider({
			id: UNSERVED,
			name: "Unserved test login",
			sourceId: SOURCE,
			// Already expired, so the first request after the restart must refresh.
			login: async () => ({ access: "access-1", refresh: "refresh-1", expires: Date.now() - 1, email: "me@x.io" }),
			refreshToken,
		});
		await brokerStorage.credentials.set("anthropic", [{ type: "api_key", key: "sk-broker" }]);
		stopServing();

		const first = await openClient();
		await first.oauth.login(UNSERVED, loginCallbacks);
		first.close();

		const restarted = await openClient();
		try {
			expect(await restarted.keys.get(UNSERVED)).toBe("access-2");
			expect(refreshToken).toHaveBeenCalledTimes(1);
			expect(refreshToken.mock.calls[0]?.[0]).toMatchObject({ refresh: "refresh-1" });
			expect(await restarted.keys.get("anthropic")).toBe("sk-broker");
		} finally {
			restarted.close();
		}
		expect(await readAgentDb(UNSERVED)).toEqual([
			expect.objectContaining({ type: "oauth", access: "access-2", refresh: "refresh-2", email: "me@x.io" }),
		]);
	});

	test("a full snapshot hides broker rows for empty local routes and adopts a peer's next route", async () => {
		await brokerStorage.credentials.upsert("fixture-empty", { type: "api_key", key: "remote" });
		const dbPath = path.join(tempDir, "agent.db");
		const writer = await SqliteAuthCredentialStore.open(dbPath, { encrypt: false });
		const device = "fixture-device";
		writer.markBrokerLocalProvider("fixture-empty");
		writer.markBrokerLocalProvider(device);
		await writer.saveApiKey(device, "local-device");
		const store = new HybridAuthCredentialStore({
			broker: await brokerClientStore(),
			local: await SqliteAuthCredentialStore.open(dbPath, { encrypt: false }),
		});
		try {
			const initial = store.listAuthCredentials();
			expect(initial.map(row => row.provider)).toEqual([device]);
			expect(initial[0]!.id).toBeLessThan(0);
			expect(store.listAuthCredentials("fixture-empty")).toEqual([]);

			writer.markBrokerLocalProvider("fixture-peer");
			await writer.saveApiKey("fixture-peer", "local-peer");
			expect(store.pollExternalChanges()).toBe(true);
			expect(store.listAuthCredentials().map(row => row.provider)).toEqual([device, "fixture-peer"]);
			expect(store.pollExternalChanges()).toBe(false);
		} finally {
			store.close();
			writer.close();
		}
	});

	test("logging out of the last local login sends the next login back to the broker", async () => {
		registerOAuthProvider({
			id: UNSERVED,
			name: "Unserved test login",
			sourceId: SOURCE,
			login: async () => ({
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "me@x.io",
			}),
		});
		const serving = stopServing();
		const client = await openClient();
		try {
			await client.oauth.login(UNSERVED, loginCallbacks);
			await client.credentials.remove(UNSERVED);

			// The broker serves the provider again (e.g. it was upgraded).
			serving.mockRestore();
			await client.oauth.login(UNSERVED, loginCallbacks);
			expect(client.credentials.list(UNSERVED)).toHaveLength(1);
		} finally {
			client.close();
		}
		// Served, yet not from agent.db: the broker holds it.
		expect(await readAgentDb(UNSERVED)).toEqual([]);
	});
});
