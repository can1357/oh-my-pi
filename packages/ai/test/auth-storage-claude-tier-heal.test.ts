/**
 * Anthropic tier self-heal regression (issue #10978). A Fable/Mythos 429 writes
 * a scoped `tier:` credential block whose deadline follows the advertised weekly
 * reset. When a later live usage report shows the tier back at `status: ok`, the
 * stale block must clear via {@link claudeRankingStrategy.healableBlockScopes}
 * instead of pinning the account to a fallback model until the clock runs out.
 *
 * Each tier is judged on its own weekly row: a recovered Fable block clears
 * while a still-exhausted Mythos block on the same credential survives.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const STALE_BLOCK_GUARD_MS = 5 * 60_000 + 1;

/** Age persisted block rows past the post-429 probe guard so healing may run. */
function ageCredentialBlockRows(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE auth_credential_blocks SET updated_at = ?").run(
			Math.floor((Date.now() - STALE_BLOCK_GUARD_MS) / 1000),
		);
	} finally {
		db.close();
	}
}

function tierLimit(tier: "fable" | "mythos", usedFraction: number, resetInMs: number): UsageLimit {
	const used = Math.min(Math.max(usedFraction, 0), 1);
	return {
		id: `anthropic:7d:${tier}`,
		label: `Claude 7 Day (${tier})`,
		scope: { provider: "anthropic", windowId: "7d", tier },
		window: { id: "7d", label: "7 Day", resetsAt: Date.now() + resetInMs },
		amount: { unit: "percent", used: used * 100, limit: 100, usedFraction: used },
		status: used >= 1 ? "exhausted" : "ok",
	};
}

function sharedLimit(windowId: "5h" | "7d", usedFraction: number): UsageLimit {
	return {
		id: `anthropic:${windowId}`,
		label: windowId === "5h" ? "Claude 5 Hour" : "Claude 7 Day",
		scope: { provider: "anthropic", windowId, shared: true },
		window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "7 Day" },
		amount: { unit: "percent", used: usedFraction * 100, limit: 100, usedFraction },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function claudeReport(accountId: string, email: string, tiers: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [sharedLimit("5h", 0.18), sharedLimit("7d", 0.12), ...tiers],
		metadata: { accountId, email },
	};
}

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email,
	};
}

let tempDir = "";
let dbPath = "";
let store: AuthCredentialStore | null = null;
let authStorage: AuthStorage | null = null;
const usageByAccount = new Map<string, UsageReport>();

const usageProvider: UsageProvider = {
	id: "anthropic",
	async fetchUsage(params) {
		const accountId = params.credential.accountId;
		if (!accountId) return null;
		return usageByAccount.get(accountId) ?? null;
	},
};

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-claude-heal-"));
	dbPath = path.join(tempDir, "agent.db");
	store = await SqliteAuthCredentialStore.open(dbPath);
	authStorage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
	});
	usageByAccount.clear();
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
		const credential = credentials.anthropic as OAuthCredentials | undefined;
		if (!credential?.accountId) return null;
		return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
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

test("a recovered Fable usage report clears its stale tier block without touching a still-exhausted Mythos block", async () => {
	if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
		throw new Error("test setup failed");
	}

	await authStorage.set("anthropic", [{ type: "oauth", ...createCredential("acct-1", "user@example.com") }]);
	const row = store.listAuthCredentials("anthropic")[0];
	if (!row) throw new Error("expected credential row");

	// Both scopes were blocked by a 429 whose retry-after pointed at the
	// advertised weekly reset, days ahead of the real recovery.
	const weekAhead = Date.now() + WEEK_MS;
	store.upsertCredentialBlock({
		credentialId: row.id,
		providerKey: "anthropic:oauth",
		blockScope: "tier:fable",
		blockedUntilMs: weekAhead,
	});
	store.upsertCredentialBlock({
		credentialId: row.id,
		providerKey: "anthropic:oauth",
		blockScope: "tier:mythos",
		blockedUntilMs: weekAhead,
	});
	ageCredentialBlockRows(dbPath);
	store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);

	// Fable is back to ok; Mythos is still pinned at the cap.
	usageByAccount.set(
		"acct-1",
		claudeReport("acct-1", "user@example.com", [tierLimit("fable", 0.04, WEEK_MS), tierLimit("mythos", 1, WEEK_MS)]),
	);

	await authStorage.fetchUsageReports();

	expect(store.getCredentialBlock(row.id, "anthropic:oauth", "tier:fable")).toBeUndefined();
	expect(store.getCredentialBlock(row.id, "anthropic:oauth", "tier:mythos")).toBe(weekAhead);

	// The recovered Fable scope is selectable again instead of falling back to
	// another model; the per-scope store assertions above prove the still-exhausted
	// Mythos block was left intact.
	expect(await authStorage.getApiKey("anthropic", "session-fable", { modelId: "claude-fable-5" })).toBe("api-acct-1");
});
