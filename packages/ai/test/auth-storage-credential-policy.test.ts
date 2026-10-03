import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
} from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-credential-policy-test";
const PROVIDER_ID = "test-credential-policy";

function oauthFields(suffix: string): OAuthCredentials {
	return {
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage credential login policy", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;
	let loginResult: OAuthCredentials | string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-policy-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		loginResult = "unused";
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "Credential policy test provider",
			sourceId: SOURCE_ID,
			login: async () => loginResult,
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("set() replaces the whole provider pool", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER_ID, [
			{ type: "api_key", key: "old-key" },
			{ type: "api_key", key: "other-old-key" },
		]);
		expect(store.listAuthCredentials(PROVIDER_ID)).toHaveLength(2);

		await authStorage.credentials.set(PROVIDER_ID, [{ type: "api_key", key: "new-key" }]);

		expect(store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "new-key" },
		]);
	});

	it("appends OAuth credentials while retaining the selected profile identity", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER_ID, [
			{ type: "oauth", ...oauthFields("first") },
			{ type: "oauth", ...oauthFields("second") },
		]);
		loginResult = {
			...oauthFields("selected"),
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		};

		const identity = await authStorage.oauth.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(identity).toMatchObject({
			type: "oauth",
			accountId: "account-selected",
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		});
		const credentials = store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential);
		expect(credentials).toHaveLength(3);
		expect(credentials[2]).toMatchObject({
			type: "oauth",
			access: "access-selected",
			refresh: "refresh-selected",
			orgId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/selected",
			orgName: "Selected profile",
		});
	});

	it("forwards OAuth controls and reports no identity for an empty login", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let prompted = "";
		const progress: string[] = [];
		let sawSignal = false;
		let sawFetch = false;
		unregisterOAuthProviders(SOURCE_ID);
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "OAuth controls test provider",
			sourceId: SOURCE_ID,
			login: async (callbacks: OAuthLoginCallbacks) => {
				sawSignal = callbacks.signal !== undefined;
				sawFetch = callbacks.fetch !== undefined;
				callbacks.onProgress?.("working...");
				const answer = await callbacks.onPrompt({ message: "Choose a test option" });
				prompted = answer;
				return "";
			},
		});

		const controller = new AbortController();
		const fetchImpl = async () => new Response("{}", { status: 200 });
		const identity = await authStorage.oauth.login(PROVIDER_ID, {
			onAuth: (_info: OAuthAuthInfo) => {},
			onProgress: (message: string) => progress.push(message),
			onPrompt: async (_prompt: OAuthPrompt) => "one",
			signal: controller.signal,
			fetch: fetchImpl,
		});

		expect(identity).toBeUndefined();
		expect(progress).toEqual(["working..."]);
		expect(prompted).toBe("one");
		expect(sawSignal).toBe(true);
		expect(sawFetch).toBe(true);
		expect(store.listAuthCredentials(PROVIDER_ID)).toEqual([]);
	});

	it("redacts refresh tokens from generic remote snapshots while keeping Kiro client binding", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.credentials.set("kiro", {
			type: "oauth",
			access: "access-token",
			refresh: "real-refresh-token",
			expires: Date.now() + 60_000,
			kiroClientId: "client-id",
			kiroClientSecret: "real-client-secret",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			kiroOidcRegion: "us-east-1",
		});

		const snapshot = authStorage.credentials.snapshot();
		const credential = snapshot.credentials.find(entry => entry.provider === "kiro")?.credential;
		expect(credential).toMatchObject({ refresh: "__remote__" });
		expect(credential).not.toHaveProperty("refresh", "real-refresh-token");
		expect(credential).toMatchObject({
			kiroClientId: "client-id",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		});
		// The OIDC client secret is refresh-capable: it must not reach broker
		// clients even though the non-secret binding is retained for routing.
		expect(credential).not.toHaveProperty("kiroClientSecret", "real-client-secret");
	});

	it("keeps append as the default for api_key login", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		unregisterOAuthProviders(SOURCE_ID);
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "Credential policy append provider",
			sourceId: SOURCE_ID,
			login: async () => "new-key",
		});
		await authStorage.credentials.set(PROVIDER_ID, { type: "api_key", key: "old-key" });

		await authStorage.oauth.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(store.listAuthCredentials(PROVIDER_ID).map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "old-key" },
			{ type: "api_key", key: "new-key", source: "login" },
		]);
	});
});
