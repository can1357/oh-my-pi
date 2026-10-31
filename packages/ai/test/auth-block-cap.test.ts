/**
 * No credential block outlives `MAX_HINTED_BLOCK_MS` from when it is written,
 * whoever states the deadline: a message, a header, or a usage report. A usage
 * report is a parsed response body too — a provider's usage API, or a gateway
 * that relays one, can state any reset — so it gets the same ceiling as the
 * hint it would otherwise extend. And a deadline that is not a number never
 * fails open.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { DEFAULT_BLOCK_MS } from "@oh-my-pi/pi-ai/auth/blocks";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function makeStore(credentials: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return credentials;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return [];
		},
		async upsertAuthCredential() {
			return [];
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry || entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

/** An exhausted xAI billing period and on-demand cap, so the report is a complete authority for the wait. */
function exhaustedReport(now: number, resetsAt: number): UsageReport {
	return {
		provider: "xai-oauth",
		fetchedAt: now,
		limits: [
			{
				id: "xai-oauth:included:1mo",
				label: "SuperGrok Monthly Included",
				scope: { provider: "xai-oauth", windowId: "1mo", shared: true },
				window: { id: "1mo", label: "Monthly", durationMs: 30 * DAY_MS, resetsAt },
				amount: { used: 100, limit: 100, usedFraction: 1, remainingFraction: 0, unit: "unknown" },
				status: "exhausted",
			},
			{
				id: "xai-oauth:on-demand",
				label: "On-demand",
				scope: { provider: "xai-oauth", shared: true },
				amount: { used: 50, limit: 50, usedFraction: 1, unit: "unknown" },
				status: "exhausted",
			},
		],
	};
}

async function markReachedWithReport(now: number, report: UsageReport | undefined, retryAfterMs: number | undefined) {
	const storage = new AuthStorage(
		makeStore([
			{
				id: 1,
				provider: "xai-oauth",
				credential: { type: "oauth", access: "token", refresh: "r", expires: now + 3_600_000 },
				disabledCause: null,
			},
		]),
		{
			usageProviderResolver: () => ({
				id: "xai-oauth",
				supports: () => true,
				fetchUsage: async () => report ?? null,
			}),
		},
	);
	await storage.credentials.reload();
	await storage.keys.get("xai-oauth", "session");
	return storage.limits.markReached("xai-oauth", "session", {
		retryAfterMs,
		providerTimed: retryAfterMs !== undefined,
	});
}

