import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-restrict";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage session account restrictions", () => {
	let tempDir = "";
	let stores: SqliteAuthCredentialStore[] = [];
	let storage: AuthStorage;
	/** Access tokens the OAuth exchange was asked to serve, in order. */
	let exchanged: string[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		stores = [store];
		storage = new AuthStorage(store);
		exchanged = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (credential) exchanged.push(credential.access);
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores) store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("serves only allowed accounts, over inherited and explicit pins", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(storage.sessions.inherit("parent", "child")).toBe(1);

		storage.sessions.restrict(PROVIDER, "child", ["account:acc-c"]);

		expect(storage.oauth.identity(PROVIDER, "child")?.accountId).toBe("acc-c");
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		expect(storage.sessions.pin(PROVIDER, "child", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		// Excluded accounts are never ranked, refreshed, or exchanged for the child.
		expect(exchanged).toEqual(["access-c", "access-c"]);
		// The parent keeps its own pin; restrictions are per session.
		expect(await storage.keys.get(PROVIDER, "parent")).toBe("access-b");
	});

	test("skips a runtime key and stored API keys, and fails closed past a config key", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), { type: "api_key", key: "stored-key" }]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");

		storage.sessions.restrict(PROVIDER, "allowed", ["account:acc-a"]);
		const missing = storage.sessions.restrict(PROVIDER, "missing", ["account:acc-z"]);
		storage.sessions.restrict(PROVIDER, "empty", []);

		expect(await storage.keys.get(PROVIDER, "allowed")).toBe("access-a");
		// Metadata, usage attribution, and OAuth-access callers (web search) follow
		// the account the request uses, not the runtime key.
		expect(storage.oauth.identity(PROVIDER, "allowed")?.accountId).toBe("acc-a");
		expect((await storage.oauth.access(PROVIDER, "allowed"))?.accessToken).toBe("access-a");
		for (const sessionId of ["missing", "empty"]) {
			await expect(storage.keys.get(PROVIDER, sessionId)).rejects.toThrow(
				`No API key for provider: ${PROVIDER} (session ${sessionId} is restricted to its OAuth account pool`,
			);
		}
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");

		// The owner lifts a restriction when its session ends.
		storage.sessions.unrestrict(PROVIDER, "missing", missing);
		expect(await storage.keys.get(PROVIDER, "missing")).toBe("runtime-key");

		// A config key marks the provider's endpoint (often a proxy) as taking that
		// key: the pooled session fails rather than sending it an OAuth token.
		storage.keys.setConfig(PROVIDER, "config-key");
		await expect(storage.keys.get(PROVIDER, "allowed")).rejects.toThrow("pooled OAuth tokens are never sent past it");
		expect(await storage.oauth.access(PROVIDER, "allowed")).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER, "allowed")).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");
	});

	test("lifts a restriction only with the lease that installed it", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const stale = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		// A revived owner restricts the same session id again.
		const current = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);

		storage.sessions.unrestrict(PROVIDER, "session", stale);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");

		storage.sessions.unrestrict(PROVIDER, "session", current);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-key");
	});

	test("rotates only among allowed accounts", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);

		const allowedKeys = ["access-a", "access-b"];
		const first = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(first ?? "");
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(true);
		const second = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(second ?? "");
		expect(second).not.toBe(first);

		// Account c is free, but outside the pool: no sibling is left to switch to,
		// and the last-resort pass retries a blocked allowed account instead.
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(false);
		expect(allowedKeys).toContain((await storage.keys.get(PROVIDER, "session")) ?? "");
	});

	test("permits only allowed accounts for a restricted session", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		const lease = storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);

		expect(storage.sessions.permits(PROVIDER, "session", accountA.credentialId)).toBe(true);
		expect(storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(false);
		expect(storage.sessions.permits(PROVIDER, "unrestricted", accountB.credentialId)).toBe(true);

		storage.sessions.unrestrict(PROVIDER, "session", lease);
		expect(storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(true);
	});

	test("keeps restrictions across a credential store replacement", async () => {
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await storage.replaceStore(replacement);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		expect(storage.sessions.pin(PROVIDER, "session", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
	});
});
