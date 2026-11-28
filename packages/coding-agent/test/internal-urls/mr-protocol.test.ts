/**
 * `mr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache, router, and default-project singletons. `gitlab.json` / `gitlab.text`
 * are spied per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchPrReviewTarget } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetDefaultGitlabProjectMemoForTests } from "@oh-my-pi/pi-coding-agent/tools/glab-mr";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { gitlab } from "@oh-my-pi/pi-coding-agent/utils/gitlab";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const diffText = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -1 +1 @@
-one
+uno
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1 +1 @@
-two
+dos
`;
const secondSection = diffText.slice(diffText.indexOf("diff --git a/src/two.ts"));
const updatedDiffText = diffText.replaceAll("src/one.ts", "src/current.ts").replace("-one\n+uno", "-old\n+new");

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
	"GITLAB_HOST",
	"GITLAB_URI",
	"GITLAB_URL",
	"GL_HOST",
	"GLAB_CONFIG_DIR",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-protocol-"));
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	process.env.GITLAB_TOKEN = "test-token";
	process.env.GITLAB_HOST = "gitlab.example.com";
	// Empty dir: no glab config.yml hosts unless a test writes one.
	process.env.GLAB_CONFIG_DIR = tempDir;
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	resetDefaultGitlabProjectMemoForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	resetDefaultGitlabProjectMemoForTests();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

describe("mr:// diff family", () => {
	it("lists changed files of a nested-group project with per-file mr:// links", async () => {
		stubMrRevision();
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.example.com/acme/platform/api/7/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/1");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/2");
		const args = textSpy.mock.calls[0]![1] as string[];
		expect(args.slice(0, 5)).toEqual(["mr", "diff", "7", "-R", "https://gitlab.example.com/acme/platform/api"]);
	});

	it("slices one file, returns the full diff, and rejects an out-of-range index", async () => {
		stubMrRevision();
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const slice = await router.resolve("mr://gitlab.com/g/p/7/diff/2");
		expect(slice.content).toBe(secondSection);
		const all = await router.resolve("mr://gitlab.com/g/p/7/diff/all");
		expect(all.content).toBe(diffText);
		await expect(router.resolve("mr://gitlab.com/g/p/7/diff/3")).rejects.toThrow(/MR has 2 files/);
	});

	it("reuses the patch when the live refs have not changed", async () => {
		stubMrRevision();
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const first = await router.resolve("mr://gitlab.com/g/p/7/diff/1");
		const second = await router.resolve("mr://gitlab.com/g/p/7/diff/1");

		expect(first.notes?.[0]).toBe("Fetched live");
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("refreshes changed MR refs and keeps a pinned diff offline", async () => {
		const project = "gitlab.example.com/acme/api";
		let metadata = {
			sha: "head-a",
			diff_refs: { base_sha: "base-a", head_sha: "head-a", start_sha: "start-a" },
		};
		const apiSpy = vi.spyOn(gitlab, "json").mockImplementation(async (_cwd, args) => {
			if (args.join(" ") !== "api --hostname gitlab.example.com projects/acme%2Fapi/merge_requests/7") {
				throw new Error(`Unexpected glab json call: ${args.join(" ")}`);
			}
			return metadata as never;
		});
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();
		const liveUrl = `mr://${project}/7/diff`;
		const selected = await fetchPrReviewTarget(tempDir, {
			forge: "gitlab",
			repo: project,
			number: 7,
			raw: liveUrl,
			kind: "mr-url",
		});

		metadata = {
			sha: "head-b",
			diff_refs: { base_sha: "base-b", head_sha: "head-a", start_sha: "start-b" },
		};
		await expect(router.resolve(liveUrl)).rejects.toThrow(/MR diff is still being prepared/);
		expect(textSpy).toHaveBeenCalledTimes(1);

		metadata = {
			sha: "head-b",
			diff_refs: { base_sha: "base-b", head_sha: "head-b", start_sha: "start-b" },
		};
		textSpy.mockResolvedValue(updatedDiffText);
		const updated = await router.resolve(liveUrl);
		expect(updated.content).toContain("src/current.ts");
		expect(textSpy).toHaveBeenCalledTimes(2);

		const metadataCalls = apiSpy.mock.calls.length;
		const pinnedList = await router.resolve(`${selected.prDiffUrl}${selected.prDiffQuery}`);
		const sliceUrl = `${liveUrl}/2${selected.prDiffQuery}`;
		const allUrl = `${liveUrl}/all${selected.prDiffQuery}`;
		expect(pinnedList.content).toContain(sliceUrl);
		expect(pinnedList.content).toContain(allUrl);
		expect((await router.resolve(sliceUrl)).content).toBe(secondSection);
		expect((await router.resolve(allUrl)).content).toBe(diffText);
		expect(apiSpy).toHaveBeenCalledTimes(metadataCalls);
		expect(textSpy).toHaveBeenCalledTimes(2);
	});

	it("resolves the short form against the project glab reports for the session cwd", async () => {
		const jsonSpy = vi
			.spyOn(gitlab, "json")
			.mockResolvedValue({ web_url: "https://gitlab.example.com/acme/platform/api" });
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://7/diff", { cwd: tempDir });

		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
		expect(jsonSpy.mock.calls[0]![1]).toEqual(["repo", "view", "-F", "json"]);
	});

	it("rejects URLs without a group/project pair, invalid host, or plain host", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mr://gitlab.com")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com/g/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com@evil.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://evil%1B%5D8%3B%3B.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("retries without --raw when the instance has no raw diff endpoint", async () => {
		stubMrRevision();
		const textSpy = vi
			.spyOn(gitlab, "text")
			.mockRejectedValueOnce(new Error("could not obtain raw diff: 404 Not Found"))
			.mockResolvedValueOnce(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.com/g/p/7/diff");

		expect(resource.content).toContain("(2 files)");
		expect(textSpy).toHaveBeenCalledTimes(2);
		expect(textSpy.mock.calls[0]![1]).toContain("--raw");
		expect(textSpy.mock.calls[1]![1]).not.toContain("--raw");
	});

	it("fails with an upgrade hint instead of parsing an old glab's header-less diff", async () => {
		stubMrRevision();
		const textSpy = vi.spyOn(gitlab, "text").mockRejectedValue(new Error("unknown flag: --raw"));

		await expect(InternalUrlRouter.instance().resolve("mr://gitlab.com/g/p/7/diff")).rejects.toThrow(
			/too old for `glab mr diff --raw`/,
		);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps env tokens away from hosts the user has not configured", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		vi.spyOn(gitlab, "json").mockResolvedValue({ web_url: "https://git.own.example/team/app" });
		const router = InternalUrlRouter.instance();
		const context = { cwd: tempDir };

		await expect(router.resolve("mr://attacker.example/a/b/1/diff", context)).rejects.toThrow(
			/Refusing to send GitLab token environment variables to attacker\.example/,
		);
		expect(textSpy).not.toHaveBeenCalled();

		const ownCheckout = await router.resolve("mr://git.own.example/team/app/1/diff", context);
		expect(ownCheckout.content).toContain("(2 files)");

		await Bun.write(path.join(tempDir, "config.yml"), "hosts:\n    git.corp.example:\n        token: stored\n");
		const configured = await router.resolve("mr://git.corp.example/a/b/1/diff", context);
		expect(configured.content).toContain("(2 files)");

		delete process.env.GITLAB_TOKEN;
		const withoutEnvToken = await router.resolve("mr://other.example/a/b/1/diff", context);
		expect(withoutEnvToken.content).toContain("(2 files)");
	});
});

const spyGitlabJson = (handler: (cwd: string, args: string[]) => Promise<unknown>) =>
	vi.spyOn(gitlab, "json").mockImplementation((cwd, args) => handler(cwd, args) as Promise<never>);

const stubMrRevision = (revision = "head-a") =>
	vi.spyOn(gitlab, "json").mockResolvedValue({
		sha: revision,
		diff_refs: { base_sha: "base-a", head_sha: revision, start_sha: "start-a" },
	} as never);

describe("mr:// list and single-MR views", () => {
	const sampleMr = {
		id: 1001,
		iid: 7,
		title: "Add GitLab MR protocol support",
		description: "Full overview with discussions.",
		state: "opened",
		draft: false,
		source_branch: "feat/mr",
		target_branch: "main",
		detailed_merge_status: "mergeable",
		has_conflicts: false,
		blocking_discussions_resolved: false,
		author: { username: "alice", name: "Alice" },
		assignees: [{ username: "alice", name: "Alice" }],
		reviewers: [{ username: "bob", name: "Bob" }],
		labels: ["enhancement"],
		head_pipeline: { id: 99, status: "running", web_url: "https://gitlab.example.com/acme/api/-/pipelines/99" },
		web_url: "https://gitlab.example.com/acme/api/-/merge_requests/7",
		created_at: "2026-04-01T00:00:00Z",
		updated_at: "2026-04-02T00:00:00Z",
	};

	const sampleDiscussions = [
		{
			id: "disc1111aaaa2222bbbb3333cccc4444dddd5555",
			notes: [
				{
					id: 10,
					body: "Please handle empty input.",
					author: { username: "bob" },
					created_at: "2026-04-01T10:00:00Z",
					system: false,
					resolvable: true,
					resolved: false,
					position: { new_path: "src/app.ts", new_line: 42 },
				},
			],
		},
		{
			id: "disc2222aaaa2222bbbb3333cccc4444dddd5555",
			notes: [
				{
					id: 11,
					body: "Looks good now.",
					author: { username: "bob" },
					created_at: "2026-04-01T11:00:00Z",
					system: false,
					resolvable: true,
					resolved: true,
				},
			],
		},
		{
			id: "disc3333aaaa2222bbbb3333cccc4444dddd5555",
			notes: [
				{
					id: 12,
					body: "assigned to @alice",
					author: { username: "alice" },
					created_at: "2026-04-01T09:00:00Z",
					system: true,
				},
			],
		},
	];

	it("resolves mr://<host>/<group>/<project>/<iid>, caches it, and filters ?unresolved=1 from cache", async () => {
		const jsonSpy = spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/"));
			if (endpoint === "projects/acme%2Fapi/merge_requests/7") return sampleMr;
			if (endpoint === "projects/acme%2Fapi/merge_requests/7/approvals") {
				return { approvals_required: 2, approved_by: [{ user: { username: "bob" } }] };
			}
			if (endpoint === "projects/acme%2Fapi/merge_requests/7/discussions") return sampleDiscussions;
			throw new Error(`Unexpected glab json call: ${args.join(" ")}`);
		});

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("mr://gitlab.example.com/acme/api/7");
		expect(first.notes).toContain("Fetched live");
		expect(first.notes).toContain("Diff: mr://gitlab.example.com/acme/api/7/diff");
		expect(first.content).toContain("# Merge Request !7: Add GitLab MR protocol support");
		expect(first.content).toContain("Approvals: 1 / 2 required (@bob)");
		expect(first.content).toContain("[UNRESOLVED] Discussion `disc1111aaaa2222bbbb3333cccc4444dddd5555` (disc1111)");
		expect(first.content).toContain("Location: src/app.ts:42");
		expect(first.content).toContain("[RESOLVED] Discussion `disc2222aaaa2222bbbb3333cccc4444dddd5555`");
		expect(first.content).not.toContain("assigned to @alice");

		const unresolvedOnly = await router.resolve("mr://gitlab.example.com/acme/api/7?unresolved=1");
		expect(unresolvedOnly.notes?.[0]).toMatch(/^Cached:/);
		expect(unresolvedOnly.content).toContain("Please handle empty input.");
		expect(unresolvedOnly.content).not.toContain("Looks good now.");
		expect(jsonSpy).toHaveBeenCalledTimes(3);
	});

	it("skips discussions API when ?comments=0 is passed", async () => {
		const jsonSpy = spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/"));
			if (endpoint === "projects/acme%2Fapi/merge_requests/7") return sampleMr;
			if (endpoint === "projects/acme%2Fapi/merge_requests/7/approvals")
				return { approvals_required: 1, approved_by: [] };
			throw new Error(`Unexpected glab json call: ${args.join(" ")}`);
		});

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.example.com/acme/api/7?comments=0");
		expect(resource.notes).toContain("Comments disabled");
		expect(resource.content).not.toContain("## Discussions");
		expect(jsonSpy).toHaveBeenCalledTimes(2);
	});

	it("lists MRs for bare mr:// and explicit mr://<host>/<group>/<project> with query filters", async () => {
		const jsonSpy = spyGitlabJson(async (_cwd, args) => {
			if (args[0] === "repo" && args[1] === "view") {
				return { web_url: "https://gitlab.example.com/acme/api" };
			}
			if (args[0] === "api") {
				return [sampleMr];
			}
			throw new Error(`Unexpected glab json call: ${args.join(" ")}`);
		});

		const router = InternalUrlRouter.instance();
		const bare = await router.resolve("mr://", { cwd: tempDir });
		expect(bare.content).toContain("# Merge Requests in gitlab.example.com/acme/api (opened, up to 30)");
		expect(bare.content).toContain("mr://gitlab.example.com/acme/api/7");

		const filtered = await router.resolve("mr://gitlab.example.com/acme/api?state=merged&limit=5&author=alice");
		expect(filtered.content).toContain("# Merge Requests in gitlab.example.com/acme/api (merged, up to 5)");
		const lastArgs = jsonSpy.mock.calls.at(-1)![1] as string[];
		expect(lastArgs).toContain("state=merged");
		expect(lastArgs).toContain("per_page=5");
		expect(lastArgs).toContain("author_username=alice");
	});

	it("rejects invalid ?state= on mr:// listing", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("mr://gitlab.example.com/acme/api?state=bogus"),
		).rejects.toThrow(/Invalid mr:\/\/ list state 'bogus'/);
	});

	it("handles projects named 'diff' for both list and single MR URLs and preserves single-label hosts", async () => {
		process.env.GITLAB_HOST = "gitlab";
		const hostsSeen: string[] = [];
		spyGitlabJson(async (_cwd, args) => {
			const hostIdx = args.indexOf("--hostname");
			if (hostIdx >= 0) hostsSeen.push(args[hostIdx + 1]!);
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fdiff/merge_requests") return [sampleMr];
			if (endpoint.endsWith("/merge_requests/7")) return sampleMr;
			if (endpoint.endsWith("/approvals")) return { approvals_required: 0, approved_by: [] };
			if (endpoint.endsWith("/discussions")) return [];
			throw new Error(`Unexpected glab json call: ${args.join(" ")}`);
		});

		const router = InternalUrlRouter.instance();
		const diffList = await router.resolve("mr://gitlab.com/acme/diff");
		expect(diffList.content).toContain("# Merge Requests in gitlab.com/acme/diff");

		const diffSingle = await router.resolve("mr://gitlab.com/acme/diff/7");
		expect(diffSingle.content).toContain("# Merge Request !7:");

		const singleLabel = await router.resolve("mr://gitlab/acme/api/7");
		expect(singleLabel.content).toContain("# Merge Request !7:");
		expect(hostsSeen).toContain("gitlab");
	});
});
