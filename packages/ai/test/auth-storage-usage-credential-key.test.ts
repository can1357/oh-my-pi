/**
 * A provider whose reports carry NO account, email, project or organization
 * identity — `synthetic`, `charm-hyper` — also uses fixed limit ids, so every
 * one of its credentials renders an identical Prometheus label set and the
 * exposition drops all but the first as a duplicate. AuthStorage stamps a
 * stable, non-secret per-credential discriminator on exactly those reports.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function apiKeyRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = { type: "api_key", key: `sk-${id}` };
	return { id, provider: "synthetic", credential, disabledCause: null };
}

function xaiOauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `xai-access-${id}`,
		refresh: `xai-refresh-${id}`,
		expires: Date.now() + 3_600_000,
	};
	return { id, provider: "xai-oauth", credential, disabledCause: null };
}

/** An identity-less report: fixed limit id, no account/email/project/org. */
function identitylessReport(): UsageReport {
	return {
		provider: "synthetic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "synthetic:monthly",
				label: "Monthly",
				scope: { provider: "synthetic", windowId: "monthly" },
				amount: { usedFraction: 0.25, unit: "percent" },
			},
		],
		metadata: { endpoint: "https://example.invalid/quotas" },
	};
}

function stubProvider(build: () => UsageReport): UsageProvider {
	return {
		id: "synthetic",
		fetchUsage: async () => build(),
	} as UsageProvider;
}

