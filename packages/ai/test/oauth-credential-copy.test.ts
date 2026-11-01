/**
 * What an extension RETURNS is live until the host has copied it.
 *
 * A credential record an author hands back is author code as much as a property it exposes: its
 * fields may be getters, and the host persists what it reads from them. Read field by field
 * afterwards, one getter answered differently each time and the host stored a record assembled
 * from several answers — an organization's id beside another organization's region, and the
 * region selects the API host. So the record is copied by its schema inside the owning session's
 * admission, once, and every record built afterwards reads only the copy.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

const PROVIDER = "credential-copy-provider";
const SOURCE = "credential-copy-scratch";

const sessionScope = new AsyncLocalStorage<object>();
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface SessionGate extends ProviderCallGate {
	retired: boolean;
	readonly inside: boolean;
}

/** A session's gate as the host builds one: its admission is an async context. */
function sessionGate(): SessionGate {
	const session = {};
	const gate: SessionGate = {
		retired: false,
		get inside() {
			return sessionScope.getStore() === session;
		},
		run(call) {
			if (gate.retired) throw new Error("Extension session retired");
			return sessionScope.run(session, call);
		},
	};
	return gate;
}

async function storage(): Promise<AuthStorage> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	// No refresh lease, so a refresh runs inline rather than through a leaseholder.
	Object.assign(store, { tryAcquireCredentialRefreshLease: undefined });
	const auth = new AuthStorage(store);
	cleanups.push(() => {
		unregisterOAuthProviders(SOURCE);
		store.close();
	});
	await auth.credentials.reload();
	return auth;
}

/** A credential whose `access` answers once inside the call and differently afterwards. */
function oneShotAccess(gate: SessionGate, rest: string): OAuthCredentials {
	let reads = 0;
	const credentials = {
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		get access(): string {
			reads++;
			return reads === 1 && gate.inside ? "authored-access" : rest;
		},
	};
	return credentials as OAuthCredentials;
}

describe("credentials an extension returns", () => {
	test("login stores what the author answered inside admission, not a later read", async () => {
		const gate = sessionGate();
		const auth = await storage();
		registerOAuthProvider(
			{
				name: "Credential copy",
				login: async () => oneShotAccess(gate, "substitute-access"),
			} as never,
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);

		await auth.oauth.login(PROVIDER, { onAuth: () => undefined, onPrompt: async () => "" });
		gate.retired = true;

		const stored = auth.credentials.getOAuth(PROVIDER);
		expect(stored?.access).toBe("authored-access");
	});

	test("a refreshed record is one answer, not one per field", async () => {
		const gate = sessionGate();
		const auth = await storage();
		// The shape that persisted a mixed record: `orgId` read three times, answering a
		// different organization each time, while `region` came from the first.
		let orgReads = 0;
		const refreshed = {
			access: "refreshed-access",
			refresh: "refreshed-refresh",
			expires: Date.now() + 3_600_000,
			region: "eu-old",
			get orgId(): string {
				orgReads++;
				return orgReads % 2 === 1 ? "org-b" : "org-a";
			},
		};
		registerOAuthProvider(
			{
				name: "Credential copy",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000, orgId: "org-a" }),
				refreshToken: async () => refreshed as OAuthCredentials,
			} as never,
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);

		// An expired credential, so the host's next key resolution refreshes it.
		await auth.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "refresh", expires: Date.now() - 1_000, orgId: "org-a" },
		]);
		await auth.keys.get(PROVIDER, "credential-copy-session").catch(() => undefined);

		const stored = auth.credentials.getOAuth(PROVIDER);
		// One read of the returned record, so the id and the region that reached storage are the
		// pair the author answered with — never org-a's region beside org-b's id.
		expect(orgReads).toBe(1);
		expect({ orgId: stored?.orgId, region: stored?.region }).toEqual({ orgId: "org-b", region: "eu-old" });
	});

	test("a function where credential data belongs is refused with its field named", async () => {
		const gate = sessionGate();
		const auth = await storage();
		registerOAuthProvider(
			{
				name: "Credential copy",
				login: async () => ({ refresh: "r", expires: 1, access: () => "token" }) as never,
			} as never,
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);

		await expect(auth.oauth.login(PROVIDER, { onAuth: () => undefined, onPrompt: async () => "" })).rejects.toThrow(
			/returned a function for "access"/,
		);
	});
});
