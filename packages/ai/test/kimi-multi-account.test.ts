import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function createCredential(accountId: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
	};
}

function createUsageReport(accountId: string, fiveHourUsed: number, weeklyUsed: number): UsageReport {
	const now = Date.now();
	const limits: UsageLimit[] = [
		{
			id: "kimi-code:7d",
			label: "7d limit",
			scope: { provider: "kimi-code", accountId, windowId: "7d", shared: true },
			window: { id: "7d", label: "7d limit", durationMs: WEEK_MS, resetsAt: now + WEEK_MS },
			amount: {
				unit: "percent",
				usedFraction: weeklyUsed,
				remainingFraction: 1 - weeklyUsed,
			},
			status: weeklyUsed >= 1 ? "exhausted" : weeklyUsed >= 0.9 ? "warning" : "ok",
		},
		{
			id: "kimi-code:5h",
			label: "5h limit",
			scope: { provider: "kimi-code", accountId, windowId: "5h", shared: true },
			window: { id: "5h", label: "5h limit", durationMs: 5 * HOUR_MS, resetsAt: now + 5 * HOUR_MS },
			amount: {
				unit: "percent",
				usedFraction: fiveHourUsed,
				remainingFraction: 1 - fiveHourUsed,
			},
			status: fiveHourUsed >= 1 ? "exhausted" : fiveHourUsed >= 0.9 ? "warning" : "ok",
		},
	];
	return { provider: "kimi-code", fetchedAt: now, limits, metadata: { accountId } };
}

describe("AuthStorage Kimi OAuth ranking", () => {
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
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-kimi-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "kimi-code" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["kimi-code"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return { apiKey: credential.access, newCredentials: credential };
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

	test("new sessions choose the Kimi account with more 5h and 7d headroom", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("kimi-code", [
			{ type: "oauth", ...createCredential("loaded") },
			{ type: "oauth", ...createCredential("fresh") },
		]);
		usageByAccount.set("loaded", createUsageReport("loaded", 0.92, 0.8));
		usageByAccount.set("fresh", createUsageReport("fresh", 0.01, 0.02));

		const selected = new Set<string>();
		for (let index = 0; index < 20; index += 1) {
			const apiKey = await authStorage.getApiKey("kimi-code", `kimi-ranking-${index}`);
			if (apiKey) selected.add(apiKey);
		}

		expect(selected).toEqual(new Set(["access-fresh"]));
	});

	test("usage-limit blocks last until the exhausted Kimi window resets", async () => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");
		await authStorage.set("kimi-code", [
			{ type: "oauth", ...createCredential("exhausted") },
			{ type: "oauth", ...createCredential("sibling") },
		]);
		const exhaustedReport = createUsageReport("exhausted", 1, 0.7);
		usageByAccount.set("exhausted", exhaustedReport);
		usageByAccount.set("sibling", createUsageReport("sibling", 0, 0));
		const exhaustedRow = store.listAuthCredentials("kimi-code").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "exhausted";
		});
		if (!exhaustedRow) throw new Error("expected exhausted Kimi credential");

		const result = await authStorage.markUsageLimitReached("kimi-code", undefined, {
			credentialId: exhaustedRow.id,
		});

		expect(result.switched).toBe(true);
		const resetAt = exhaustedReport.limits.find(limit => limit.window?.id === "5h")?.window?.resetsAt;
		expect(store.getCredentialBlock(exhaustedRow.id, "kimi-code:oauth", "")).toBe(resetAt);
	});
});

describe("Kimi OAuth account identity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("keeps the JWT user id across token refresh", async () => {
		const accessToken = `header.${Buffer.from(JSON.stringify({ user_id: "kimi-user-42", sub: "kimi-user-42" })).toString("base64url")}.signature`;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () =>
					new Response(
						JSON.stringify({
							access_token: accessToken,
							refresh_token: "refresh-1",
							expires_in: 60 * 60,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				{ preconnect: fetch.preconnect },
			),
		);

		const refreshToken = getProviderDefinition("kimi-code")?.refreshToken;
		if (!refreshToken) throw new Error("expected kimi-code refresh");
		const refreshed = await refreshToken({ access: "access-0", refresh: "refresh-0", expires: 0 });

		expect(refreshed.accountId).toBe("kimi-user-42");
	});
});
