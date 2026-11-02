import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { guard, trackTestLifetime, vi } from "../../coding-agent/test/helpers/test-lifetime";

const { test, beforeEach, afterEach } = trackTestLifetime();

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
	/** Per-test fixtures, published only through a guard: a body that resumes after its test ended throws at its first touch. */
	const state = guard({
		tempDir: "",
		stores: [] as SqliteAuthCredentialStore[],
		storage: undefined as unknown as AuthStorage,
		/** Access tokens the OAuth exchange was asked to serve, in order. */
		exchanged: [] as string[],
	});

	beforeEach(async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const exchanged: string[] = [];
		state.tempDir = tempDir;
		state.stores = [store];
		state.storage = new AuthStorage(store);
		state.exchanged = exchanged;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (credential) state.exchanged.push(credential.access);
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of state.stores) store.close();
		await fs.rm(state.tempDir, { recursive: true, force: true });
	});

	test("serves only allowed accounts, over inherited and explicit pins", async () => {
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = state.storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(state.storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(state.storage.sessions.inherit("parent", "child")).toBe(1);

		state.storage.sessions.restrict(PROVIDER, "child", ["account:acc-c"]);

		expect(state.storage.oauth.identity(PROVIDER, "child")?.accountId).toBe("acc-c");
		expect(await state.storage.keys.get(PROVIDER, "child")).toBe("access-c");
		expect(state.storage.sessions.pin(PROVIDER, "child", accountA.credentialId)).toBe(false);
		expect(await state.storage.keys.get(PROVIDER, "child")).toBe("access-c");
		// Excluded accounts are never ranked, refreshed, or exchanged for the child.
		expect(state.exchanged).toEqual(["access-c", "access-c"]);
		// The parent keeps its own pin; restrictions are per session.
		expect(await state.storage.keys.get(PROVIDER, "parent")).toBe("access-b");
	});

	test("skips a runtime key and stored API keys, and fails closed past a config key", async () => {
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), { type: "api_key", key: "stored-key" }]);
		state.storage.keys.setRuntime(PROVIDER, "runtime-key");

		state.storage.sessions.restrict(PROVIDER, "allowed", ["account:acc-a"]);
		const missing = state.storage.sessions.restrict(PROVIDER, "missing", ["account:acc-z"]);
		state.storage.sessions.restrict(PROVIDER, "empty", []);

		expect(await state.storage.keys.get(PROVIDER, "allowed")).toBe("access-a");
		// Metadata, usage attribution, and OAuth-access callers (web search) follow
		// the account the request uses, not the runtime key.
		expect(state.storage.oauth.identity(PROVIDER, "allowed")?.accountId).toBe("acc-a");
		expect((await state.storage.oauth.access(PROVIDER, "allowed"))?.accessToken).toBe("access-a");
		for (const sessionId of ["missing", "empty"]) {
			await expect(state.storage.keys.get(PROVIDER, sessionId)).rejects.toThrow(
				`No API key for provider: ${PROVIDER} (session ${sessionId} is restricted to its OAuth account pool`,
			);
		}
		expect(await state.storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");

		// The owner lifts a restriction when its session ends.
		state.storage.sessions.unrestrict(PROVIDER, "missing", missing);
		expect(await state.storage.keys.get(PROVIDER, "missing")).toBe("runtime-key");

		// A config key marks the provider's endpoint (often a proxy) as taking that
		// key: the pooled session fails rather than sending it an OAuth token.
		state.storage.keys.setConfig(PROVIDER, "config-key");
		await expect(state.storage.keys.get(PROVIDER, "allowed")).rejects.toThrow(
			"pooled OAuth tokens are never sent past it",
		);
		expect(await state.storage.oauth.access(PROVIDER, "allowed")).toBeUndefined();
		expect(state.storage.oauth.identity(PROVIDER, "allowed")).toBeUndefined();
		expect(await state.storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");
	});

	test("lifts a restriction only with the lease that installed it", async () => {
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		state.storage.keys.setRuntime(PROVIDER, "runtime-key");
		const stale = state.storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		// A revived owner restricts the same session id again.
		const current = state.storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);

		state.storage.sessions.unrestrict(PROVIDER, "session", stale);
		expect(await state.storage.keys.get(PROVIDER, "session")).toBe("access-b");

		state.storage.sessions.unrestrict(PROVIDER, "session", current);
		expect(await state.storage.keys.get(PROVIDER, "session")).toBe("runtime-key");
	});

	test("rotates only among allowed accounts", async () => {
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		state.storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);

		const allowedKeys = ["access-a", "access-b"];
		const first = await state.storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(first ?? "");
		expect((await state.storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(
			true,
		);
		const second = await state.storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(second ?? "");
		expect(second).not.toBe(first);

		// Account c is free, but outside the pool: no sibling is left to switch to,
		// and the last-resort pass retries a blocked allowed account instead.
		expect((await state.storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(
			false,
		);
		expect(allowedKeys).toContain((await state.storage.keys.get(PROVIDER, "session")) ?? "");
	});

	test("permits only allowed accounts for a restricted session", async () => {
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = state.storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		const lease = state.storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);

		expect(state.storage.sessions.permits(PROVIDER, "session", accountA.credentialId)).toBe(true);
		expect(state.storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(false);
		expect(state.storage.sessions.permits(PROVIDER, "unrestricted", accountB.credentialId)).toBe(true);

		state.storage.sessions.unrestrict(PROVIDER, "session", lease);
		expect(state.storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(true);
	});

	test("keeps restrictions across a credential store replacement", async () => {
		state.storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const replacement = await SqliteAuthCredentialStore.open(path.join(state.tempDir, "replacement.db"));
		state.stores.push(replacement);
		await state.storage.replaceStore(replacement);
		await state.storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = state.storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		expect(state.storage.sessions.pin(PROVIDER, "session", accountA.credentialId)).toBe(false);
		expect(await state.storage.keys.get(PROVIDER, "session")).toBe("access-b");
	});
});