describe("credential block ceiling", () => {
	it.each([
		["20 days", 20 * DAY_MS, WEEK_MS],
		["400 days", 400 * DAY_MS, WEEK_MS],
		["a century", 36_500 * DAY_MS, WEEK_MS],
		["3 days", 3 * DAY_MS, 3 * DAY_MS],
	] as [string, number, number][])(
		"caps a usage report's reset %s ahead at seven days",
		async (_label, resetInMs, expectedMs) => {
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now);
			const mark = await markReachedWithReport(now, exhaustedReport(now, now + resetInMs), 60_000);
			expect(mark.blockedUntilMs).toBe(now + expectedMs);
			expect(mark.reportResetAtMs).toBe(now + expectedMs);
		},
	);

	it("blocks for the default when the stated wait is NaN, not for NaN", async () => {
		// Math.min(NaN, cap) is NaN, and a NaN deadline is a block that never holds.
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const mark = await markReachedWithReport(now, undefined, Number.NaN);
		expect(mark.blockedUntilMs).toBe(now + DEFAULT_BLOCK_MS);
		expect(mark.requestedBlockedUntilMs).toBe(now + DEFAULT_BLOCK_MS);
	});

	it("caps and repairs every deadline at the block store itself", async () => {
		// Selection, rotation and saved-reset redemption all write through
		// `blocks.mark` / `blocks.upsert`, the latter also the broker's wire seam.
		const dir = TempDir.createSync("@pi-block-cap-");
		const auth = await AuthStorage.create(`${dir.path()}/auth.db`);
		try {
			await auth.credentials.set("cap-local", [
				{ type: "api_key", key: "first" },
				{ type: "api_key", key: "second" },
			]);
			const [first, second] = auth.credentials.list("cap-local");
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now);

			auth.blocks.mark("cap-local", "cap-local:api_key", 0, now + 400 * DAY_MS);
			expect(auth.blocks.blockedUntil("cap-local", "cap-local:api_key", 0)).toBe(now + WEEK_MS);
			auth.blocks.mark("cap-local", "cap-local:api_key", 1, Number.NaN);
			expect(auth.blocks.blockedUntil("cap-local", "cap-local:api_key", 1)).toBe(now + DEFAULT_BLOCK_MS);

			auth.blocks.upsert({
				credentialId: second.id,
				providerKey: "cap-local:api_key",
				blockScope: "tier:mythos",
				blockedUntilMs: now + 36_500 * DAY_MS,
			});
			const stored = auth.blocks
				.list([first.id, second.id])
				.map(block => [block.credentialId, block.blockScope, block.blockedUntilMs - now]);
			expect(stored).toContainEqual([first.id, "", WEEK_MS]);
			expect(stored).toContainEqual([second.id, "", DEFAULT_BLOCK_MS]);
			expect(stored).toContainEqual([second.id, "tier:mythos", WEEK_MS]);
		} finally {
			auth.close();
			dir.removeSync();
		}
	});

	it("releases a block an older version wrote for longer than seven days", async () => {
		// Before the ceiling, the store's upsert kept any finite deadline. Such a
		// row outlives an upgrade unless reads bound it by when it was written.
		// The rows below are written with that older statement's columns and
		// values (a far deadline, `updated_at` in epoch seconds), not by this code.
		const dir = TempDir.createSync("@pi-block-cap-legacy-");
		const dbPath = `${dir.path()}/auth.db`;
		const setup = await AuthStorage.create(dbPath);
		await setup.credentials.set("cap-local", [
			{ type: "api_key", key: "first" },
			{ type: "api_key", key: "second" },
		]);
		const [first, second] = setup.credentials.list("cap-local");
		setup.close();

		const now = Date.now();
		const tenDaysAgoSec = Math.floor((now - 10 * DAY_MS) / 1000);
		const oneDayAgoSec = Math.floor((now - DAY_MS) / 1000);
		const legacy = new Database(dbPath);
		try {
			const insert = legacy.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			insert.run(first.id, "cap-local:api_key", "", now + 400 * DAY_MS, tenDaysAgoSec);
			insert.run(second.id, "cap-local:api_key", "", now + 400 * DAY_MS, oneDayAgoSec);
		} finally {
			legacy.close();
		}

		const auth = await AuthStorage.create(dbPath);
		try {
			await auth.credentials.reload();
			expect(auth.credentials.list("cap-local").map(credential => credential.id)).toEqual([first.id, second.id]);
			vi.spyOn(Date, "now").mockReturnValue(now);
			// `updated_at` holds whole seconds; the week runs from the end of that second.
			const boundedSecond = (oneDayAgoSec + 1) * 1000 + WEEK_MS;
			// Written ten days ago: past its week, so released.
			expect(auth.blocks.blockedUntil("cap-local", "cap-local:api_key", 0)).toBeUndefined();
			// Written a day ago: blocked for the six days left of its week, not 400.
			expect(auth.blocks.blockedUntil("cap-local", "cap-local:api_key", 1)).toBe(boundedSecond);
			expect(
				auth.blocks.list([first.id, second.id]).map(block => [block.credentialId, block.blockedUntilMs]),
			).toEqual([[second.id, boundedSecond]]);
			// A new short block merges with the legacy row's bounded deadline: it
			// must not restart that row's week from now.
			auth.blocks.mark("cap-local", "cap-local:api_key", 1, now + 60_000);
			expect(auth.blocks.list([second.id]).map(block => block.blockedUntilMs)).toEqual([boundedSecond]);
		} finally {
			auth.close();
			dir.removeSync();
		}
		// Two SQLite opens; each takes seconds on a loaded machine.
	}, 30_000);
});
