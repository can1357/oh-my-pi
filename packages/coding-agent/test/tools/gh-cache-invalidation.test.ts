/**
 * Tests for the bash-side gh-cache invalidation parser. Verifies that the
 * detector drops cache rows for state-mutating `gh issue|pr` ops while
 * leaving unrelated commands and read-only `gh` calls alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateGithubCacheForBashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/tools/gh-cache-invalidation";
import {
	getCached,
	putCached,
	resetForTests as resetCacheForTests,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools/github-cache";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const REPO = "owner/example";

function issuePayload(number: number) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		author: { login: "octocat" },
		body: "body",
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/${REPO}/issues/${number}`,
		labels: [],
		comments: [],
	};
}

function prPayload(number: number) {
	return {
		number,
		title: `PR #${number}`,
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		headRefName: "feature/x",
		author: { login: "octocat" },
		body: "body",
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/${REPO}/pull/${number}`,
		labels: [],
		files: [],
		reviews: [],
		comments: [],
	};
}

function seedIssue(number: number, repo = REPO): void {
	putCached({
		repo,
		kind: "issue",
		number,
		includeComments: true,
		payload: issuePayload(number),
		rendered: `issue-${repo}-${number}`,
		fetchedAt: 1_000,
	});
}

function seedPr(number: number, repo = REPO): void {
	putCached({
		repo,
		kind: "pr",
		number,
		includeComments: true,
		payload: prPayload(number),
		rendered: `pr-${repo}-${number}`,
		fetchedAt: 1_000,
	});
}

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-inv-"));
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

describe("invalidateGithubCacheForBashCommand", () => {
	it("drops cache for `gh issue close <num>`", () => {
		seedIssue(42);
		invalidateGithubCacheForBashCommand("gh issue close 42");
		expect(getCached(REPO, "issue", 42, true)).toBeNull();
	});

	it("drops cache for `gh pr merge <num>` with extra flags", () => {
		seedPr(7);
		invalidateGithubCacheForBashCommand("gh pr merge 7 --squash --delete-branch");
		expect(getCached(REPO, "pr", 7, true)).toBeNull();
	});

	it("drops cache for a full PR URL argument", () => {
		seedPr(123, "other/repo");
		invalidateGithubCacheForBashCommand("gh pr close https://github.com/other/repo/pull/123");
		expect(getCached("other/repo", "pr", 123, true)).toBeNull();
	});

	it("drops cache when --repo is supplied separately", () => {
		seedIssue(9, "third/repo");
		invalidateGithubCacheForBashCommand("gh issue reopen 9 --repo third/repo");
		expect(getCached("third/repo", "issue", 9, true)).toBeNull();
	});

	it("drops cache for combined `--repo=<owner/repo>` form", () => {
		seedIssue(11, "fourth/repo");
		invalidateGithubCacheForBashCommand("gh issue close 11 --repo=fourth/repo");
		expect(getCached("fourth/repo", "issue", 11, true)).toBeNull();
	});

	it("leaves the cache alone for read-only `gh issue view`", () => {
		seedIssue(5);
		invalidateGithubCacheForBashCommand("gh issue view 5");
		expect(getCached(REPO, "issue", 5, true)?.rendered).toBe(`issue-${REPO}-5`);
	});

	it("invalidates the relevant issue when the command is chained after another", () => {
		seedIssue(1);
		invalidateGithubCacheForBashCommand("git add -A && gh issue close 1");
		expect(getCached(REPO, "issue", 1, true)).toBeNull();
	});

	it("handles quoted issue URL", () => {
		seedIssue(33, "quoted/repo");
		invalidateGithubCacheForBashCommand("gh issue close 'https://github.com/quoted/repo/issues/33'");
		expect(getCached("quoted/repo", "issue", 33, true)).toBeNull();
	});

	it("no-ops on commands that do not mention gh", () => {
		seedIssue(99);
		invalidateGithubCacheForBashCommand("echo hello world");
		expect(getCached(REPO, "issue", 99, true)?.rendered).toBe(`issue-${REPO}-99`);
	});

	it("invalidates across all repos when only a bare number is supplied", () => {
		seedIssue(50, "a/one");
		seedIssue(50, "b/two");
		invalidateGithubCacheForBashCommand("gh issue close 50");
		expect(getCached("a/one", "issue", 50, true)).toBeNull();
		expect(getCached("b/two", "issue", 50, true)).toBeNull();
	});

	it("invalidates only the matching repo when --repo is supplied", () => {
		seedIssue(60, "a/one");
		seedIssue(60, "b/two");
		invalidateGithubCacheForBashCommand("gh issue close 60 --repo a/one");
		expect(getCached("a/one", "issue", 60, true)).toBeNull();
		expect(getCached("b/two", "issue", 60, true)?.rendered).toBe("issue-b/two-60");
	});

	it("skips value-taking flag arguments so the positional number wins", () => {
		seedPr(14);
		seedPr(3);
		invalidateGithubCacheForBashCommand("gh pr edit --milestone 3 14");
		expect(getCached(REPO, "pr", 14, true)).toBeNull();
		expect(getCached(REPO, "pr", 3, true)?.rendered).toBe(`pr-${REPO}-3`);
	});

	it("falls back to repo-wide invalidation for current-branch `gh pr merge`", () => {
		seedPr(7);
		invalidateGithubCacheForBashCommand("gh pr merge --squash --delete-branch");
		expect(getCached(REPO, "pr", 7, true)).toBeNull();
	});

	it("scopes the no-positional fallback to --repo when provided", () => {
		seedPr(7, "a/one");
		seedPr(8, "b/two");
		invalidateGithubCacheForBashCommand("gh pr close --repo a/one");
		expect(getCached("a/one", "pr", 7, true)).toBeNull();
		expect(getCached("b/two", "pr", 8, true)?.rendered).toBe("pr-b/two-8");
	});
});
