import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
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
		vi.restoreAllMocks();
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
	it("recovers a fully blocked API-key pool with exclusive probes and clears only successful probes", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-a" },
			{ type: "api_key", key: "key-b" },
		]);
		const ids = storage.listStoredCredentials(PROVIDER).map(row => row.id);
		for (const credentialId of ids) await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId });
		const first = await storage.getApiKey(PROVIDER, "one", { requestId: "probe-one" });
		expect(first === "key-a" || first === "key-b").toBe(true);
		const second = await storage.getApiKey(PROVIDER, "two", { requestId: "probe-two" });
		expect(second === "key-a" || second === "key-b").toBe(true);
		expect(second).not.toBe(first);
		expect(await storage.getApiKey(PROVIDER, "three", { requestId: "probe-three" })).toBeUndefined();
		expect(storage.listCredentialBlocks(ids)).toHaveLength(2);
		storage.settleQuotaProbeSuccess("probe-one");
		expect(storage.listCredentialBlocks(ids)).toHaveLength(1);
	});

	it("does not probe a fully blocked API-key pool before Retry-After expires", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-a" },
			{ type: "api_key", key: "key-b" },
		]);
		for (const row of storage.listStoredCredentials(PROVIDER))
			await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: row.id, retryAfterMs: 60_000 });
		expect(await storage.getApiKey(PROVIDER, "one", { requestId: "timed-probe" })).toBeUndefined();
	});

	it("leases the global OAuth block for a request with a narrower model scope", async () => {
		if (!store) throw new Error("setup failed");
		storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => ({
				findWindowLimits: () => ({}),
				blockScope: context => (context?.modelId ? `model:${context.modelId}` : undefined),
				windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
			}),
		});
		vi.spyOn(oauthUtils, "getOAuthProvider").mockReturnValue({
			id: PROVIDER,
			name: "Fixture",
			login: async () => oauth("a"),
			refreshToken: async credential => credential,
			getApiKey: credential => credential.access,
		});
		await storage.set(PROVIDER, [oauth("a")]);
		const id = storage.listStoredCredentials(PROVIDER)[0]!.id;
		await storage.markUsageLimitReached(PROVIDER, undefined, { credentialId: id });
		expect(await storage.getApiKey(PROVIDER, "scoped", { modelId: "model", requestId: "global-probe" })).toBe(
			"access-a",
		);
		expect(storage.listCredentialBlocks([id])).toHaveLength(1);
		storage.settleQuotaProbeSuccess("global-probe");
		expect(storage.listCredentialBlocks([id])).toEqual([]);
	});
});
