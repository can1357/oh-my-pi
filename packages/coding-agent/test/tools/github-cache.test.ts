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
import { Database } from "bun:sqlite";
import {
	getCached,
	getCachedGeneration,
	getOrFetchView,
	getRetainedGeneration,
	invalidateAllForRepo,
	openDb,
	putCached,
	resetForTests as resetCacheForTests,
	resolveGitlabCacheAuthKey,
	retainCachedGeneration,
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

	// Windows has no POSIX directory mode bits to preserve (stat reports 0o666 regardless).
	it.skipIf(process.platform === "win32")("does not chmod an existing cache parent directory", async () => {
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

	it("migrates a v3 cache whose kind CHECK predates mr-diff rows", () => {
		const legacy = new Database(process.env.OMP_GITHUB_CACHE_DB!);
		legacy.run(`
			CREATE TABLE github_view_cache (
				auth_key TEXT NOT NULL, repo TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('issue','pr','pr-diff')),
				number INTEGER NOT NULL, include_comments INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
				payload TEXT NOT NULL, rendered TEXT NOT NULL, source_url TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments)
			);
			PRAGMA user_version = 3;
		`);
		legacy.close();
		resetCacheForTests();

		putCached({
			repo: "gitlab.com/g/p",
			kind: "mr-diff",
			number: 1,
			includeComments: false,
			payload: { unified: "", files: [] },
			rendered: "mr-diff-body",
			fetchedAt: 1000,
		});

		expect(getCached("gitlab.com/g/p", "mr-diff", 1, false)?.rendered).toBe("mr-diff-body");
	});

	it("adds revision to a v5 live cache without changing existing cache rows or PR pins", () => {
		const legacy = new Database(process.env.OMP_GITHUB_CACHE_DB!);
		legacy.run(`
			CREATE TABLE github_view_cache (
				auth_key TEXT NOT NULL, repo TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('issue','pr','pr-diff','mr','mr-diff','gl-issue')),
				number INTEGER NOT NULL, include_comments INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
				payload TEXT NOT NULL, rendered TEXT NOT NULL, source_url TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments)
			);
			CREATE TABLE github_view_cache_generation (
				auth_key TEXT NOT NULL, repo TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('issue','pr','pr-diff')),
				number INTEGER NOT NULL, include_comments INTEGER NOT NULL,
				fetched_at INTEGER NOT NULL, retained_at INTEGER NOT NULL,
				payload TEXT NOT NULL, rendered TEXT NOT NULL, source_url TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments, fetched_at)
			);
			INSERT INTO github_view_cache VALUES (
				'test-auth', 'owner/example', 'pr-diff', 321, 0, 12345,
				'{"files":[]}', 'live-pr-diff', NULL
			);
			INSERT INTO github_view_cache_generation VALUES (
				'test-auth', 'owner/example', 'pr-diff', 321, 0, 12345, 12346,
				'{"files":[]}', 'pinned-pr-diff', NULL
			);
			PRAGMA user_version = 5;
		`);
		legacy.close();
		resetCacheForTests();

		const live = getCached(TEST_REPO, "pr-diff", 321, false, TEST_AUTH_KEY);
		expect(live?.rendered).toBe("live-pr-diff");
		expect(live?.fetchedAt).toBe(12345);
		expect(live?.revision).toBeUndefined();
		expect(getCachedGeneration(TEST_REPO, "pr-diff", 321, false, 12345, TEST_AUTH_KEY)?.rendered).toBe(
			"pinned-pr-diff",
		);
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
			// Closed, so the short revalidation window for open issues does not apply.
			payload: { ...issuePayload(314, "old-body"), state: "CLOSED" },
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
		// Soft TTL >= 14d keeps the row fresh without changing its timestamp.
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

describe("resolveGitlabCacheAuthKey", () => {
	const ENV_KEYS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GLAB_CONFIG_DIR"] as const;
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		// Empty config dir: no glab config.yml credential material.
		process.env.GLAB_CONFIG_DIR = tempDir;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("separates GitLab tokens and bypasses caching without credentials", () => {
		expect(resolveGitlabCacheAuthKey("gitlab.com")).toBeUndefined();

		process.env.GITLAB_TOKEN = "token-a";
		const keyA = resolveGitlabCacheAuthKey("gitlab.com");
		process.env.GITLAB_TOKEN = "token-b";
		const keyB = resolveGitlabCacheAuthKey("gitlab.com");

		expect(keyA).toBeDefined();
		expect(keyB).toBeDefined();
		expect(keyA).not.toBe(keyB);
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

	it("revalidates an open PR within the soft TTL but serves a merged one from cache", async () => {
		for (const state of ["OPEN", "MERGED"]) {
			const fetchFresh = vi.fn(async () => ({
				rendered: "live",
				sourceUrl: undefined,
				payload: { number: 60, state: "MERGED" },
			}));
			putCached({
				repo: TEST_REPO,
				kind: "pr",
				number: 60,
				includeComments: true,
				payload: { number: 60, state },
				rendered: "cached",
				fetchedAt: Date.now() - 60_000, // within the default soft TTL
			});
			const result = await getOrFetchView({
				repo: TEST_REPO,
				kind: "pr",
				number: 60,
				includeComments: true,
				fetchFresh,
			});
			expect({ state, rendered: result.rendered }).toEqual({
				state,
				rendered: state === "OPEN" ? "live" : "cached",
			});
		}
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

	it("reuses a diff row only when the live revision matches, regardless of soft TTL", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const fetchRevision = vi.fn(async () => "base-a/head-a");
		const fetchFresh = vi.fn(async () => ({
			rendered: "live-diff",
			sourceUrl: undefined,
			payload: { files: [], refreshed: true },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 52,
			includeComments: false,
			payload: { files: [], refreshed: false },
			rendered: "cached-diff",
			revision: "base-a/head-a",
			fetchedAt: Date.now() - 5 * 60_000,
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 52,
			includeComments: false,
			fetchRevision,
			fetchFresh,
			settings,
		});

		expect(result.status).toBe("fresh");
		expect(result.rendered).toBe("cached-diff");
		expect(fetchRevision).toHaveBeenCalledTimes(1);
		expect(fetchFresh).not.toHaveBeenCalled();
	});

	it("rejects a diff when its revision changes during the live fetch", async () => {
		const fetchRevision = vi
			.fn<() => Promise<string | undefined>>()
			.mockResolvedValueOnce("base-b/head-b")
			.mockResolvedValueOnce("base-c/head-c");
		const fetchFresh = vi.fn(async () => ({
			rendered: "live-diff",
			sourceUrl: undefined,
			payload: { files: [] },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 54,
			includeComments: false,
			payload: { files: [] },
			rendered: "old-diff",
			revision: "base-a/head-a",
		});

		await expect(
			getOrFetchView({
				repo: TEST_REPO,
				kind: "pr-diff",
				number: 54,
				includeComments: false,
				fetchRevision,
				fetchFresh,
			}),
		).rejects.toThrow(/revision changed while fetching/i);
		expect(fetchFresh).toHaveBeenCalledTimes(1);
		expect(getCached(TEST_REPO, "pr-diff", 54, false)?.rendered).toBe("old-diff");
	});

	it("fetches live without caching when the revision is unavailable", async () => {
		const fetchFresh = vi.fn(async () => ({
			rendered: "live-diff",
			sourceUrl: undefined,
			payload: { files: [] },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 55,
			includeComments: false,
			payload: { files: [] },
			rendered: "unchecked-diff",
			revision: "base-a/head-a",
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 55,
			includeComments: false,
			fetchRevision: async () => undefined,
			fetchFresh,
		});

		expect(result.rendered).toBe("live-diff");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
		expect(getCached(TEST_REPO, "pr-diff", 55, false)?.rendered).toBe("unchecked-diff");
	});

	it("does not retain generations for live diff writes or reads", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const revision = "base-a/head-a";
		const firstAt = Date.now() - 5 * 60_000;
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 88,
			includeComments: false,
			payload: { files: [] },
			rendered: "same-diff",
			revision,
			fetchedAt: firstAt,
		});
		putCached({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 88,
			includeComments: false,
			payload: { files: [] },
			rendered: "same-diff",
			revision,
			fetchedAt: firstAt + 1_000,
		});

		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 88,
			includeComments: false,
			fetchRevision: async () => revision,
			fetchFresh: async () => ({
				rendered: "should-not-run",
				sourceUrl: undefined,
				payload: { files: [] },
			}),
			settings,
		});

		expect(result.status).toBe("fresh");
		expect(result.rendered).toBe("same-diff");
		const generations = openDb()?.query("SELECT COUNT(*) AS c FROM github_view_cache_generation").get() as
			| { c: number }
			| undefined;
		expect(generations?.c).toBe(0);
	});

	it("keeps a published generation when a different diff reuses its timestamp", () => {
		const fetchedAt = Date.now();
		const retain = (rendered: string) =>
			retainCachedGeneration({
				repo: TEST_REPO,
				kind: "pr-diff",
				number: 91,
				includeComments: false,
				payload: { files: [] },
				rendered,
				fetchedAt,
			});

		expect(retain("first-diff")).toBe(fetchedAt);
		expect(retain("second-diff")).toBe(fetchedAt + 1);
		expect(retain("first-diff")).toBe(fetchedAt);
		expect(getCachedGeneration(TEST_REPO, "pr-diff", 91, false, fetchedAt)?.rendered).toBe("first-diff");
		expect(getCachedGeneration(TEST_REPO, "pr-diff", 91, false, fetchedAt + 1)?.rendered).toBe("second-diff");
	});

	it("counts pinned retention from when the generation was retained, not fetched", () => {
		const settings = Settings.isolated({ "github.cache.hardTtlSec": 3600 });
		const now = Date.now();
		// A stale live row /review pins near the end of its hard TTL.
		const fetchedAt = now - 3500_000;
		expect(
			retainCachedGeneration({
				repo: TEST_REPO,
				kind: "pr-diff",
				number: 92,
				includeComments: false,
				payload: { files: [] },
				rendered: "pinned-diff",
				fetchedAt,
			}),
		).toBe(fetchedAt);

		vi.spyOn(Date, "now").mockReturnValue(now + 600_000);
		expect(getRetainedGeneration(TEST_REPO, "pr-diff", 92, false, fetchedAt, undefined, settings)?.rendered).toBe(
			"pinned-diff",
		);

		vi.spyOn(Date, "now").mockReturnValue(now + 3700_000);
		expect(getRetainedGeneration(TEST_REPO, "pr-diff", 92, false, fetchedAt, undefined, settings)).toBeNull();
		expect(getCachedGeneration(TEST_REPO, "pr-diff", 92, false, fetchedAt)).toBeNull();
	});

	it("does not let a diff fetch started before invalidation overwrite the post-invalidation row", async () => {
		const oldRefresh = Promise.withResolvers<{
			rendered: string;
			sourceUrl: undefined;
			payload: { head: string };
		}>();
		const started = Promise.withResolvers<void>();
		const options = {
			repo: TEST_REPO,
			kind: "pr-diff" as const,
			number: 54,
			includeComments: false,
			settings: Settings.isolated({ "github.cache.softTtlSec": 60 }),
			fetchRevision: async () => "base-a/head-a",
			fetchFresh: () => {
				started.resolve();
				return oldRefresh.promise;
			},
		};
		const oldLookup = getOrFetchView(options);
		await started.promise;
		invalidateAllForRepo(TEST_REPO);
		const next = await getOrFetchView({
			...options,
			fetchRevision: async () => "base-b/head-b",
			fetchFresh: async () => ({ rendered: "head B", sourceUrl: undefined, payload: { head: "B" } }),
		});
		expect(next.rendered).toBe("head B");
		oldRefresh.resolve({ rendered: "head A", sourceUrl: undefined, payload: { head: "A" } });
		await oldLookup;
		expect(getCached(TEST_REPO, "pr-diff", 54, false)?.rendered).toBe("head B");
		expect(getCached(TEST_REPO, "pr-diff", 54, false)?.revision).toBe("base-b/head-b");
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

describe("GitLab cache isolation and open-state soft TTL", () => {
	it("uses 15s soft TTL for 'opened' MRs and isolates project paths when GH_HOST is set", async () => {
		const prevGhHost = process.env.GH_HOST;
		process.env.GH_HOST = "gitlab.example.com";
		try {
			const settings = Settings.isolated({ "github.cache.softTtlSec": 300 });
			const project = "gitlab.example.com/acme/api";
			const now = Date.now();
			const fetchedAt = now - 10_000;
			putCached({
				repo: project,
				kind: "mr",
				number: 4,
				includeComments: true,
				payload: { state: "opened" },
				rendered: "open-mr",
				fetchedAt,
			});
			expect(getCached(project, "mr", 4, true)?.repo).toBe(project);

			let fetches = 0;
			const fresh = await getOrFetchView({
				repo: project,
				kind: "mr",
				number: 4,
				includeComments: true,
				settings,
				now,
				fetchFresh: async () => {
					fetches += 1;
					return { rendered: "refreshed", sourceUrl: undefined, payload: { state: "opened" } };
				},
			});
			expect(fresh.status).toBe("fresh");
			expect(fetches).toBe(0);

			const refreshed = await getOrFetchView({
				repo: project,
				kind: "mr",
				number: 4,
				includeComments: true,
				settings,
				now: now + 10_000,
				fetchFresh: async () => {
					fetches += 1;
					return { rendered: "refreshed", sourceUrl: undefined, payload: { state: "opened" } };
				},
			});
			expect(refreshed.status).toBe("refreshed");
			expect(fetches).toBe(1);
		} finally {
			if (prevGhHost === undefined) delete process.env.GH_HOST;
			else process.env.GH_HOST = prevGhHost;
		}
	});
});
