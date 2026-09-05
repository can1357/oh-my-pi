import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { applyInferenceHeaders } from "@oh-my-pi/pi-ai/providers/inference-headers";
import { buildSessionMetadata } from "@oh-my-pi/pi-coding-agent/session/session-metadata";
import { sideRequestIdentity } from "@oh-my-pi/pi-coding-agent/session/side-request-identity";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read the `metadata.user_id` JSON envelope without an unchecked cast. */
function readUserId(metadata: Record<string, unknown>): { session_id: string; account_uuid?: string } {
	const raw = metadata.user_id;
	if (typeof raw !== "string") throw new Error("expected metadata.user_id string");
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") throw new Error("expected user_id object");
	if (!("session_id" in parsed) || typeof parsed.session_id !== "string") {
		throw new Error("expected user_id.session_id");
	}
	const accountUuid =
		"account_uuid" in parsed && typeof parsed.account_uuid === "string" ? parsed.account_uuid : undefined;
	return { session_id: parsed.session_id, account_uuid: accountUuid };
}

function twoAccountStorage(): AuthStorage {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	store.saveOAuth("anthropic", {
		access: "account-a-token",
		refresh: "account-a-refresh",
		expires: Date.now() + 60_000,
		accountId: "account-a",
	});
	store.saveOAuth("anthropic", {
		access: "account-b-token",
		refresh: "account-b-refresh",
		expires: Date.now() + 60_000,
		accountId: "account-b",
	});
	return new AuthStorage(store);
}

