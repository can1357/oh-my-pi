/**
 * Governed account selection (spec 5 Slice A acceptance 1 and 2). Selection reads the cached snapshots
 * and the in-memory pool only, so the same fixtures run with the governor on and off.
 */
import { describe, expect, test } from "bun:test";
import {
	createHarness,
	disposeHarness,
	DISABLED,
	ENABLED,
	type Harness,
	installFetchTripwire,
	PROVIDER,
	credentialIdOf,
	expectNoStrayFetch,
	seedAccounts,
	seedReports,
	windowAt,
} from "./fixtures/usage-governor/harness";

installFetchTripwire();

const SESSION = "session-warm-pin";
/** One minute of primary window, reset thirty seconds out: the line sits at 0.5625 of headroom now. */
const DURATION = 60_000;
const RESET_IN = 30_000;

/** Make the account behind `rowId` read `used` at the next snapshot, then refresh the cache. */
async function reportUsage(h: Harness, accountId: string, used: number): Promise<void> {
	h.usage.setWindow(accountId, { used });
	await h.storage.usage.invalidate(PROVIDER);
	await seedReports(h, PROVIDER);
}

function accountIdFor(h: Harness, rowId: number): string {
	const account = h.storage.oauth.accounts(PROVIDER).find(entry => entry.credentialId === rowId);
	if (!account || account.accountId === undefined) throw new Error(`no account id for row ${rowId}`);
	return account.accountId;
}

describe("A1: a warm automatic pin yields to an account under its line", () => {
	test("the session's automatic pin on an account over its line moves to the account under it", async () => {
		const h = await createHarness(ENABLED);
		try {
			await seedAccounts(h, PROVIDER, [
				{ accountId: "acc-a", email: "a@example.com", window: windowAt(RESET_IN, DURATION, 0.1) },
				{ accountId: "acc-b", email: "b@example.com", window: windowAt(RESET_IN, DURATION, 0.1) },
			]);
			await seedReports(h, PROVIDER);
			// A prior selection pins the session automatically (no sessions.pin call).
			const first = await h.storage.keys.getWithCredential(PROVIDER, SESSION);
			if (first?.credentialId === undefined) throw new Error("expected an initial selection");
			const pinnedRow = first.credentialId;
			const pinnedAccount = accountIdFor(h, pinnedRow);
			const otherAccount = pinnedAccount === "acc-a" ? "acc-b" : "acc-a";
			const otherRow = credentialIdOf(h, PROVIDER, otherAccount);

			// The pinned account crosses its line; the other stays under.
			await reportUsage(h, pinnedAccount, 0.8);
			const moved = await h.storage.keys.getWithCredential(PROVIDER, SESSION);
			expect(moved?.credentialId).toBe(otherRow);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	});

	test("control: with the governor inactive the same pinned account is kept", async () => {
		const h = await createHarness(DISABLED);
		try {
			await seedAccounts(h, PROVIDER, [
				{ accountId: "acc-a", email: "a@example.com", window: windowAt(RESET_IN, DURATION, 0.1) },
				{ accountId: "acc-b", email: "b@example.com", window: windowAt(RESET_IN, DURATION, 0.1) },
			]);
			await seedReports(h, PROVIDER);
			const first = await h.storage.keys.getWithCredential(PROVIDER, SESSION);
			if (first?.credentialId === undefined) throw new Error("expected an initial selection");
			const pinnedAccount = accountIdFor(h, first.credentialId);

			await reportUsage(h, pinnedAccount, 0.8);
			const kept = await h.storage.keys.getWithCredential(PROVIDER, SESSION);
			expect(kept?.credentialId).toBe(first.credentialId);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	});
});

describe("A2: a paced account is never replaced by one serving on credits", () => {
	/**
	 * `paced` is over its line but still has allowance; `credits` has spent its included allowance and
	 * serves on overage. Selection must keep `paced` and never pick `credits`.
	 */
	async function setup(creditsUsed: number): Promise<Harness> {
		const h = await createHarness(ENABLED);
		await seedAccounts(h, PROVIDER, [
			{ accountId: "acc-paced", email: "paced@example.com", window: windowAt(RESET_IN, DURATION, 0.8) },
			{ accountId: "acc-credits", email: "credits@example.com", window: windowAt(RESET_IN, DURATION, creditsUsed) },
		]);
		await seedReports(h, PROVIDER);
		return h;
	}

	test("a paced account is selected over a credits-serving one, for every fresh session", async () => {
		const h = await setup(1);
		try {
			const pacedRow = credentialIdOf(h, PROVIDER, "acc-paced");
			const creditsRow = credentialIdOf(h, PROVIDER, "acc-credits");
			const chosen: Array<number | undefined> = [];
			for (let index = 0; index < 3; index += 1) {
				chosen.push((await h.storage.keys.getWithCredential(PROVIDER, `session-a2-${index}`))?.credentialId);
			}
			expect(chosen).toEqual([pacedRow, pacedRow, pacedRow]);
			expect(chosen).not.toContain(creditsRow);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	});

	test("control: when the other account still has allowance, selection moves to it", async () => {
		const h = await setup(0.1);
		try {
			const creditsRow = credentialIdOf(h, PROVIDER, "acc-credits");
			const chosen = await h.storage.keys.getWithCredential(PROVIDER, "session-a2-control");
			expect(chosen?.credentialId).toBe(creditsRow);
		} finally {
			await disposeHarness();
		}
	});
});
