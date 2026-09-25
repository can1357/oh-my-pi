import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import * as oauth from "../src/registry/oauth";

const provider = "unit-anonymous-review";
let dir: string;
let store: SqliteAuthCredentialStore;
let storage: AuthStorage;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "anonymous-probe-review-"));
	store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	vi.spyOn(oauth, "getOAuthProvider").mockReturnValue({
		id: provider,
		name: "Fixture",
		login: async () => "unused",
		refreshToken: async credentials => credentials,
		getApiKey: credentials => credentials.access,
	});
	await storage.set(provider, [
		{ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 },
	]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	store.close();
	await fs.rm(dir, { recursive: true, force: true });
});

it("keeps an anonymous recovery probe pending and exclusive until inference succeeds", async () => {
	const id = storage.listStoredCredentials(provider)[0]!.id;
	await storage.markUsageLimitReached(provider, undefined, { credentialId: id });
	expect(await storage.getApiKey(provider, "one")).toBe("fixture-access");
	expect(storage.listCredentialBlocks([id])).toHaveLength(1);
	expect(await storage.getApiKey(provider, "two")).toBeUndefined();
	expect(storage.settleAnonymousQuotaProbe(id, "")).toBe(true);
	expect(storage.listCredentialBlocks([id])).toEqual([]);
});
