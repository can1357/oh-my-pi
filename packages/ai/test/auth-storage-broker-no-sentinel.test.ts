import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

describe("AuthStorage broker sentinel refresh", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;
	let brokerRefreshCalls = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-no-sentinel-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		brokerRefreshCalls = 0;
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				brokerRefreshCalls += 1;
				expect(credentialId).toBe(1);
				expect(credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
				return {
					access: "broker-access-rotated",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: Date.now() + 60 * 60_000,
					accountId: "broker-account",
					email: "broker@example.com",
					projectId: "broker-project",
				};
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("getOAuthAccess refreshes expired broker credentials through the store hook only", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "broker-access-stale",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: Date.now() - 60_000,
				accountId: "broker-account-old",
			},
		]);

		const providerRefresh = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("provider-direct refresh must not be called");
		});

		const access = await authStorage.getOAuthAccess("anthropic", "broker-session");

		expect(access).toEqual({
			accessToken: "broker-access-rotated",
			credentialId: expect.any(Number),
			accountId: "broker-account",
			email: "broker@example.com",
			projectId: "broker-project",
			enterpriseUrl: undefined,
		});
		expect(brokerRefreshCalls).toBe(1);
		expect(providerRefresh).not.toHaveBeenCalled();
		const persisted = store.listAuthCredentials("anthropic");
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.credential.type).toBe("oauth");
		if (persisted[0]?.credential.type === "oauth") {
			expect(persisted[0].credential.access).toBe("broker-access-rotated");
			expect(persisted[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
	});

	test("getOAuthApiKey refuses expired broker sentinels instead of provider-direct refresh", async () => {
		const providerRefresh = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("provider-direct refresh must not be called");
		});

		await expect(
			oauthUtils.getOAuthApiKey("anthropic", {
				anthropic: {
					access: "broker-access-stale",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: Date.now() - 60_000,
				},
			}),
		).rejects.toThrow("must be refreshed via AuthStorage");
		expect(providerRefresh).not.toHaveBeenCalled();
	});
});
