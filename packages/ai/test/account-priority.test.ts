import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

function createCredential(accountId: string, email?: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email: email ?? `${accountId}@example.com`,
	};
}

function createUsageReport(provider: string, accountId: string, usedFraction: number): UsageReport {
	const now = Date.now();
	const limits: UsageLimit[] = [
		{
			id: "5h",
			label: "5h Limit",
			scope: { provider, accountId },
			amount: {
				usedFraction,
				used: Math.round(usedFraction * 100),
				limit: 100,
				unit: "percent",
			},
			window: {
				id: "5h",
				label: "5 Hours",
				durationMs: 5 * HOUR_MS,
				resetsAt: now + HOUR_MS,
			},
			status: usedFraction >= 1 ? "exhausted" : "ok",
		},
	];
	return { provider, fetchedAt: now, limits, metadata: { accountId } };
}

describe("AuthStorage account priority", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();
	const usageProvider: UsageProvider = {
		id: "kimi-code",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			return accountId ? (usageByAccount.get(accountId) ?? null) : null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-priority-test-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "kimi-code" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const cred = Object.values(credentials)[0] as OAuthCredentials | undefined;
			if (!cred) return null;
			return { apiKey: cred.access, newCredentials: cred };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("respects explicit account priority order over insertion order", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("account-1", "first@example.com") },
			{ type: "oauth", ...createCredential("account-2", "second@example.com") },
		]);

		// Without priority set, first insertion or hash is used
		authStorage.setAccountPriority("test-provider", ["second@example.com", "first@example.com"]);

		const apiKey = await authStorage.getApiKey("test-provider", "session-1");
		expect(apiKey).toBe("access-account-2");

		const apiKey2 = await authStorage.getApiKey("test-provider", "session-2");
		expect(apiKey2).toBe("access-account-2");
	});

	test("account priority resolver in options is honored", async () => {
		if (!store) throw new Error("test setup failed");
		const customStorage = new AuthStorage(store, {
			accountPriorityResolver: provider => (provider === "test-provider" ? ["second@example.com"] : undefined),
		});

		await customStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("account-1", "first@example.com") },
			{ type: "oauth", ...createCredential("account-2", "second@example.com") },
		]);

		const apiKey = await customStorage.getApiKey("test-provider", "session-abc");
		expect(apiKey).toBe("access-account-2");
	});

	test("strict priority outranks dynamic usage headroom", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("kimi-code", [
			{ type: "oauth", ...createCredential("heavy", "heavy@example.com") },
			{ type: "oauth", ...createCredential("light", "light@example.com") },
		]);

		// Heavy has 60% used, light has 5% used
		usageByAccount.set("heavy", createUsageReport("kimi-code", "heavy", 0.6));
		usageByAccount.set("light", createUsageReport("kimi-code", "light", 0.05));

		// Set priority to heavy first
		authStorage.setAccountPriority("kimi-code", ["heavy@example.com", "light@example.com"]);

		// Even though light has far more headroom, heavy is selected due to strict priority
		const apiKey = await authStorage.getApiKey("kimi-code", "session-priority");
		expect(apiKey).toBe("access-heavy");
	});

	test("fails over to next priority account when higher priority is blocked", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("primary", "primary@example.com") },
			{ type: "oauth", ...createCredential("backup", "backup@example.com") },
		]);

		authStorage.setAccountPriority("test-provider", ["primary@example.com", "backup@example.com"]);

		const rows = store.listAuthCredentials("test-provider");
		const primaryRow = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "primary");
		if (!primaryRow) throw new Error("expected primary row");

		// Initially primary is picked
		expect(await authStorage.getApiKey("test-provider", "session-x")).toBe("access-primary");

		// Rotate / mark primary blocked
		await authStorage.rotateSessionCredential("test-provider", "session-x", {
			credentialId: primaryRow.id,
			error: new Error("rate limit reached: 429"),
		});

		// Now backup is picked
		expect(await authStorage.getApiKey("test-provider", "session-x")).toBe("access-backup");
	});

	test("listOAuthAccounts populates 1-based priority", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("a", "a@example.com") },
			{ type: "oauth", ...createCredential("b", "b@example.com") },
			{ type: "oauth", ...createCredential("c", "c@example.com") },
		]);

		authStorage.setAccountPriority("test-provider", ["b@example.com", "a@example.com"]);

		const accounts = authStorage.listOAuthAccounts("test-provider");
		const acctA = accounts.find(a => a.email === "a@example.com");
		const acctB = accounts.find(a => a.email === "b@example.com");
		const acctC = accounts.find(a => a.email === "c@example.com");

		expect(acctB?.priority).toBe(1);
		expect(acctA?.priority).toBe(2);
		expect(acctC?.priority).toBeUndefined();
	});

	test("matches priority by index and account ID", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("acct-1", "first@example.com") },
			{ type: "oauth", ...createCredential("acct-2", "second@example.com") },
		]);

		// Match by 1-based index "2"
		authStorage.setAccountPriority("test-provider", ["2", "1"]);
		expect(await authStorage.getApiKey("test-provider", "s1")).toBe("access-acct-2");

		// Match by accountId "acct-1"
		authStorage.setAccountPriority("test-provider", ["acct-1"]);
		expect(await authStorage.getApiKey("test-provider", "s2")).toBe("access-acct-1");
	});

	test("configured priority overrides existing session assignment upon order change", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("test-provider", [
			{ type: "oauth", ...createCredential("account-a", "a@example.com") },
			{ type: "oauth", ...createCredential("account-b", "b@example.com") },
		]);

		// Initially resolves to account A
		const key1 = await authStorage.getApiKey("test-provider", "same-session");
		expect(key1).toBe("access-account-a");

		// Change priority to B -> A
		authStorage.setAccountPriority("test-provider", ["b@example.com", "a@example.com"]);

		// Same session must now resolve to account B
		const key2 = await authStorage.getApiKey("test-provider", "same-session");
		expect(key2).toBe("access-account-b");
	});

	test("supports multi-org accounts sharing the same email without collapsing priorities", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-org-personal",
				refresh: "refresh-1",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-1",
				email: "same@example.com",
				orgId: "org-personal",
			},
			{
				type: "oauth",
				access: "access-org-team",
				refresh: "refresh-2",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-2",
				email: "same@example.com",
				orgId: "org-team",
			},
		]);

		const rows = store.listAuthCredentials("anthropic");
		const personalRow = rows.find(
			r => r.credential.type === "oauth" && "orgId" in r.credential && r.credential.orgId === "org-personal",
		);
		const teamRow = rows.find(
			r => r.credential.type === "oauth" && "orgId" in r.credential && r.credential.orgId === "org-team",
		);
		if (!personalRow || !teamRow) throw new Error("expected both rows");

		// Prioritize team over personal via id:<credentialId>
		authStorage.setAccountPriority("anthropic", [`id:${teamRow.id}`, `id:${personalRow.id}`]);

		const accounts = authStorage.listOAuthAccounts("anthropic");
		const personalAcct = accounts.find(a => a.credentialId === personalRow.id);
		const teamAcct = accounts.find(a => a.credentialId === teamRow.id);

		expect(teamAcct?.priority).toBe(1);
		expect(personalAcct?.priority).toBe(2);

		const apiKey = await authStorage.getApiKey("anthropic", "session-org-test");
		expect(apiKey).toBe("access-org-team");
	});
});
