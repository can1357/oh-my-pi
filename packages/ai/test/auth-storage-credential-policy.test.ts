import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-credential-policy-test";

async function withStorage(run: (auth: AuthStorage, store: SqliteAuthCredentialStore) => Promise<void>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-policy-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
	try {
		await run(new AuthStorage(store), store);
	} finally {
		store.close();
		await removeWithRetries(dir);
	}
}

describe("AuthStorage credential login policy", () => {
	afterEach(() => unregisterOAuthProviders(SOURCE_ID));

	it.each([
		["kiro", ["new-key"]], // declares login-replaces-credentials
		["test-credential-policy", ["old-key", "new-key"]],
	])("login into %s leaves keys %j", async (provider, expected) => {
		const def = getProviderDefinition(provider);
		const spy = def && spyOn(def, "login").mockResolvedValue("new-key");
		if (!def)
			registerOAuthProvider({ id: provider, name: provider, sourceId: SOURCE_ID, login: async () => "new-key" });
		try {
			await withStorage(async (auth, store) => {
				await auth.credentials.set(provider, { type: "api_key", key: "old-key" });
				await auth.oauth.login(provider, { onAuth: () => {}, onPrompt: async () => "" });
				const keys = store.listAuthCredentials(provider).map(({ credential: c }) => c.type === "api_key" && c.key);
				expect(keys).toEqual(expected);
			});
		} finally {
			spy?.mockRestore();
		}
	});

	it("redacts refresh secrets from generic remote snapshots while keeping Kiro client binding", async () => {
		await withStorage(async auth => {
			await auth.credentials.set("kiro", {
				type: "oauth",
				access: "access-token",
				refresh: "real-refresh-token",
				expires: Date.now() + 60_000,
				kiroClientId: "client-id",
				kiroClientSecret: "real-client-secret",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
			const credential = auth.credentials.snapshot().credentials.find(e => e.provider === "kiro")?.credential;
			expect(credential).toMatchObject({
				refresh: "__remote__",
				kiroClientId: "client-id",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
			expect(credential).not.toHaveProperty("kiroClientSecret", "real-client-secret");
		});
	});
});