describe("AuthStorage identity-less usage reports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stamps a distinct credential key on each identity-less credential's report", async () => {
		const storage = new AuthStorage(makeStore([apiKeyRow(11), apiKeyRow(12)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(identitylessReport) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			const keys = synthetic.map(report => report.metadata?.credentialKey);

			// RED (pre-fix): no stamp, so both reports were byte-identical and the
			// renderer collapsed them into one series.
			expect(new Set(keys).size).toBe(2);
			expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
		} finally {
			storage.close();
		}
	}, 20_000);

	it("leaves a report that carries its own identity unstamped", async () => {
		const withAccount = (): UsageReport => ({ ...identitylessReport(), metadata: { accountId: "acct-real" } });
		const storage = new AuthStorage(makeStore([apiKeyRow(11)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(withAccount) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			expect(synthetic).toHaveLength(1);
			// The stamp must never re-key a series that can already be attributed.
			expect(synthetic[0].metadata?.credentialKey).toBeUndefined();
		} finally {
			storage.close();
		}
	}, 20_000);

	it("stamps a conflicting-scope report that also carries a projectId", async () => {
		// A report whose limits carry DIFFERENT `scope.accountId` values has no
		// single account label. The metrics renderer's `accountLabelOf` treats
		// that conflict as terminal and refuses the `metadata.projectId` fallback,
		// so both such reports render `account="unidentified"` — but only if they
		// were stamped. `#reportHasNoIdentity` used to see the `projectId` and
		// return false FIRST, leaving the conflicting-scope report unstamped, so
		// two of them collapsed to one series and the renderer dropped the later
		// credential's gauges. The conflict must be detected before the weaker
		// projectId fallback so the stamp is applied whenever the conflict exists.
		const conflictingReport = (): UsageReport => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: ["acct-x", "acct-y"].map(accountId => ({
				id: `openai-codex:${accountId}`,
				label: "Weekly",
				scope: { provider: "openai-codex", accountId },
				amount: { usedFraction: 0.2, unit: "percent" },
			})),
			metadata: { projectId: "proj-shared" },
		});
		const codexRow = (id: number): StoredAuthCredential => ({
			id,
			provider: "openai-codex",
			credential: { type: "api_key", key: `sk-${id}` },
			disabledCause: null,
		});
		const storage = new AuthStorage(makeStore([codexRow(31), codexRow(32)]), {
			usageProviderResolver: provider =>
				provider === "openai-codex"
					? ({ id: "openai-codex", fetchUsage: async () => conflictingReport() } as UsageProvider)
					: undefined,
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const codex = reports.filter(report => report.provider === "openai-codex");
			const keys = codex.map(report => report.metadata?.credentialKey);

			// RED (pre-fix): the projectId short-circuited #reportHasNoIdentity, so
			// neither report was stamped and both were byte-identical.
			expect(codex).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
		} finally {
			storage.close();
		}
	}, 20_000);

	it("keeps two stamped generic-provider reports apart despite a shared projectId", async () => {
		// A GENERIC provider (not anthropic/openai-codex, so this exercises the
		// general identifier path). Two credentials whose reports carry CONFLICTING
		// `scope.accountId` values but the SAME `metadata.projectId`. The conflict
		// makes `#reportHasNoIdentity` true, so each report is stamped with a
		// distinct `credentialKey`. But `#getUsageReportIdentifiers`'s general path
		// grouped BOTH by the weaker shared `project:proj-shared`, and
		// `#mergeUsageReportGroup` kept only one `credentialKey` — folding the two
		// stamped identities into one report the renderer then labels as a single
		// series. The openai-codex regression above cannot catch this: the codex
		// SPECIAL branch ignores `projectId` and returns early before the general
		// path runs. The stamp must be honored before the projectId fallback.
		const conflictingReport = (): UsageReport => ({
			provider: "synthetic",
			fetchedAt: Date.now(),
			limits: ["acct-x", "acct-y"].map(accountId => ({
				id: `synthetic:${accountId}`,
				label: "Weekly",
				scope: { provider: "synthetic", accountId },
				amount: { usedFraction: 0.2, unit: "percent" },
			})),
			metadata: { projectId: "proj-shared" },
		});
		const storage = new AuthStorage(makeStore([apiKeyRow(51), apiKeyRow(52)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(conflictingReport) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			const keys = synthetic.map(report => report.metadata?.credentialKey);

			// RED (pre-fix): both grouped by `synthetic:project:proj-shared`, merged
			// to one report, so `synthetic` had length 1 and one surviving key.
			expect(synthetic).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
		} finally {
			storage.close();
		}
	}, 20_000);

	it("stamps different-account shared-limit reports so their series stay distinct", async () => {
		// `scope.shared` marks a limit as credential-wide for exhaustion gating —
		// most quota providers set it — NOT that two DIFFERENT credentials observe
		// the SAME pool. synthetic marks BOTH its limits shared (a 5h request
		// window and a 7d credit window), yet each API key may belong to a
		// different account, and the endpoint carries no account identity to prove
		// otherwise. Two such reports are byte-identical, so without a per-credential
		// stamp they collapse in the renderer and the later account is silently
		// dropped. Suppressing the stamp merely because every limit is shared
		// reintroduces exactly that loss, so the stamp must survive an all-shared
		// report.
		const sharedLimitsReport = (): UsageReport => ({
			provider: "synthetic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "synthetic:requests:5h",
					label: "Synthetic Requests",
					scope: { provider: "synthetic", windowId: "5h", shared: true },
					amount: { usedFraction: 0.25, unit: "requests" },
				},
				{
					id: "synthetic:usd:7d",
					label: "Synthetic Credits",
					scope: { provider: "synthetic", windowId: "7d", shared: true },
					amount: { usedFraction: 0.5, unit: "usd" },
				},
			],
			metadata: { endpoint: "https://example.invalid/quotas" },
		});
		const storage = new AuthStorage(makeStore([apiKeyRow(41), apiKeyRow(42)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(sharedLimitsReport) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			const keys = synthetic.map(report => report.metadata?.credentialKey);

			// GREEN: each all-shared identity-less report is still stamped, so the
			// two accounts render distinct series.
			// RED (over-corrected tip): the all-shared predicate suppressed the
			// stamp, both reports were byte-identical, and the renderer collapsed
			// them — dropping the second account.
			expect(synthetic).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
		} finally {
			storage.close();
		}
	}, 20_000);

	it("stamps stored xai-oauth credentials, which take their own collection branch", async () => {
		// `xai-oauth` is collected by a provider-specific branch that builds each
		// request and `continue`s before the shared stamp, so a pool of
		// identity-less OAuth rows shared the `unidentified` account and xAI's
		// fixed limit ids — and the renderer dropped every later credential as a
		// duplicate series.
		const xaiReport = (): UsageReport => ({
			provider: "xai-oauth",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "xai-oauth:monthly",
					label: "Monthly",
					scope: { provider: "xai-oauth", windowId: "monthly" },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: { endpoint: "https://example.invalid/quotas" },
		});
		const storage = new AuthStorage(makeStore([xaiOauthRow(21), xaiOauthRow(22)]), {
			usageProviderResolver: provider =>
				provider === "xai-oauth"
					? ({ id: "xai-oauth", fetchUsage: async () => xaiReport() } as UsageProvider)
					: undefined,
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const xai = reports.filter(report => report.provider === "xai-oauth");
			const keys = xai.map(report => report.metadata?.credentialKey);

			// RED (pre-fix): the branch pushed unstamped requests, so both reports
			// were byte-identical.
			expect(xai).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
		} finally {
			storage.close();
		}
	}, 20_000);
});
