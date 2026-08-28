/**
 * `issue://` / `pr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache + router singletons. `git.github.json` / `git.github.text` are spied
 * per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;
let originalEnv: string | undefined;

let originalGhToken: string | undefined;
beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pr-protocol-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	originalGhToken = process.env.GH_TOKEN;
	process.env.GH_TOKEN = "test-token";
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

function issuePayload(number: number, body: string, commentBodies: string[] = []) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/issues/${number}`,
		labels: [],
		comments: commentBodies.map((cb, idx) => ({
			author: { login: `user${idx}` },
			body: cb,
			createdAt: "2026-04-01T11:00:00Z",
			url: `https://github.com/owner/example/issues/${number}#issuecomment-${idx + 1}`,
			isMinimized: false,
		})),
	};
}

interface PrPayloadReview {
	author: { login: string };
	body: string;
	commit: { oid: string };
	state: string;
	submittedAt: string;
}

function prPayload(number: number, body: string) {
	const reviews: PrPayloadReview[] = [];
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
		url: `https://github.com/owner/example/pull/${number}`,
		labels: [],
		files: [],
		reviews,
		comments: [],
	};
}

function requestedJsonFields(args: string[]): Set<string> {
	const jsonIndex = args.indexOf("--json");
	const fieldsArg = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
	return new Set((fieldsArg ?? "").split(",").filter(Boolean));
}

function prPayloadWithRequestedFields(args: string[], number: number, body: string) {
	const payload = prPayload(number, body);
	const fields = requestedJsonFields(args);
	if (fields.has("reviews")) {
		payload.reviews = [
			{
				author: { login: "approver" },
				body: "Approved from the formal review flow.",
				commit: { oid: "1234567890abcdef1234567890abcdef12345678" },
				state: "APPROVED",
				submittedAt: "2026-04-01T12:00:00Z",
			},
		];
	}
	return payload;
}

interface DiffFileSpec {
	name: string;
	adds?: number;
	dels?: number;
	mode?: "modified" | "added" | "deleted";
	oldName?: string;
	binary?: boolean;
}

function makePrDiff(files: DiffFileSpec[]): string {
	return files
		.map(f => {
			const oldPath = f.oldName ?? f.name;
			const lines: string[] = [`diff --git a/${oldPath} b/${f.name}`];
			if (f.mode === "added") lines.push("new file mode 100644");
			if (f.mode === "deleted") lines.push("deleted file mode 100644");
			if (f.oldName) {
				lines.push(`rename from ${oldPath}`, `rename to ${f.name}`);
			}
			lines.push("index 0000000..1111111 100644");
			lines.push(`--- a/${oldPath}`);
			lines.push(`+++ b/${f.name}`);
			if (f.binary) {
				lines.push(`Binary files a/${oldPath} and b/${f.name} differ`);
			} else {
				lines.push("@@ -1,1 +1,1 @@");
				for (let i = 0; i < (f.dels ?? 0); i += 1) lines.push(`-old line ${i}`);
				for (let i = 0; i < (f.adds ?? 0); i += 1) lines.push(`+new line ${i}`);
			}
			return lines.join("\n");
		})
		.join("\n");
}

describe("issue:// protocol handler", () => {
	it("resolves issue://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "issue body", ["c1"]) as never);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("issue://owner/example/42");

		expect(first.contentType).toBe("text/markdown");
		expect(first.url).toBe("issue://owner/example/42");
		expect(first.content).toContain("# Issue #42: Issue #42");
		expect(first.immutable).toBe(true);
		expect(first.notes?.[0]).toBe("Fetched live");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await router.resolve("issue://owner/example/42");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Same key, soft TTL hit — no additional gh invocation.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("marks soft-expired issue fallback content as stale when live refresh fails", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(43, "cached body") as never);
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 0,
			"github.cache.hardTtlSec": 86400,
		});

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/example/43");
		await Bun.sleep(1);
		spy.mockImplementation(async () => {
			throw new Error("offline");
		});

		const resource = await router.resolve("issue://owner/example/43", { settings });
		expect(resource.content.startsWith("> WARNING: Live GitHub refresh failed")).toBe(true);
		expect(resource.notes?.[0]).toMatch(/^WARNING: showing cached content/);
		expect(resource.content).toContain("cached body");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("retries issue://owner/repo/<n> without stateReason when gh does not support it", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (requestedJsonFields(args).has("stateReason")) {
				throw new Error('Unknown JSON field: "stateReason"');
			}
			return issuePayload(42, "issue body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example/42");

		expect(resource.content).toContain("# Issue #42: Issue #42");
		expect(resource.content).not.toContain("State reason");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[]).has("stateReason")).toBe(true);
		expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[]).has("stateReason")).toBe(false);
	});

	it("?comments=0 selects a separate cache row with comments suppressed", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValue(issuePayload(9, "body9", ["visible comment"]) as never);

		const router = InternalUrlRouter.instance();
		const withComments = await router.resolve("issue://owner/example/9");
		const without = await router.resolve("issue://owner/example/9?comments=0");

		// Two distinct keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(withComments.content).toContain("visible comment");
		expect(without.content).not.toContain("visible comment");
		// Note metadata reflects the toggle on the comments-off variant.
		expect(without.notes).toContain("Comments disabled");
	});

	it("rejects invalid issue:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		// 4-or-more segments fall through to the catch-all "Invalid …" error.
		await expect(router.resolve("issue://owner/example/foo/bar")).rejects.toThrow(/Invalid issue:\/\/ URL/);
		// Non-numeric single segment fails the number check.
		await expect(router.resolve("issue://abc")).rejects.toThrow(/Invalid issue:\/\/ number/);
	});
});

describe("pr:// protocol handler", () => {
	it("resolves pr://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77");

		expect(first.contentType).toBe("text/markdown");
		expect(first.content).toContain("# Pull Request #77: PR #77");
		expect(first.immutable).toBe(true);
		expect(first.notes).toContain("Diff: pr://owner/example/77/diff");
		// First call hits gh twice (view JSON + review-comments page).
		expect(spy).toHaveBeenCalledTimes(2);

		const second = await router.resolve("pr://owner/example/77");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Second call is a soft-TTL hit — no further gh invocations.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("requests and renders formal reviews when comments are enabled", async () => {
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/78/comments")) {
				return [] as never;
			}
			return prPayloadWithRequestedFields(args, 78, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/78");

		expect(resource.content).toContain("## Reviews (1)");
		expect(resource.content).toContain("### @approver - 2026-04-01T12:00:00Z [APPROVED]");
		expect(resource.content).toContain("Approved from the formal review flow.");
	});

	it("rejects invalid pr:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/foo/bar")).rejects.toThrow(/Invalid pr:\/\/ URL/);
		await expect(router.resolve("pr://owner/example/abc")).rejects.toThrow(/Invalid pr:\/\/ number/);
	});

	it("rejects empty / dot / dotdot path segments", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner//77")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("pr://owner/repo/77/diff//2")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("pr://owner/../77/diff")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("issue://owner/./repo/1")).rejects.toThrow(
			/Invalid issue:\/\/ URL: empty or unsafe path segment/,
		);
	});

	it("routes pr://<host>/<owner>/<repo>/<n> at that host", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://ghe.example.com/owner/example/77");

		expect(resource.content).toContain("# Pull Request #77: PR #77");
		// `gh pr view` takes `[HOST/]OWNER/REPO` in --repo…
		const viewArgs = spy.mock.calls[0]?.[1] as string[];
		expect(viewArgs[viewArgs.indexOf("--repo") + 1]).toBe("ghe.example.com/owner/example");
		// …while `gh api` paths cannot carry a host, so it rides as a flag.
		const apiArgs = spy.mock.calls[1]?.[1] as string[];
		expect(apiArgs).toContain("/repos/owner/example/pulls/77/comments");
		expect(apiArgs[apiArgs.indexOf("--hostname") + 1]).toBe("ghe.example.com");
		expect(resource.notes).toContain("Diff: pr://ghe.example.com/owner/example/77/diff");
	});

	it("routes a single-label host prefix by shape", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		// `ghe` carries no dot, so the number position is what separates
		// `<host>/<owner>/<repo>/<n>` from `<owner>/<repo>/<n>/diff`.
		const resource = await router.resolve("pr://ghe/owner/example/77");

		const viewArgs = spy.mock.calls[0]?.[1] as string[];
		expect(viewArgs[viewArgs.indexOf("--repo") + 1]).toBe("ghe/owner/example");
		expect(resource.notes).toContain("Diff: pr://ghe/owner/example/77/diff");
	});

	it("keeps the bare diff form out of the host-prefix branch", async () => {
		const spy = vi.spyOn(git.github, "text").mockResolvedValue(makePrDiff([{ name: "a.ts", adds: 1, dels: 0 }]));

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff/1");

		// `owner` is not a host here: the diff slice belongs to owner/example#77.
		const diffArgs = spy.mock.calls[0]?.[1] as string[];
		expect(diffArgs[diffArgs.indexOf("--repo") + 1]).toBe("owner/example");
		expect(resource.content).toContain("a.ts");
	});

	it("shares one cache row with the bare form while still pinning github.com", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/79/comments")) {
				return [] as never;
			}
			return prPayload(79, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const prefixed = await router.resolve("pr://github.com/owner/example/79");
		// An explicit host reaches `gh`, which would otherwise resolve a
		// host-less --repo against GH_HOST.
		const viewArgs = spy.mock.calls[0]?.[1] as string[];
		expect(viewArgs[viewArgs.indexOf("--repo") + 1]).toBe("github.com/owner/example");

		const bare = await router.resolve("pr://owner/example/79");
		// Both spellings key the same row, so the bare form is a cache hit.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(prefixed.notes?.[0]).toBe("Fetched live");
		expect(bare.notes?.[0]).toMatch(/^Cached:/);
	});

	it("keeps github.com rows separate from the host GH_HOST names", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.some(arg => arg.endsWith("/comments"))) {
				return [] as never;
			}
			return prPayload(81, "pr body") as never;
		});

		const saved = process.env.GH_HOST;
		process.env.GH_HOST = "ghe.example.com";
		try {
			const router = InternalUrlRouter.instance();
			await router.resolve("pr://owner/example/81");
			// The bare form above belongs to ghe.example.com, so github.com's #81
			// is a different pull request and must be fetched, not served from it.
			const explicit = await router.resolve("pr://github.com/owner/example/81");
			expect(explicit.notes?.[0]).toBe("Fetched live");
			expect(spy).toHaveBeenCalledTimes(4);
		} finally {
			if (saved === undefined) {
				delete process.env.GH_HOST;
			} else {
				process.env.GH_HOST = saved;
			}
		}
	});

	it("rejects a host-prefixed URL that names no repository", async () => {
		const router = InternalUrlRouter.instance();
		await expect(InternalUrlRouter.instance().resolve("pr://ghe.example.com/owner")).rejects.toThrow(
			/Invalid pr:\/\/ URL/,
		);
		await expect(router.resolve("issue://ghe.example.com")).rejects.toThrow(/Invalid issue:\/\/ URL/);
	});
});

describe("pr://.../diff family", () => {
	const diffText = makePrDiff([
		{ name: "src/one.ts", adds: 3, dels: 1 },
		{ name: "src/two.ts", adds: 2, dels: 0, mode: "added" },
	]);

	it("pr://owner/repo/<n>/diff lists files with per-file hint URLs", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Pull Request Diff: owner/example#77 (2 files)");
		expect(resource.content).toContain("1. src/one.ts  +3 -1  [modified]");
		expect(resource.content).toContain("pr://owner/example/77/diff/1");
		expect(resource.content).toContain("2. src/two.ts  +2 -0  [added]");
		expect(resource.content).toContain("pr://owner/example/77/diff/2");
		expect(resource.notes?.[0]).toBe("Fetched live");
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("pr://owner/repo/<n>/diff renders an empty-file body when the PR has no changes", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("");

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");
		expect(resource.content).toContain("# Pull Request Diff: owner/example#77 (0 files)");
		expect(resource.content).toContain("_No file changes._");
	});

	it("pr://owner/repo/<n>/diff/all returns the verbatim unified diff as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff/all");
		expect(resource.contentType).toBe("text/plain");
		expect(resource.content).toBe(diffText);
	});

	it("pr://owner/repo/<n>/diff/<i> slices the i-th file (1-indexed) as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77/diff/1");
		expect(first.contentType).toBe("text/plain");
		expect(first.content.startsWith("diff --git a/src/one.ts b/src/one.ts")).toBe(true);
		expect(first.content).not.toContain("src/two.ts");
		expect(first.notes).toEqual(
			expect.arrayContaining(["Showing file 1/2: src/one.ts", "Read all: pr://owner/example/77/diff/all"]),
		);

		const second = await router.resolve("pr://owner/example/77/diff/2");
		expect(second.content.startsWith("diff --git a/src/two.ts b/src/two.ts")).toBe(true);
		expect(second.content).not.toContain("src/one.ts");
	});

	it("rejects out-of-range and non-decimal diff indices with friendly errors", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/77/diff/9")).rejects.toThrow(/out of range/);
		await expect(router.resolve("pr://owner/example/77/diff/foo")).rejects.toThrow(/Invalid pr:\/\/ diff sub-path/);
	});

	it("shares one `gh pr diff` invocation across /diff, /diff/all, and /diff/<i> reads", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await router.resolve("pr://owner/example/77/diff");
		await router.resolve("pr://owner/example/77/diff/all");
		await router.resolve("pr://owner/example/77/diff/1");
		// One row services all three variants — `gh pr diff` runs once.
		expect(textSpy).toHaveBeenCalledTimes(1);
	});
});

describe("issue://.../diff rejection", () => {
	it("issue://owner/example/9/diff rejects with 'Invalid issue:// URL'", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example/9/diff")).rejects.toThrow(/Invalid issue:\/\/ URL/);
	});

	it("issue://<N>/diff short form rejects with the same 'no diff' error (not a repo lookup)", async () => {
		// Regression: previously fell through to the `host && parts.length === 1`
		// branch and was misparsed as a repo named `<N>/diff`, producing a
		// confusing GraphQL "Could not resolve to a Repository" error instead.
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://9/diff")).rejects.toThrow(/Issue views do not have a diff/);
		await expect(router.resolve("issue://9/diff/all")).rejects.toThrow(/Issue views do not have a diff/);
		await expect(router.resolve("issue://9/diff/3")).rejects.toThrow(/Issue views do not have a diff/);
	});
});

describe("issue:// / pr:// listing", () => {
	it("issue://owner/repo issues a live `gh issue list` and renders entries", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 1,
				title: "Hello",
				state: "OPEN",
				author: { login: "alice" },
				labels: [{ name: "bug" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/example/issues/1",
			},
			{
				number: 2,
				title: "Second",
				state: "OPEN",
				author: { login: "bob" },
				labels: [],
				createdAt: "2026-04-02T08:00:00Z",
				updatedAt: "2026-04-02T09:00:00Z",
				url: "https://github.com/owner/example/issues/2",
			},
		] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Issues in owner/example");
		expect(resource.content).toContain("#1");
		expect(resource.content).toContain("Hello");
		expect(resource.content).toContain("labels: bug");
		expect(resource.content).toContain("issue://owner/example/1");
		expect(resource.notes?.[0]).toContain("Live listing for owner/example");

		expect(spy).toHaveBeenCalledTimes(1);
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args[0]).toBe("issue");
		expect(args[1]).toBe("list");
		expect(args).toEqual(expect.arrayContaining(["--repo", "owner/example"]));
		expect(args).toEqual(expect.arrayContaining(["--state", "open"]));
		expect(requestedJsonFields(args).has("stateReason")).toBe(false);
	});

	it("pr://owner/repo passes state and limit query params through to gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example?state=merged&limit=5&author=alice&label=bug");

		expect(resource.content).toContain("# Pull Requests in owner/example (merged, up to 5)");
		expect(resource.content).toContain("_No matches._");

		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--state", "merged"]));
		expect(args).toEqual(expect.arrayContaining(["--limit", "5"]));
		expect(args).toEqual(expect.arrayContaining(["--author", "alice"]));
		expect(args).toEqual(expect.arrayContaining(["--label", "bug"]));
	});

	it("invalid state errors instead of silently falling back to 'open'", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example?state=banana")).rejects.toThrow(
			/Invalid issue:\/\/ list state 'banana'/,
		);
		await expect(router.resolve("pr://owner/example?limit=abc")).rejects.toThrow(/Invalid pr:\/\/ list limit 'abc'/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("treats `diff` as a repository name in repo-scoped listing URLs", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/diff");
		await router.resolve("pr://owner/diff");

		const issueArgs = spy.mock.calls[0]?.[1] as string[];
		const prArgs = spy.mock.calls[1]?.[1] as string[];
		expect(issueArgs.slice(0, 2)).toEqual(["issue", "list"]);
		expect(prArgs.slice(0, 2)).toEqual(["pr", "list"]);
		expect(issueArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
		expect(prArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
	});

	it("issue:// (no repo, no session) surfaces a friendly resolution error", async () => {
		// resolveDefaultRepoMemoized calls `gh repo view`; intercept it.
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://")).rejects.toThrow(/could not resolve a default repo/);
	});
});

describe("cross-handler cache sharing", () => {
	it("identical markdown is served whether the protocol handler or a second handler call resolves it", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(101, "shared body") as never);

		const router = InternalUrlRouter.instance();
		const r1 = await router.resolve("issue://owner/example/101");
		const r2 = await router.resolve("issue://owner/example/101");
		expect(r2.content).toBe(r1.content);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
