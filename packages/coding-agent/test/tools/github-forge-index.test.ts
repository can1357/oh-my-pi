import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearAll,
	getCached,
	getForgeIndexFreshnessSync,
	getOrFetchView,
	invalidateAllForRepo,
	invalidatePullRequestsForRepo,
	openDb,
	putCached,
	readForgeIndexSync,
	resetForTests as resetCacheForTests,
	upsertForgeIndex,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TEST_REPO = "Owner/Example";
const OTHER_REPO = "Owner/Other";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-forge-index-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
});

afterEach(async () => {
	resetCacheForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	await removeWithRetries(tempDir);
});

describe("github_forge_index storage helpers", () => {
	it("returns empty array and null freshness when no rows exist or authKey is null", () => {
		expect(readForgeIndexSync(TEST_REPO)).toEqual([]);
		expect(getForgeIndexFreshnessSync(TEST_REPO)).toBeNull();

		upsertForgeIndex(
			TEST_REPO,
			[
				{
					kind: "pr",
					number: 1,
					title: "Should not persist",
					state: "OPEN",
					author: "octocat",
					updatedAt: "2026-04-01T10:00:00Z",
				},
			],
			null,
		);
		expect(readForgeIndexSync(TEST_REPO, null)).toEqual([]);
		expect(getForgeIndexFreshnessSync(TEST_REPO, null)).toBeNull();
		expect(readForgeIndexSync(TEST_REPO)).toEqual([]);
	});

	it("upserts, deduplicates, normalizes repo names, isolates auth keys, and sorts newest first", () => {
		const before = Date.now();
		upsertForgeIndex(
			"github.com/Owner/Example",
			[
				{
					kind: "issue",
					number: 10,
					title: "Older issue",
					state: "OPEN",
					author: "alice",
					updatedAt: "2026-04-01T08:00:00Z",
				},
				{
					kind: "pr",
					number: 25,
					title: "Newer PR",
					state: "OPEN",
					author: "bob",
					updatedAt: "2026-04-02T12:00:00Z",
				},
				{
					kind: "pr",
					number: 30,
					title: "Same timestamp higher number",
					state: "MERGED",
					author: "carol",
					updatedAt: "2026-04-02T12:00:00Z",
				},
			],
			"auth-a",
		);
		const after = Date.now();

		// Overwrite existing entry for #10 with updated title/state.
		upsertForgeIndex(
			"owner/example",
			[
				{
					kind: "issue",
					number: 10,
					title: "Updated issue title",
					state: "CLOSED",
					author: "alice",
					updatedAt: "2026-04-03T00:00:00Z",
				},
			],
			"auth-a",
		);

		const entries = readForgeIndexSync("OWNER/EXAMPLE", "auth-a");
		expect(entries.map(e => `${e.kind}#${e.number}`)).toEqual(["issue#10", "pr#30", "pr#25"]);
		expect(entries[0]).toMatchObject({
			kind: "issue",
			number: 10,
			title: "Updated issue title",
			state: "CLOSED",
			author: "alice",
			updatedAt: "2026-04-03T00:00:00Z",
		});

		const freshness = getForgeIndexFreshnessSync("owner/example", "auth-a");
		expect(freshness).not.toBeNull();
		expect(freshness!).toBeGreaterThanOrEqual(before);
		expect(freshness!).toBeLessThanOrEqual(after + 50);

		// Different auth key sees empty index.
		expect(readForgeIndexSync(TEST_REPO, "auth-b")).toEqual([]);
		expect(getForgeIndexFreshnessSync(TEST_REPO, "auth-b")).toBeNull();
	});

	it("caps readForgeIndexSync at 200 rows", () => {
		const batch = Array.from({ length: 220 }, (_, i) => ({
			kind: "issue" as const,
			number: i + 1,
			title: `Issue #${i + 1}`,
			state: "OPEN",
			author: "octocat",
			updatedAt: `2026-04-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
		}));
		upsertForgeIndex(TEST_REPO, batch);
		const entries = readForgeIndexSync(TEST_REPO);
		expect(entries).toHaveLength(200);
		expect(entries[0]?.number).toBe(220);
	});
});

describe("opportunistic indexing on github_view_cache writes", () => {
	it("populates github_forge_index when putCached and getOrFetchView store PRs and issues without dropping view cache", async () => {
		const issueFetchedAt = Date.now() - 1000;
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 42,
			includeComments: true,
			payload: {
				number: 42,
				title: "Fix palette focus",
				state: "OPEN",
				author: { login: "alice" },
				updatedAt: "2026-05-01T10:00:00Z",
			},
			rendered: "# Issue #42",
			fetchedAt: issueFetchedAt,
			authKey: "auth-1",
		});

		await getOrFetchView({
			repo: TEST_REPO,
			kind: "pr",
			number: 99,
			includeComments: false,
			authKey: "auth-1",
			fetchFresh: async () => ({
				rendered: "# PR #99",
				sourceUrl: "https://github.com/owner/example/pull/99",
				payload: {
					number: 99,
					title: "Unified @ mention palette",
					state: "OPEN",
					author: "bob",
					updatedAt: "2026-05-02T12:00:00Z",
				},
			}),
		});

		// Non-pr/issue kinds should not insert into github_forge_index.
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 99,
			includeComments: false,
			payload: { title: "Should be ignored", files: [] },
			rendered: "diff",
			fetchedAt: Date.now(),
			authKey: "auth-1",
		});

		// Existing github_view_cache rows remain intact.
		expect(getCached(TEST_REPO, "issue", 42, true, "auth-1")?.rendered).toBe("# Issue #42");

		const entries = readForgeIndexSync(TEST_REPO, "auth-1");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			kind: "pr",
			number: 99,
			title: "Unified @ mention palette",
			state: "OPEN",
			author: "bob",
			updatedAt: "2026-05-02T12:00:00Z",
		});
		expect(entries[1]).toMatchObject({
			kind: "issue",
			number: 42,
			title: "Fix palette focus",
			state: "OPEN",
			author: "alice",
			updatedAt: "2026-05-01T10:00:00Z",
			fetchedAt: issueFetchedAt,
		});
	});
});

describe("github_forge_index invalidation and eviction", () => {
	it("clears matching entries on invalidatePullRequestsForRepo, invalidateAllForRepo, and clearAll", () => {
		upsertForgeIndex(TEST_REPO, [
			{ kind: "pr", number: 1, title: "PR 1", state: "OPEN", author: "a", updatedAt: "2026-05-01T00:00:00Z" },
			{ kind: "issue", number: 2, title: "Issue 2", state: "OPEN", author: "b", updatedAt: "2026-05-01T00:00:00Z" },
		]);
		upsertForgeIndex(OTHER_REPO, [
			{ kind: "pr", number: 3, title: "Other PR", state: "OPEN", author: "c", updatedAt: "2026-05-01T00:00:00Z" },
		]);

		invalidatePullRequestsForRepo(TEST_REPO);
		expect(readForgeIndexSync(TEST_REPO).map(e => `${e.kind}#${e.number}`)).toEqual(["issue#2"]);
		expect(readForgeIndexSync(OTHER_REPO).map(e => `${e.kind}#${e.number}`)).toEqual(["pr#3"]);

		invalidateAllForRepo(TEST_REPO);
		expect(readForgeIndexSync(TEST_REPO)).toEqual([]);
		expect(readForgeIndexSync(OTHER_REPO).map(e => `${e.kind}#${e.number}`)).toEqual(["pr#3"]);

		clearAll();
		expect(readForgeIndexSync(OTHER_REPO)).toEqual([]);
	});

	it("evicts expired github_forge_index rows during hard TTL sweep", async () => {
		const db = openDb();
		expect(db).not.toBeNull();
		const oldTimestamp = Date.now() - 10 * 60 * 1000;
		db!
			.query(
				"INSERT INTO github_forge_index (auth_key, repo, kind, number, title, state, author, updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("default", "owner/example", "issue", 7, "Stale issue", "OPEN", "a", "2026-01-01T00:00:00Z", oldTimestamp);

		expect(readForgeIndexSync(TEST_REPO)).toHaveLength(1);

		const settings = Settings.isolated({
			"github.cache.enabled": true,
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 120,
		});
		await getOrFetchView({
			repo: OTHER_REPO,
			kind: "issue",
			number: 1,
			includeComments: false,
			settings,
			fetchFresh: async () => ({
				rendered: "ok",
				sourceUrl: undefined,
				payload: { title: "Fresh", state: "OPEN", author: { login: "b" }, updatedAt: "2026-05-01T00:00:00Z" },
			}),
		});

		expect(readForgeIndexSync(TEST_REPO)).toEqual([]);
		expect(readForgeIndexSync(OTHER_REPO)).toHaveLength(1);
	});
});
