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
import { type CredentialBlocks, DEFAULT_BLOCK_MS } from "@oh-my-pi/pi-ai/auth/blocks";
import { type AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker";
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

			// `mark` and `blockedUntil` are the store's own API, under the public `BlocksApi`.
			const blocks = auth.blocks as CredentialBlocks;
			blocks.mark("cap-local", "cap-local:api_key", 0, now + 400 * DAY_MS);
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 0)).toBe(now + WEEK_MS);
			blocks.mark("cap-local", "cap-local:api_key", 1, Number.NaN);
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 1)).toBe(now + DEFAULT_BLOCK_MS);

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

	it("ends a block an older version wrote past the ceiling a week after that write, and keeps it there", async () => {
		// Before the ceiling, the store's upsert kept any finite deadline. The
		// rows below are written with that older statement's columns and values
		// (a far deadline, `updated_at` in epoch seconds), not by this code.
		const dir = TempDir.createSync("@pi-block-cap-legacy-");
		const dbPath = `${dir.path()}/auth.db`;
		const setup = await AuthStorage.create(dbPath);
		await setup.credentials.set("cap-local", [
			{ type: "api_key", key: "first" },
			{ type: "api_key", key: "second" },
			{ type: "api_key", key: "third" },
		]);
		const [first, second, third] = setup.credentials.list("cap-local");
		setup.close();

		const now = Date.now();
		const tenDaysAgoSec = Math.floor((now - 10 * DAY_MS) / 1000);
		const oneDayAgoSec = Math.floor((now - DAY_MS) / 1000);
		const monthAheadSec = Math.floor((now + 30 * DAY_MS) / 1000);
		const legacy = new Database(dbPath);
		try {
			const insert = legacy.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			insert.run(first.id, "cap-local:api_key", "", now + 400 * DAY_MS, tenDaysAgoSec);
			insert.run(second.id, "cap-local:api_key", "", now + 400 * DAY_MS, oneDayAgoSec);
			// Written by a clock a month ahead of this one. The deadline is an epoch
			// deadline, so it ends a week after that write, which is later from
			// here: the accepted behaviour of a backward clock change.
			insert.run(third.id, "cap-local:api_key", "", now + 400 * DAY_MS, monthAheadSec);
		} finally {
			legacy.close();
		}

		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const auth = await AuthStorage.create(dbPath);
		try {
			await auth.credentials.reload();
			const blocks = auth.blocks as CredentialBlocks;
			// `updated_at` holds whole seconds; the week runs from the end of that second.
			const secondEnds = (oneDayAgoSec + 1) * 1000 + WEEK_MS;
			const thirdEnds = (monthAheadSec + 1) * 1000 + WEEK_MS;
			// Written ten days ago: past its week, so released.
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 0)).toBeUndefined();
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 1)).toBe(secondEnds);
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 2)).toBe(thirdEnds);
			// Stored as that deadline, so a later write cannot restart the week:
			// a new short block refreshes the row's write time and keeps the deadline.
			blocks.mark("cap-local", "cap-local:api_key", 1, now + 60_000);
			clock.mockReturnValue(now + 3 * DAY_MS);
			expect(auth.blocks.list([first.id, second.id]).map(block => block.blockedUntilMs)).toEqual([secondEnds]);
			const stored = new Database(dbPath, { readonly: true });
			try {
				const rows = stored
					.prepare("SELECT credential_id, blocked_until_ms FROM auth_credential_blocks ORDER BY credential_id")
					.all() as { credential_id: number; blocked_until_ms: number }[];
				expect(rows).toEqual([
					{ credential_id: second.id, blocked_until_ms: secondEnds },
					{ credential_id: third.id, blocked_until_ms: thirdEnds },
				]);
			} finally {
				stored.close();
			}
			clock.mockReturnValue(secondEnds + 1);
			expect(blocks.blockedUntil("cap-local", "cap-local:api_key", 1)).toBeUndefined();
		} finally {
			auth.close();
			dir.removeSync();
		}
		// Two SQLite opens; each takes seconds on a loaded machine.
	}, 30_000);

	it("keeps an older Codex row's original week while a pre-meter binary writes the shared mirror", async () => {
		// An older version blocked the Codex `chat` meter for a century. A
		// pre-meter binary still writes the physical `shared` row, whose triggers
		// copy deadlines onto the meter rows with a fresh `updated_at`.
		const dir = TempDir.createSync("@pi-block-cap-codex-");
		const dbPath = `${dir.path()}/auth.db`;
		const setup = await AuthStorage.create(dbPath);
		await setup.credentials.set("openai-codex", [{ type: "api_key", key: "codex" }]);
		const [codex] = setup.credentials.list("openai-codex");
		setup.close();
		const now = Date.now();
		const writtenSec = Math.floor((now - DAY_MS) / 1000);
		const legacy = new Database(dbPath);
		legacy
			.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(codex.id, "openai-codex:oauth", "chat", now + 36_500 * DAY_MS, writtenSec);
		legacy.close();

		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const auth = await AuthStorage.create(dbPath);
		const preMeter = new Database(dbPath);
		try {
			const chat = () => auth.blocks.list([codex.id]).find(block => block.blockScope === "chat")?.blockedUntilMs;
			// A week after the original write, not after any later one.
			const fixed = (writtenSec + 1) * 1000 + WEEK_MS;
			expect(chat()).toBe(fixed);
			for (const round of [1, 2, 3]) {
				const at = now + round * DAY_MS;
				clock.mockReturnValue(at);
				preMeter
					.prepare(
						`INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at)
						VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
							blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
							updated_at = excluded.updated_at`,
					)
					.run(codex.id, "openai-codex:oauth", "shared", at + 60_000, Math.floor(at / 1000));
				expect({ round, chat: chat() }).toEqual({ round, chat: fixed });
			}
			const raw = preMeter.prepare("SELECT MAX(blocked_until_ms) AS longest FROM auth_credential_blocks").get() as {
				longest: number;
			};
			expect(raw.longest).toBe(fixed);
		} finally {
			preMeter.close();
			auth.close();
			dir.removeSync();
		}
	}, 30_000);

	it("ends a broker block an older broker kept past the ceiling a week after its write, on the broker too", async () => {
		const now = Date.now();
		const entry = (id: number, writtenAtMs: number) => ({
			id,
			provider: "cap-remote",
			credential: { type: "api_key" as const, key: `fixture-${id}` },
			identityKey: null,
			rotatesInMs: null,
			blocks: [
				{
					providerKey: "cap-remote:api_key",
					blockScope: "",
					blockedUntilMs: now + 400 * DAY_MS,
					updatedAtMs: writtenAtMs,
				},
			],
		});
		const snapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			credentials: [entry(1, now - 10 * DAY_MS), entry(2, now - DAY_MS)],
		};
		// An older broker: it applies block writes as written, longest-wins on
		// upsert and stamping the write time, with no ceiling of its own.
		// Background long-polls report "unchanged" so only `refreshSnapshot()`
		// reads its state.
		const broker = {
			current: structuredClone(snapshot),
			writes: [] as string[],
			async fetchSnapshot(opts: { ifGenerationGt?: number } = {}) {
				if (opts.ifGenerationGt !== undefined) return { status: 304, generation: broker.current.generation };
				return { status: 200, snapshot: structuredClone(broker.current), generation: broker.current.generation };
			},
			async deleteCredentialBlock(id: number, target: { providerKey: string; blockScope: string }) {
				broker.writes.push(`DELETE ${id}`);
				const found = broker.current.credentials.find(candidate => candidate.id === id)!;
				found.blocks = found.blocks?.filter(
					block => block.providerKey !== target.providerKey || block.blockScope !== target.blockScope,
				);
				broker.current.generation++;
				return { deleted: 1 };
			},
			async upsertCredentialBlock(
				id: number,
				block: { providerKey: string; blockScope: string; blockedUntilMs: number },
			) {
				broker.writes.push(`UPSERT ${id}`);
				const found = broker.current.credentials.find(candidate => candidate.id === id)!;
				const existing = found.blocks?.find(candidate => candidate.blockScope === block.blockScope);
				if (!existing) found.blocks = [...(found.blocks ?? []), { ...block, updatedAtMs: Date.now() }];
				else
					Object.assign(existing, {
						blockedUntilMs: Math.max(existing.blockedUntilMs, block.blockedUntilMs),
						updatedAtMs: Date.now(),
					});
				broker.current.generation++;
				return { ok: true };
			},
		};
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const remote = new RemoteAuthCredentialStore({
			client: broker as unknown as AuthBrokerClient,
			initialSnapshot: structuredClone(snapshot),
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		const auth = new AuthStorage(remote);
		try {
			await auth.credentials.reload();
			const secondEnds = now - DAY_MS + WEEK_MS;
			// Written ten days ago: released. Written a day ago: six days left.
			expect(auth.blocks.list([1, 2]).map(block => [block.credentialId, block.blockedUntilMs])).toEqual([
				[2, secondEnds],
			]);
			expect(remote.getCredentialBlock(1, "cap-remote:api_key", "")).toBeUndefined();
			// The broker is repaired as well, so its other clients read the same:
			// a delete, then the bounded upsert (an upsert alone is longest-wins
			// there and would keep the 400 days); a bound already past is only deleted.
			await remote.refreshSnapshot();
			expect(broker.writes.toSorted()).toEqual(["DELETE 1", "DELETE 2", "UPSERT 2"]);
			expect(
				broker.current.credentials.map(found => found.blocks?.map(block => block.blockedUntilMs) ?? []),
			).toEqual([[], [secondEnds]]);
			// Stored as that deadline, so a later write with a fresh write time
			// cannot restart the week.
			clock.mockReturnValue(now + DAY_MS);
			auth.blocks.upsert({
				credentialId: 2,
				providerKey: "cap-remote:api_key",
				blockScope: "",
				blockedUntilMs: now + DAY_MS + 60_000,
			});
			await remote.refreshSnapshot();
			expect(auth.blocks.list([2]).map(block => block.blockedUntilMs)).toEqual([secondEnds]);
		} finally {
			auth.close();
		}
	}, 30_000);
});
