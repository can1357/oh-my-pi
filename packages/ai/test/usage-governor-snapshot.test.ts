/**
 * Status and admission read cached snapshots only (spec 5 Slice A acceptance 5). With two duplicate OAuth
 * rows for one account, neither `status()` nor `admit()` may fetch, prune, or write a block. The control is
 * `usage.reports()` on the same store, which soft-disables one duplicate; that proves the detector is live.
 */
import { describe, expect, test } from "bun:test";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import {
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	type Harness,
	expectNoStrayFetch,
	installFetchTripwire,
	oauthCredential,
	PROVIDER,
	seedAccounts,
	seedReports,
	windowAt,
} from "./fixtures/usage-governor/harness";

installFetchTripwire();

const ACCOUNT = "acc-dup";
const EMAIL = "dup@example.com";

/** The pool's in-memory adoption of rows written by another process, without the prune that `reload` runs. */
interface RowAdoption {
	reloadProvider(provider: string): unknown;
}

/**
 * One account, snapshot cached, then a duplicate row for the same account lands in the store and the pool
 * adopts both rows without pruning. The snapshot is cached before the duplicate exists, because
 * `usage.reports()` is the call that prunes duplicates.
 */
async function duplicateRows(h: Harness): Promise<number[]> {
	await seedAccounts(h, PROVIDER, [{ accountId: ACCOUNT, email: EMAIL, window: windowAt(60_000, 120_000, 0.1) }]);
	await seedReports(h, PROVIDER);
	await h.store.replaceAuthCredentials(PROVIDER, [oauthCredential(ACCOUNT, EMAIL), oauthCredential(ACCOUNT, EMAIL)]);
	// Test-only reach to the pool's adoption method: a cross-process write is adopted without `reload`'s prune.
	const adoption = h.storage.credentials as unknown as RowAdoption;
	adoption.reloadProvider(PROVIDER);
	return h.storage.oauth.accounts(PROVIDER).map(account => account.credentialId);
}

function activeRows(h: Harness): number {
	return h.authRows().filter(row => row.provider === PROVIDER && row.disabled_cause === null).length;
}

describe("status and admit read snapshots only", () => {
	test("status and admit make no network call, keep both duplicate rows active, and write no block row", async () => {
		const h = await createHarness(ENABLED);
		try {
			const rowIds = await duplicateRows(h);
			expect(rowIds).toHaveLength(2);
			expect(activeRows(h)).toBe(2);

			const fetchesBefore = h.usage.reportFetches;
			const requestsBefore = h.usage.fetchLog.length;

			const status = h.storage.governor.status({ provider: PROVIDER });
			// Both rows are in the pool, so status reports a window for each.
			expect(new Set(status.windows.map(window => window.credentialId))).toEqual(new Set(rowIds));
			const grant = await h.storage.governor.admit({ credentialId: rowIds[0], provider: PROVIDER });
			expect(grant).toBeDefined();
			if (grant) h.storage.governor.settle(grant.id, "sent");

			expect(h.usage.reportFetches).toBe(fetchesBefore);
			expect(h.usage.fetchLog).toHaveLength(requestsBefore);
			expectNoStrayFetch(h);
			expect(activeRows(h)).toBe(2);
			expect(h.blockRowCount()).toBe(0);
		} finally {
			configureUsageAdmission(undefined);
			await disposeHarness();
		}
	});

	test("control: usage.reports() on the same store soft-disables one of the two duplicate rows", async () => {
		const h = await createHarness(ENABLED);
		try {
			await duplicateRows(h);
			expect(activeRows(h)).toBe(2);

			await h.storage.usage.reports({ provider: PROVIDER });

			expect(activeRows(h)).toBe(1);
			const disabled = h.authRows().filter(row => row.disabled_cause !== null);
			expect(disabled).toHaveLength(1);
			expect(disabled[0]?.disabled_cause).toBe("deduplicated duplicate credential");
			// Pruning is a usage-report side effect only; it writes no block row either.
			expect(h.blockRowCount()).toBe(0);
		} finally {
			await disposeHarness();
		}
	});

	test("control: the surviving row is the one the pool keeps after the prune", async () => {
		const h = await createHarness(ENABLED);
		try {
			const rowIds = await duplicateRows(h);
			await h.storage.usage.reports({ provider: PROVIDER });
			const survivors = h.storage.oauth.accounts(PROVIDER).map(account => account.credentialId);
			expect(survivors).toHaveLength(1);
			expect(rowIds).toContain(survivors[0]);
			expect(credentialIdOf(h, PROVIDER, ACCOUNT)).toBe(survivors[0]);
		} finally {
			await disposeHarness();
		}
	});
});
