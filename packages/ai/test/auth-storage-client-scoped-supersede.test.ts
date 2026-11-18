/**
 * Signing in again with OpenAI ChatGPT token sharing.
 *
 * Each sign-in registers a new OAuth client, so an account that is already saved
 * would otherwise appear twice and its allowance would be counted twice. A fresh
 * registration of the same account (id and email) replaces the saved one; another
 * workspace of the same user, or another person, is a different account and stays.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

function saved(args: { client: string; accountId: string; email?: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.client}`,
		refresh: `refresh-${args.client}`,
		expires: Date.now() + 60_000,
		oauthClientId: args.client,
		accountId: args.accountId,
		...(args.email ? { email: args.email } : {}),
	};
}

describe("openai sign-in over saved ChatGPT accounts", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		storage = new AuthStorage(store);
	});

	afterEach(() => {
		store.close();
	});

	async function signInAs(fresh: OAuthCredentials) {
		const definition = getProviderDefinition("openai");
		if (!definition) throw new Error("openai provider is unavailable");
		const login = spyOn(definition, "login").mockResolvedValue(fresh);
		try {
			return await storage.oauth.login("openai", { onAuth: () => {}, onPrompt: async () => "" });
		} finally {
			login.mockRestore();
		}
	}

	it("replaces the saved registration of the same account instead of keeping both", async () => {
		await store.upsertAuthCredential("openai", saved({ client: "client_old", accountId: "acct_1", email: "a@x.io" }));
		await store.upsertAuthCredential(
			"openai",
			saved({ client: "client_other", accountId: "acct_2", email: "b@x.io" }),
		);
		await storage.credentials.reload();

		const identity = await signInAs({
			access: "access-new",
			refresh: "refresh-new",
			expires: Date.now() + 60_000,
			oauthClientId: "client_new",
			accountId: "acct_1",
			email: "a@x.io",
		});

		expect(identity).toMatchObject({ type: "oauth", email: "a@x.io", replacedConnections: 1 });
		const rows = store.listAuthCredentials("openai").map(entry => entry.credential);
		expect(rows.map(row => (row.type === "oauth" ? [row.oauthClientId, row.accountId] : [])).sort()).toEqual([
			["client_new", "acct_1"],
			["client_other", "acct_2"],
		]);
	});

	it("keeps the saved registration when the same user signs in to another workspace", async () => {
		await store.upsertAuthCredential(
			"openai",
			saved({ client: "client_old", accountId: "acct_ws_1", email: "a@x.io" }),
		);
		await storage.credentials.reload();

		const identity = await signInAs({
			access: "access-new",
			refresh: "refresh-new",
			expires: Date.now() + 60_000,
			oauthClientId: "client_new",
			accountId: "acct_ws_2",
			email: "a@x.io",
		});

		expect(identity?.replacedConnections).toBeUndefined();
		expect(store.listAuthCredentials("openai")).toHaveLength(2);
	});

	it("keeps a saved registration when neither sign-in has an email to tell teammates of one workspace apart", async () => {
		await store.upsertAuthCredential("openai", saved({ client: "client_old", accountId: "acct_ws_1" }));
		await storage.credentials.reload();

		const identity = await signInAs({
			access: "access-new",
			refresh: "refresh-new",
			expires: Date.now() + 60_000,
			oauthClientId: "client_new",
			accountId: "acct_ws_1",
		});

		expect(identity?.replacedConnections).toBeUndefined();
		expect(store.listAuthCredentials("openai")).toHaveLength(2);
	});
});