describe("side-request identity (issue #10865)", () => {
	it("mints a fresh, foreground-distinct id for every logical request", () => {
		const foreground = "provider-session-foreground";
		const a = sideRequestIdentity(undefined, foreground).sessionId;
		const b = sideRequestIdentity(undefined, foreground).sessionId;

		// UUID-shaped so it is indistinguishable from a real provider session id.
		expect(a).toMatch(UUID_RE);
		// Never the foreground id: a background request must not order under it.
		expect(a).not.toBe(foreground);
		// Distinct per call: two same-kind requests that overlap (e.g. concurrent
		// rollout-memory jobs) never advance one another.
		expect(b).not.toBe(a);
	});

	it("isolates the metadata ordering identity from the foreground session", () => {
		const foreground = "provider-session-foreground";
		const identity = sideRequestIdentity(undefined, foreground);
		const sideSessionId = readUserId(identity.metadata("anthropic")).session_id;
		const foregroundSessionId = readUserId(buildSessionMetadata(foreground, "anthropic", undefined)).session_id;

		// The provider orders on metadata.user_id.session_id; the side request must
		// carry a different one so it cannot advance the foreground provider session.
		expect(sideSessionId).toBe(identity.sessionId);
		expect(sideSessionId).not.toBe(foregroundSessionId);
	});

	it("projects the isolated identity into final Anthropic metadata and session header", () => {
		const foreground = "provider-session-foreground";
		using identity = sideRequestIdentity(undefined, foreground, "anthropic");
		const headers: Record<string, string> = {};
		applyInferenceHeaders(headers, {
			provider: "anthropic",
			protocol: "anthropic",
			sessionId: identity.sessionId,
		});

		expect(headers["X-Claude-Code-Session-Id"]).toBe(identity.sessionId);
		expect(headers["X-Claude-Code-Session-Id"]).not.toBe(foreground);
		const userId = readUserId(identity.metadata("anthropic"));
		expect(userId.session_id).toBe(identity.sessionId);
		expect(userId.session_id).not.toBe(foreground);
	});

	it("seeds the foreground's active OAuth account while isolating the session id", async () => {
		const storage = twoAccountStorage();
		try {
			await storage.reload();
			storage.clearConfigApiKeys();
			const foreground = "provider-session-foreground";
			const accountB = storage.listOAuthAccounts("anthropic").find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("expected account-b credential");
			// Foreground turn resolved onto account-b.
			expect(storage.pinSessionOAuthAccount("anthropic", foreground, accountB.credentialId)).toBe(true);

			const identity = sideRequestIdentity(storage, foreground);
			const sideMeta = readUserId(identity.metadata("anthropic"));
			const foregroundMeta = readUserId(buildSessionMetadata(foreground, "anthropic", storage));

			// Same account (attribution/billing preserved)...
			expect(sideMeta.account_uuid).toBe("account-b");
			expect(sideMeta.account_uuid).toBe(foregroundMeta.account_uuid);
			// ...but a distinct ordering identity (the isolation).
			expect(sideMeta.session_id).toBe(identity.sessionId);
			expect(sideMeta.session_id).not.toBe(foregroundMeta.session_id);
			// The isolated session now resolves to the same account for auth.
			expect(storage.getOAuthAccountId("anthropic", identity.sessionId)).toBe("account-b");
		} finally {
			storage.close();
		}
	});

	it("seeds the foreground account at construction, before the credential is resolved", async () => {
		const storage = twoAccountStorage();
		try {
			await storage.reload();
			storage.clearConfigApiKeys();
			const foreground = "provider-session-foreground";
			const accountB = storage.listOAuthAccounts("anthropic").find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("expected account-b credential");
			expect(storage.pinSessionOAuthAccount("anthropic", foreground, accountB.credentialId)).toBe(true);

			// Passing the provider seeds affinity now, so a later getApiKey reuses the
			// foreground account instead of hash-ranking to another (#10869). Assert it
			// before any metadata() call — the seed must not depend on metadata.
			using identity = sideRequestIdentity(storage, foreground, "anthropic");
			expect(storage.getOAuthAccountId("anthropic", identity.sessionId)).toBe("account-b");
		} finally {
			storage.close();
		}
	});

	it("attributes metadata to the account resolved for the session, not the first account", async () => {
		const storage = twoAccountStorage();
		try {
			await storage.reload();
			storage.clearConfigApiKeys();
			const foreground = "provider-session-foreground";
			const accounts = storage.listOAuthAccounts("anthropic");
			const accountB = accounts.find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("expected account-b credential");
			// No foreground pin: seeding is a no-op, so account_uuid would fall back to
			// the first stored account (account-a) if metadata were built too early.
			using identity = sideRequestIdentity(storage, foreground, "anthropic");
			// getApiKey selects/pins account-b for this session (here simulated by the pin
			// getApiKey records). Metadata built afterwards must reflect that bearer.
			expect(storage.pinSessionOAuthAccount("anthropic", identity.sessionId, accountB.credentialId)).toBe(true);
			expect(readUserId(identity.metadata("anthropic")).account_uuid).toBe("account-b");
		} finally {
			storage.close();
		}
	});

	it("releases ephemeral credential affinity after the request scope exits", async () => {
		const storage = twoAccountStorage();
		try {
			await storage.reload();
			storage.clearConfigApiKeys();
			const foreground = "provider-session-foreground";
			const accountB = storage.listOAuthAccounts("anthropic").find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("expected account-b credential");
			expect(storage.pinSessionOAuthAccount("anthropic", foreground, accountB.credentialId)).toBe(true);

			let isolatedSessionId = "";
			{
				using identity = sideRequestIdentity(storage, foreground);
				isolatedSessionId = identity.sessionId;
				identity.metadata("anthropic");
				expect(storage.getOAuthAccountId("anthropic", isolatedSessionId)).toBe("account-b");
			}

			// Both the in-memory affinity and its persistent session_sticky row are
			// gone: re-reading the isolated session does not restore an active account.
			expect(storage.listOAuthAccounts("anthropic", isolatedSessionId).some(account => account.active)).toBe(false);
			expect(storage.getOAuthAccountId("anthropic", foreground)).toBe("account-b");
		} finally {
			storage.close();
		}
	});

	it("preserves credential rotation instead of re-pinning the seeded account", async () => {
		const storage = twoAccountStorage();
		try {
			await storage.reload();
			storage.clearConfigApiKeys();
			const foreground = "provider-session-foreground";
			const accounts = storage.listOAuthAccounts("anthropic");
			const accountA = accounts.find(account => account.accountId === "account-a");
			const accountB = accounts.find(account => account.accountId === "account-b");
			if (!accountA || !accountB) throw new Error("expected both accounts");
			// Foreground resolved onto account-a.
			expect(storage.pinSessionOAuthAccount("anthropic", foreground, accountA.credentialId)).toBe(true);

			const identity = sideRequestIdentity(storage, foreground);
			// First metadata call seeds the isolated session with the foreground's A.
			expect(readUserId(identity.metadata("anthropic")).account_uuid).toBe("account-a");

			// Credential resolution then rotates this isolated session to B (as
			// getApiKey does when A is blocked/exhausted).
			expect(storage.pinSessionOAuthAccount("anthropic", identity.sessionId, accountB.credentialId)).toBe(true);

			// A later metadata build must reflect the rotation, not force back to A.
			expect(readUserId(identity.metadata("anthropic")).account_uuid).toBe("account-b");
		} finally {
			storage.close();
		}
	});
});
