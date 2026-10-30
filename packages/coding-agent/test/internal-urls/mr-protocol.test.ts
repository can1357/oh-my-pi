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

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
	"GITLAB_HOST",
	"GITLAB_URI",
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
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const slice = await router.resolve("mr://gitlab.com/g/p/7/diff/2");
		expect(slice.content).toBe(secondSection);
		const all = await router.resolve("mr://gitlab.com/g/p/7/diff/all");
		expect(all.content).toBe(diffText);
		await expect(router.resolve("mr://gitlab.com/g/p/7/diff/3")).rejects.toThrow(/MR has 2 files/);
	});

	it("serves a repeat read from the cache without re-running glab", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const first = await router.resolve("mr://gitlab.com/g/p/7/diff/1");
		const second = await router.resolve("mr://gitlab.com/g/p/7/diff/1");

		expect(first.notes?.[0]).toBe("Fetched live");
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		expect(textSpy).toHaveBeenCalledTimes(1);
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

	it("rejects URLs without a diff suffix, a group/project pair, or a plain host", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mr://gitlab.com/g/p/7")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com/g/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com@evil.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://evil%1B%5D8%3B%3B.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("retries without --raw when the instance has no raw diff endpoint", async () => {
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
