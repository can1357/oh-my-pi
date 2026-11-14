import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const TOKEN = "auth-broker-usage-probe-bearer";
const INVALID_GRANT =
	'anthropic token refresh failed: 400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}';

describe("auth broker usage-probe refresh", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let client: AuthBrokerClient;
	let credentialId = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-usage-probe-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		await store.saveOAuth("anthropic", {
			access: "oat-broker",
			refresh: "refresh-broker",
			expires: Date.now() + 30_000,
			accountId: "account-broker",
			email: "broker@example.com",
		});
		credentialId = store.listAuthCredentials("anthropic")[0]!.id;
		storage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				throw new Error(INVALID_GRANT);
			},
		});
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
		client = new AuthBrokerClient({ url: handle.url, token: TOKEN });
	});

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("keeps the broker row when a client usage probe's refresh gets invalid_grant", async () => {
		await expect(client.refreshCredential(credentialId, undefined, "usage-probe")).rejects.toThrow("500");
		expect(store!.listAuthCredentials("anthropic").map(row => row.id)).toEqual([credentialId]);
	});
});
