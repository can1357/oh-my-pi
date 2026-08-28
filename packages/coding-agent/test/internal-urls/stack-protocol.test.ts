/**
 * `stack://` protocol handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../src/internal-urls";
import { resetForTests as resetCacheForTests } from "../../src/tools/github-cache";
import { github } from "../../src/utils/github";

const restStack = {
	number: 7,
	url: "https://api.github.com/repos/owner/example/stacks/7",
	open: true,
	base: { ref: "main" },
	pull_requests: [
		{
			number: 10,
			state: "open",
			draft: false,
			merged_at: null,
			head: { ref: "auth-layer", sha: "aaa" },
		},
		{
			number: 11,
			state: "open",
			draft: true,
			merged_at: null,
			head: { ref: "api-routes", sha: "bbb" },
		},
	],
};

let tempDir: string;
let originalEnv: string | undefined;
let originalGhToken: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stack-protocol-"));
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

describe("stack:// protocol handler", () => {
	it("lists remote stacks for stack://owner/repo", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue([restStack]);
		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("stack://owner/example");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Pull request stacks (owner/example)");
		expect(resource.content).toContain("stack://owner/example/7");
		expect(resource.immutable).toBe(true);
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toContain("/repos/owner/example/stacks");
	});

	it("views one stack at stack://owner/repo/N", async () => {
		vi.spyOn(github, "json").mockResolvedValue(restStack);
		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("stack://owner/example/7");

		expect(resource.content).toContain("# Stack #7");
		expect(resource.content).toContain("pr://owner/example/10  auth-layer  open  ← bottom");
		expect(resource.content).toContain("pr://owner/example/11  api-routes  draft  ← top");
	});

	it("rejects invalid stack:// URLs", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("stack://owner")).rejects.toThrow(/Invalid stack:\/\/ number/);
		await expect(router.resolve("stack://owner/example/foo")).rejects.toThrow(/Invalid stack:\/\/ number/);
	});

	it("routes stack://<host>/<owner>/<repo>/<n> at that host", async () => {
		const spy = vi.spyOn(github, "json").mockResolvedValue(restStack);
		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("stack://ghe.example.com/owner/example/7");

		expect(resource.content).toContain("# Stack #7");
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--hostname");
		expect(args[args.indexOf("--hostname") + 1]).toBe("ghe.example.com");
		expect(args).toContain("/repos/owner/example/stacks/7");
	});
});
