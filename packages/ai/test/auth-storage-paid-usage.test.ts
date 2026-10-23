import { afterEach, describe, expect, it } from "bun:test";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { EXTRA_USAGE_BLOCK_SCOPE } from "../src/auth/blocks";

const PROVIDER = "anthropic";
const HOUR_MS = 60 * 60_000;
const storages: AuthStorage[] = [];

type LedgerEntry = { used: number; cap: number | null };

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function reportFor(accountId: string, entry: LedgerEntry, fetchedAt = Date.now()): UsageReport {
	const resetAt = new Date(fetchedAt + HOUR_MS).toISOString();
	const report = parseClaudeUsagePayload(
		{
			five_hour: { utilization: 100, resets_at: resetAt },
			seven_day: { utilization: 100, resets_at: resetAt },
			spend: {
				enabled: true,
				used: money(entry.used),
				limit: entry.cap === null ? null : money(entry.cap),
			},
		},
		{ accountId, email: `${accountId}@example.com` },
		undefined,
		fetchedAt,
	);
	if (!report) throw new Error("Expected Claude usage report");
	return report;
}

function usageProvider(ledger: ReadonlyMap<string, LedgerEntry>): UsageProvider {
	return {
		id: PROVIDER,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (accountId === undefined) return null;
			const entry = ledger.get(accountId);
			return entry === undefined ? null : reportFor(accountId, entry);
		},
	};
}

async function createStorage(args: {
	accounts: readonly string[];
	policies: AuthAccountPolicies;
	ledger: ReadonlyMap<string, LedgerEntry>;
}): Promise<AuthStorage> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
		accountPolicies: args.policies,
		usageProviderResolver: provider => (provider === PROVIDER ? usageProvider(args.ledger) : undefined),
	});
	await storage.credentials.set(
		PROVIDER,
		args.accounts.map(accountId => ({
			type: "oauth" as const,
			access: `access-${accountId}`,
			refresh: `refresh-${accountId}`,
			expires: Date.now() + HOUR_MS,
			accountId,
			email: `${accountId}@example.com`,
		})),
	);
	storages.push(storage);
	return storage;
}

function requireReports(reports: UsageReport[] | null): UsageReport[] {
	if (!reports) throw new Error("Expected usage reports");
	return reports;
}

afterEach(() => {
	for (const storage of storages) storage.close();
	storages.length = 0;
});

describe("AuthStorage usage.paidUsage", () => {
	it("stays aligned with reports and reads the matching credential policy", async () => {
		const storage = await createStorage({
			accounts: ["a", "b"],
			policies: [{ provider: PROVIDER, account: { accountId: "a" }, extraUsageFloor: 60 }],
			ledger: new Map([
				["a", { used: 50, cap: 100 }],
				["b", { used: 25, cap: 100 }],
			]),
		});
		const reports = requireReports(await storage.usage.reports());
		const views = storage.usage.paidUsage(reports, { nowMs: Date.now() });
		const aIndex = reports.findIndex(report => report.metadata?.accountId === "a");
		const bIndex = reports.findIndex(report => report.metadata?.accountId === "b");
		expect(views).toHaveLength(reports.length);
		expect(aIndex).toBeGreaterThanOrEqual(0);
		expect(bIndex).toBeGreaterThanOrEqual(0);
		expect(views[aIndex]).toMatchObject({ floor: 60, state: "past-floor", stop: "floor" });
		expect(views[bIndex]).toMatchObject({ state: "available" });
		expect(views[bIndex]?.floor).toBeUndefined();
	});

	it("shows a persisted exact paid-usage block as provider refusal", async () => {
		const storage = await createStorage({
			accounts: ["a"],
			policies: [],
			ledger: new Map([["a", { used: 50, cap: 100 }]]),
		});
		const account = storage.oauth.accounts(PROVIDER)[0];
		if (!account) throw new Error("Expected OAuth account");
		const nowMs = Date.now();
		const blockedUntilMs = nowMs + HOUR_MS;
		storage.blocks.upsert({
			credentialId: account.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: EXTRA_USAGE_BLOCK_SCOPE,
			blockedUntilMs,
		});
		const reports = requireReports(await storage.usage.reports());
		const view = storage.usage.paidUsage(reports, { nowMs })[0];
		expect(view).toMatchObject({ state: "unavailable", stop: "refused", blockedUntil: blockedUntilMs });
	});

	it("uses the first credential policy and latest exact block for a shared report", async () => {
		const storage = await createStorage({
			accounts: ["a", "b"],
			policies: [
				{ provider: PROVIDER, account: { accountId: "a" }, extraUsageFloor: 10 },
				{ provider: PROVIDER, account: { accountId: "b" }, extraUsageFloor: 80 },
			],
			ledger: new Map([
				["a", { used: 50, cap: 100 }],
				["b", { used: 50, cap: 100 }],
			]),
		});
		const accounts = storage.oauth.accounts(PROVIDER);
		const first = accounts[0];
		const second = accounts[1];
		if (!first || !second) throw new Error("Expected both OAuth accounts");
		const nowMs = Date.now();
		storage.blocks.upsert({
			credentialId: first.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: EXTRA_USAGE_BLOCK_SCOPE,
			blockedUntilMs: nowMs + HOUR_MS,
		});
		const latestBlockedUntil = nowMs + 2 * HOUR_MS;
		storage.blocks.upsert({
			credentialId: second.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: EXTRA_USAGE_BLOCK_SCOPE,
			blockedUntilMs: latestBlockedUntil,
		});
		const sharedReport = reportFor("shared", { used: 50, cap: 100 }, nowMs);
		sharedReport.metadata = { payloadFetchedAt: nowMs };
		const view = storage.usage.paidUsage([sharedReport], { nowMs })[0];
		expect(view).toMatchObject({
			floor: 10,
			state: "unavailable",
			stop: "refused",
			blockedUntil: latestBlockedUntil,
		});
	});

	it("falls back to report identity policy without applying an unrelated credential block", async () => {
		const storage = await createStorage({
			accounts: ["stored"],
			policies: [
				{ provider: PROVIDER, account: { accountId: "stored" }, extraUsageFloor: 10 },
				{ provider: PROVIDER, account: { accountId: "unattributed" }, extraUsageFloor: 60 },
			],
			ledger: new Map([["stored", { used: 50, cap: 100 }]]),
		});
		const account = storage.oauth.accounts(PROVIDER)[0];
		if (!account) throw new Error("Expected OAuth account");
		const nowMs = Date.now();
		storage.blocks.upsert({
			credentialId: account.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: EXTRA_USAGE_BLOCK_SCOPE,
			blockedUntilMs: nowMs + HOUR_MS,
		});
		const report = reportFor("unattributed", { used: 50, cap: 100 }, nowMs);
		const view = storage.usage.paidUsage([report], { nowMs })[0];
		expect(view).toMatchObject({ floor: 60, state: "past-floor", stop: "floor" });
		expect(view?.blockedUntil).toBeUndefined();
	});

	it("returns an empty aligned result for no reports", async () => {
		const storage = await createStorage({ accounts: [], policies: [], ledger: new Map() });
		expect(storage.usage.paidUsage([])).toEqual([]);
	});
});
