/**
 * Cache-layer tests for `github-cache` (storage + TTL semantics) and for the
 * `getOrFetchIssue` / `getOrFetchPr` wrappers wired into `gh.ts`.
 *
 * Each test isolates `OMP_GITHUB_CACHE_DB` to a temp file and clears
 * `github.json` / `github.text` mocks between cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getOrFetchIssue, getOrFetchPr } from "@oh-my-pi/pi-coding-agent/tools/gh";
import {
	clearAll,
	getCached,
	getOrFetchView,
	openDb,
	putCached,
	resetForTests as resetCacheForTests,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { ToolAbortError, throwIfAborted } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TEST_REPO = "owner/example";
const TEST_AUTH_KEY = "test-auth";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-"));
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
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

function issuePayload(number: number, body: string) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/${TEST_REPO}/issues/${number}`,
		labels: [],
		comments: [],
	};
}

function prPayload(number: number, body: string) {
	return {
		number,
		title: `PR #${number}`,
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		headRefName: "feature/x",
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/${TEST_REPO}/pull/${number}`,
		labels: [],
		files: [],
		reviews: [],
		comments: [],
	};
}

describe("github-cache db layer", () => {
	it("INSERT OR REPLACE overwrites the row instead of creating duplicates", () => {
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 7,
			includeComments: true,
			payload: issuePayload(7, "first"),
			rendered: "rendered-v1",
			sourceUrl: `https://github.com/${TEST_REPO}/issues/7`,
			fetchedAt: 1000,
		});
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 7,
			includeComments: true,
			payload: issuePayload(7, "second"),
			rendered: "rendered-v2",
			sourceUrl: `https://github.com/${TEST_REPO}/issues/7`,
			fetchedAt: 2000,
		});
		const got = getCached(TEST_REPO, "issue", 7, true);
		expect(got).not.toBeNull();
		expect(got?.rendered).toBe("rendered-v2");
		expect(got?.fetchedAt).toBe(2000);

		const db = openDb();
		const rows = db?.prepare("SELECT COUNT(*) AS c FROM github_view_cache").all() as Array<{ c: number }>;
		expect(rows[0].c).toBe(1);
	});

	it("keys comments-on and comments-off as separate rows", () => {
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 9,
			includeComments: true,
			payload: issuePayload(9, "with-comments"),
			rendered: "with-comments-rendering",
			fetchedAt: 1000,
		});
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 9,
			includeComments: false,
			payload: issuePayload(9, "no-comments"),
			rendered: "no-comments-rendering",
			fetchedAt: 1000,
		});
		const withComments = getCached(TEST_REPO, "issue", 9, true);
		const noComments = getCached(TEST_REPO, "issue", 9, false);
		expect(withComments?.rendered).toBe("with-comments-rendering");
		expect(noComments?.rendered).toBe("no-comments-rendering");
	});

	it("keys rows by GitHub auth identity", () => {
		putCached({
			authKey: "identity-a",
			repo: TEST_REPO,
			kind: "issue",
			number: 12,
			includeComments: true,
			payload: issuePayload(12, "a"),
			rendered: "from-a",
			fetchedAt: 1000,
		});
		putCached({
			authKey: "identity-b",
			repo: TEST_REPO,
			kind: "issue",
			number: 12,
			includeComments: true,
			payload: issuePayload(12, "b"),
			rendered: "from-b",
			fetchedAt: 1000,
		});

		expect(getCached(TEST_REPO, "issue", 12, true, "identity-a")?.rendered).toBe("from-a");
		expect(getCached(TEST_REPO, "issue", 12, true, "identity-b")?.rendered).toBe("from-b");
	});

	it("clearAll wipes every row but the schema survives", () => {
		putCached({
			repo: TEST_REPO,
			kind: "pr",
			number: 1,
			includeComments: true,
			payload: prPayload(1, "x"),
			rendered: "x",
			fetchedAt: 1000,
		});
		clearAll();
		expect(getCached(TEST_REPO, "pr", 1, true)).toBeNull();
		const db = openDb();
		expect(db).not.toBeNull();
	});

	it("does not chmod an existing cache parent directory", async () => {
		const parent = path.join(tempDir, "caller-owned-parent");
		await fs.mkdir(parent, { recursive: true, mode: 0o755 });
		await fs.chmod(parent, 0o755);
		process.env.OMP_GITHUB_CACHE_DB = path.join(parent, "github-cache.db");
		resetCacheForTests();

		const db = openDb();

		expect(db).not.toBeNull();
		const stat = await fs.stat(parent);
		expect(stat.mode & 0o777).toBe(0o755);
	});

	it("preserves rows across openDb() and honors the configured hard TTL via per-lookup sweep", async () => {
		const DAY_MS = 86_400_000;
		const fourteenDaysAgo = Date.now() - 14 * DAY_MS;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 314,
			includeComments: true,
			payload: issuePayload(314, "old-body"),
			rendered: "fourteen-days-old",
			fetchedAt: fourteenDaysAgo,
		});

		// Reopen the DB. Pre-fix, openDb() called evictExpired() with the 7-day
		// default and would nuke this row. Post-fix, the row must survive.
		resetCacheForTests();
		const reopened = openDb();
		expect(reopened).not.toBeNull();
		expect(getCached(TEST_REPO, "issue", 314, true, TEST_AUTH_KEY)?.rendered).toBe("fourteen-days-old");

		// Configured retention of 30 days: row is well within hard TTL. Use a
		// soft TTL >= 14d so the lookup returns "fresh" and does NOT schedule a
		// background refresh that would clobber `fetched_at`.
		const generousSettings = Settings.isolated({
			"github.cache.softTtlSec": 30 * 86_400,
			"github.cache.hardTtlSec": 30 * 86_400,
		});
		const noopFetch = vi.fn(async () => ({
			rendered: "should-not-run",
			sourceUrl: undefined,
			payload: issuePayload(314, "should-not-run"),
		}));
		const lenient = await getOrFetchView({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 314,
			includeComments: true,
			fetchFresh: noopFetch,
			settings: generousSettings,
		});
		expect(lenient.status).toBe("fresh");
		expect(noopFetch).not.toHaveBeenCalled();
		expect(getCached(TEST_REPO, "issue", 314, true, TEST_AUTH_KEY)?.fetchedAt).toBe(fourteenDaysAgo);

		// Reset so the throttled `sweepIfDue` is allowed to run again under
		// the stricter configuration.
		resetCacheForTests();
		const strictSettings = Settings.isolated({
			"github.cache.softTtlSec": 86_400,
			"github.cache.hardTtlSec": 86_400,
		});
		const refreshFetch = vi.fn(async () => ({
			rendered: "refreshed-content",
			sourceUrl: undefined,
			payload: issuePayload(314, "refreshed"),
		}));
		const strict = await getOrFetchView({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 314,
			includeComments: true,
			fetchFresh: refreshFetch,
			settings: strictSettings,
		});
		expect(strict.status).toBe("miss");
		expect(refreshFetch).toHaveBeenCalledTimes(1);
		const after = getCached(TEST_REPO, "issue", 314, true, TEST_AUTH_KEY);
		// The 14-day-old row is gone; only the fresh write from this call
		// remains.
		expect(after?.rendered).toBe("refreshed-content");
		expect(after?.fetchedAt).not.toBe(fourteenDaysAgo);
	});
});

describe("getOrFetchView (TTL semantics)", () => {
	it("returns cached row directly within the soft TTL window", async () => {
		const fetchFresh = vi.fn(async () => ({
			rendered: "fresh",
			sourceUrl: undefined,
			payload: { number: 42 },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 42,
			includeComments: true,
			payload: { number: 42 },
			rendered: "cached",
			fetchedAt: Date.now() - 60_000, // 1 minute ago
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 42,
			includeComments: true,
			fetchFresh,
		});
		expect(result.status).toBe("fresh");
		expect(result.rendered).toBe("cached");
		expect(fetchFresh).not.toHaveBeenCalled();
	});

	it("refreshes issue rows synchronously past soft TTL", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "refreshed",
			sourceUrl: undefined,
			payload: { number: 50, refreshed: true },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 50,
			includeComments: true,
			payload: { number: 50, refreshed: false },
			rendered: "old",
			fetchedAt: Date.now() - 5 * 60_000, // 5 minutes ago — past soft, before hard
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 50,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("refreshed");
		expect(result.rendered).toBe("refreshed");
		expect(fetchFresh).toHaveBeenCalledTimes(1);

		const updated = getCached<{ refreshed: boolean }>(TEST_REPO, "issue", 50, true);
		expect(updated?.rendered).toBe("refreshed");
		expect(updated?.payload.refreshed).toBe(true);
	});

	it("falls back to stale issue rows when a soft-expired synchronous refresh fails", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const fetchFresh = vi.fn(
			async (): Promise<{
				rendered: string;
				sourceUrl: undefined;
				payload: { number: number; refreshed: boolean };
			}> => {
				throw new Error("offline");
			},
		);
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 51,
			includeComments: true,
			payload: { number: 51, refreshed: false },
			rendered: "old",
			fetchedAt: Date.now() - 5 * 60_000,
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 51,
			includeComments: true,
			fetchFresh,
			settings,
		});

		expect(result.status).toBe("stale");
		expect(result.rendered).toBe("old");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});
	it("propagates aborts during a soft-expired synchronous refresh", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const controller = new AbortController();
		controller.abort();
		const fetchFresh = vi.fn(async () => {
			throwIfAborted(controller.signal);
			return {
				rendered: "never",
				sourceUrl: undefined,
				payload: { number: 53 },
			};
		});
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 53,
			includeComments: true,
			payload: { number: 53 },
			rendered: "stale-after-abort",
			fetchedAt: Date.now() - 5 * 60_000,
		});

		await expect(
			getOrFetchView({
				repo: TEST_REPO,
				kind: "issue",
				number: 53,
				includeComments: true,
				fetchFresh,
				settings,
			}),
		).rejects.toThrow(ToolAbortError);
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("keeps PR diff rows stale-first past soft TTL", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "refreshed-diff",
			sourceUrl: undefined,
			payload: { files: [], refreshed: true },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 52,
			includeComments: false,
			payload: { files: [], refreshed: false },
			rendered: "old-diff",
			fetchedAt: Date.now() - 5 * 60_000,
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 52,
			includeComments: false,
			fetchFresh,
			settings,
		});

		expect(result.status).toBe("stale");
		expect(result.rendered).toBe("old-diff");

		for (let i = 0; i < 100; i++) {
			const refreshed = getCached<{ refreshed: boolean }>(TEST_REPO, "pr-diff", 52, false);
			if (refreshed?.payload.refreshed) break;
			await Bun.sleep(0);
		}

		expect(fetchFresh).toHaveBeenCalledTimes(1);
		const updated = getCached<{ refreshed: boolean }>(TEST_REPO, "pr-diff", 52, false);
		expect(updated?.rendered).toBe("refreshed-diff");
		expect(updated?.payload.refreshed).toBe(true);
	});

	it("treats past-hard-TTL rows as cache misses (fetcher runs)", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 120,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "fresh-content",
			sourceUrl: undefined,
			payload: { number: 99 },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 99,
			includeComments: true,
			payload: { number: 99 },
			rendered: "ancient",
			fetchedAt: Date.now() - 1_000_000, // way past hard TTL
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 99,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("miss");
		expect(result.rendered).toBe("fresh-content");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("does not return soft-fresh rows past a shorter hard TTL", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 300,
			"github.cache.hardTtlSec": 10,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "fresh-after-hard-expiry",
			sourceUrl: undefined,
			payload: { number: 88 },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 88,
			includeComments: true,
			payload: { number: 88 },
			rendered: "hard-expired",
			fetchedAt: Date.now() - 20_000,
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 88,
			includeComments: true,
			fetchFresh,
			settings,
		});

		expect(result.status).toBe("miss");
		expect(result.rendered).toBe("fresh-after-hard-expiry");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("bypasses the cache entirely when github.cache.enabled = false", async () => {
		const settings = Settings.isolated({ "github.cache.enabled": false });
		const fetchFresh = vi.fn(async () => ({
			rendered: "always-fresh",
			sourceUrl: undefined,
			payload: { number: 11 },
		}));
		// Pre-populate the cache; with the kill switch the wrapper must ignore it.
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 11,
			includeComments: true,
			payload: { number: 11 },
			rendered: "cached-but-ignored",
			fetchedAt: Date.now(),
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 11,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("disabled");
		expect(result.rendered).toBe("always-fresh");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});
});

describe("getOrFetchIssue (gh-wired wrapper)", () => {
	it("second call within the soft TTL window does not invoke gh", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue(issuePayload(123, "body") as never);

		const first = await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "123",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(first.status).toBe("miss");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "123",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(second.status).toBe("fresh");
		expect(second.rendered).toBe(first.rendered);
		expect(spy).toHaveBeenCalledTimes(1); // unchanged — cache hit
	});

	it("derives (repo, number) from a full GitHub issue URL identifier", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue(issuePayload(7, "from-url") as never);
		const url = `https://github.com/${TEST_REPO}/issues/7`;

		await getOrFetchIssue({ cwd: "/tmp/test", issue: url, cacheAuthKey: TEST_AUTH_KEY });
		// Second hit by plain number + explicit repo must read the same row.
		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "7", cacheAuthKey: TEST_AUTH_KEY });
		expect(spy).toHaveBeenCalledTimes(1);

		const cached = getCached(TEST_REPO, "issue", 7, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).toContain("Issue #7");
	});

	it("caches comments-on and comments-off separately", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue(issuePayload(5, "no-comments-body") as never);

		await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "5",
			includeComments: false,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "5",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		// Different keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);

		// Each subsequent same-key call hits the cache.
		await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "5",
			includeComments: false,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "5",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("getOrFetchPr (gh-wired wrapper)", () => {
	it("caches PR view by (repo, number) and re-uses on the second call", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue(prPayload(77, "pr-body") as never);

		const first = await getOrFetchPr({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			number: 77,
			includeComments: false,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(first.status).toBe("miss");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await getOrFetchPr({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			number: 77,
			includeComments: false,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(second.status).toBe("fresh");
		expect(second.rendered).toBe(first.rendered);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
