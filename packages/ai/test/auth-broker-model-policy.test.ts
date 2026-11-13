import { test, expect, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const MODEL_ID = "claude-mythos-5-2";
const MODEL_SCOPE = `model-policy:${MODEL_ID}`;
const PROVIDER_KEY = "anthropic:oauth";

function credential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `sk-ant-oat-account-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 24 * 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

test("broker clients rotate an Anthropic model 404 without blocking the account for other models", async () => {
	await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-model-policy-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const brokerStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		const clients: AuthBrokerClient[] = [];
		const clientStorages: AuthStorage[] = [];
		const remoteStores: RemoteAuthCredentialStore[] = [];
		let broker: AuthBrokerServerHandle | undefined;
		const token = "model-policy-test-broker";

		async function connect(): Promise<AuthStorage> {
			if (!broker) throw new Error("broker not started");
			const client = new AuthBrokerClient({ url: broker.url, token });
			clients.push(client);
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("initial broker snapshot unavailable");
			const remote = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});
			remoteStores.push(remote);
			const storage = new AuthStorage(remote, { usageProviderResolver: () => undefined });
			clientStorages.push(storage);
			await storage.credentials.reload();
			return storage;
		}

		try {
			await brokerStorage.credentials.set("anthropic", [credential("a"), credential("b")]);
			broker = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [token],
				disableRefresher: true,
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
				const current = credentials[provider];
				return current ? { apiKey: current.access, newCredentials: current } : null;
			});
			const denied = store.listAuthCredentials("anthropic")[0];
			if (!denied) throw new Error("denied credential missing");
			const storage = await connect();
			const sessionId = "anthropic-model-denial";
			expect(storage.sessions.pin("anthropic", sessionId, denied.id)).toBe(true);
			const first = await storage.keys.get("anthropic", sessionId, { modelId: MODEL_ID });
			expect(first).toBe("sk-ant-oat-account-a");
			const blockWrites = vi.spyOn(clients[0]!, "upsertCredentialBlock");
			const error = AIError.attach(
				new AIError.ProviderHttpError(
					'404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-mythos-5-2"},"request_id":"req_test"}',
					404,
				),
				AIError.create(AIError.Flag.AccountPolicy),
			);

			expect(
				(await storage.limits.rotate("anthropic", sessionId, { error, modelId: MODEL_ID, apiKey: first })).switched,
			).toBe(true);
			expect(await storage.keys.get("anthropic", sessionId, { modelId: MODEL_ID })).toBe("sk-ant-oat-account-b");

			// Await the real HTTP writes before inspecting the broker's durable store.
			await Promise.all(blockWrites.mock.results.map(result => result.value));
			expect([...store.getCredentialBlockScopes(denied.id, PROVIDER_KEY).keys()]).toEqual([MODEL_SCOPE]);
			expect(store.getCredentialBlock(denied.id, PROVIDER_KEY, MODEL_SCOPE)).toBeGreaterThan(Date.now());

			const fresh = await connect();
			expect(fresh.sessions.pin("anthropic", "fresh-denied-model", denied.id)).toBe(true);
			expect(await fresh.keys.get("anthropic", "fresh-denied-model", { modelId: MODEL_ID })).toBe(
				"sk-ant-oat-account-b",
			);
			expect(fresh.sessions.pin("anthropic", "fresh-opus-model", denied.id)).toBe(true);
			expect(await fresh.keys.get("anthropic", "fresh-opus-model", { modelId: "claude-opus-4-6" })).toBe(
				"sk-ant-oat-account-a",
			);
		} finally {
			vi.restoreAllMocks();
			for (const storage of clientStorages) storage.close();
			for (const remote of remoteStores) remote.close();
			await broker?.close();
			brokerStorage.close();
			store.close();
			await removeWithRetries(tempDir);
		}
	});
});
