import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-wave-a-probe";

function oauth(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage quota probe leases", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-probe-lease-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	async function seed(): Promise<{ idA: number; idB: number }> {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth("a"), oauth("b")]);
		const rows = storage.listStoredCredentials(PROVIDER);
		const idA = rows[0]?.id;
		const idB = rows[1]?.id;
		if (idA === undefined || idB === undefined) throw new Error("expected two credentials");
		return { idA, idB };
	}

	it("clears a hard cooldown only when a matching lease records 2xx", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		expect(storage.listCredentialBlocks([idA]).length).toBeGreaterThan(0);

		const lease = storage.tryAcquireQuotaProbeLease(idA, "");
		expect(typeof lease).toBe("string");
		expect(storage.recordQuotaProbeSuccess(idA, "", lease)).toBe(true);
		expect(storage.listCredentialBlocks([idA])).toEqual([]);
	});

	it("preserves the cooldown for an unleased 2xx", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		expect(storage.recordQuotaProbeSuccess(idA, "", null)).toBe(false);
		expect(storage.listCredentialBlocks([idA]).length).toBeGreaterThan(0);
	});

	it("rejects a stale lease after a newer 429 bumps generation", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		const stale = storage.tryAcquireQuotaProbeLease(idA, "");
		expect(typeof stale).toBe("string");
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		expect(storage.recordQuotaProbeSuccess(idA, "", stale)).toBe(false);
		expect(storage.listCredentialBlocks([idA]).length).toBeGreaterThan(0);
	});

	it("never grants a probe lease for Retry-After sourced blocks", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA, retryAfterMs: 60_000 });
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeNull();
	});

	it("allows a probe once a Retry-After wait has elapsed (negative forever-block)", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA, retryAfterMs: 0 });
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeTypeOf("string");
	});

	it("never grants a second live probe lease for the same credential+scope (single-flight)", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		const first = storage.tryAcquireQuotaProbeLease(idA, "");
		expect(typeof first).toBe("string");
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeNull();
		expect(storage.recordQuotaProbeSuccess(idA, "", first)).toBe(true);
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeTypeOf("string");
	});

	it("soft-avoids timeout/5xx without throwing as revoked (negative)", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		storage.noteTransientSoftAvoid(idA, "", Date.now() + 60_000);
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeNull();
		expect(storage.listStoredCredentials(PROVIDER).some(row => row.id === idA)).toBe(true);
	});

	it("clearQuotaProbe is a no-op for unknown request ids and frees nothing incorrectly", async () => {
		if (!storage) throw new Error("setup failed");
		const { idA } = await seed();
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: idA });
		const lease = storage.tryAcquireQuotaProbeLease(idA, "");
		expect(typeof lease).toBe("string");
		storage.clearQuotaProbe("never-acquired");
		// Lease still held (clear only touches request-keyed inflight entries).
		expect(storage.tryAcquireQuotaProbeLease(idA, "")).toBeNull();
		expect(storage.settleQuotaProbeSuccess("never-acquired")).toBe(false);
		expect(storage.recordQuotaProbeSuccess(idA, "", lease)).toBe(true);
	});

	it("reuses the request-owned probe lease on auth retry", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [oauth("solo")]);
		const id = storage.listStoredCredentials(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: id });
		const first = await storage.getApiKey(PROVIDER, "solo-session", { requestId: "probe-retry" });
		expect(first).toBe("access-solo");
		// Same request still holds the single-flight lease — a bare acquire must fail,
		// but re-entering getApiKey with the same requestId must reuse it.
		expect(storage.tryAcquireQuotaProbeLease(id, "")).toBeNull();
		const second = await storage.getApiKey(PROVIDER, "solo-session", { requestId: "probe-retry" });
		expect(second).toBe("access-solo");
	});

	it("prefers a healthy API-key sibling before leasing a blocked probe", async () => {
		if (!storage) throw new Error("setup failed");
		const apiProvider = `${PROVIDER}-api-keys`;
		await storage.set(apiProvider, [
			{ type: "api_key", key: "blocked-key" },
			{ type: "api_key", key: "healthy-key" },
		]);
		const rows = storage.listStoredCredentials(apiProvider);
		const blockedId = rows[0]?.id;
		if (blockedId === undefined) throw new Error("missing blocked credential");
		await storage.markUsageLimitReached(apiProvider, undefined, { credentialId: blockedId });
		const key = await storage.getApiKey(apiProvider, "sibling-session", { requestId: "prefer-healthy" });
		expect(key).toBe("healthy-key");
		// Healthy path must not consume a probe lease on the blocked sibling.
		expect(storage.tryAcquireQuotaProbeLease(blockedId, "")).toBeTypeOf("string");
	});

	it("leases an API-key probe under the ranking block scope", async () => {
		if (!storage) throw new Error("setup failed");
		const apiProvider = "openai-codex";
		await storage.set(apiProvider, [{ type: "api_key", key: "codex-key" }]);
		const id = storage.listStoredCredentials(apiProvider)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		await storage.markUsageLimitReached(apiProvider, undefined, {
			credentialId: id,
			modelId: "gpt-5.3-codex",
		});
		const key = await storage.getApiKey(apiProvider, "scoped-session", {
			requestId: "scoped-probe",
			modelId: "gpt-5.3-codex",
		});
		expect(key).toBe("codex-key");
		// Live lease is chat-scoped; a second chat acquire is denied while global stays free.
		expect(storage.tryAcquireQuotaProbeLease(id, "chat")).toBeNull();
		expect(storage.tryAcquireQuotaProbeLease(id, "")).toBeTypeOf("string");
	});
});
