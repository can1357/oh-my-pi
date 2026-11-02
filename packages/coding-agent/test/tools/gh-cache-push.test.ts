import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { getOrFetchPrDiff } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-diff";
import {
	getCached,
	putCached,
	resetForTests,
	resolveGithubCacheAuthKey,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

const REPO = "owner/example";
const FORK = "contributor/example";
let cwd: string;
let originalDb: string | undefined;
let manager: AsyncJobManager;

function exited(exitCode: number): BashResult {
	return {
		output: "",
		exitCode,
		cancelled: false,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
}

function seed(repo: string, authKey = resolveGithubCacheAuthKey()): void {
	for (const includeComments of [false, true]) {
		putCached({ repo, authKey, kind: "pr", number: 7, includeComments, payload: {}, rendered: "head A" });
	}
}

function cached(repo: string): string | undefined {
	return getCached(repo, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered;
}

function bash(): BashTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"bash.direnv": "off",
		}),
	};
	return new BashTool(session);
}

async function run(command: string, options: { exitCode?: number; cwd?: string } = {}): Promise<void> {
	vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(exited(options.exitCode ?? 0));
	await bash().execute("push", { command, cwd: options.cwd });
}

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-push-"));
	await $`git init -q -b main ${cwd}`.quiet();
	const repository = vcs.requireGit(cwd);
	await repository.remoteAdd("origin", "git@github.com:owner/example.git");
	await repository.remoteAdd("fork", "https://github.com/contributor/example.git");
	originalDb = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(cwd, "cache.db");
	resetForTests();
	manager = new AsyncJobManager({});
	seed(REPO);
	seed(FORK);
});

afterEach(async () => {
	await manager.dispose();
	vi.restoreAllMocks();
	resetForTests();
	if (originalDb === undefined) delete process.env.OMP_GITHUB_CACHE_DB;
	else process.env.OMP_GITHUB_CACHE_DB = originalDb;
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("bash git push cache invalidation", () => {
	it("drops the pushed repo's PR rows for every credential so the next diff read fetches the new head", async () => {
		const text = vi.spyOn(github, "text").mockResolvedValue("diff --git a/old.ts b/old.ts\n");
		await getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		seed(REPO, "other-credential");
		putCached({ repo: REPO, kind: "issue", number: 7, includeComments: false, payload: {}, rendered: "issue" });
		text.mockResolvedValue("diff --git a/added.ts b/added.ts\n");

		await run("git push origin main 2>&1");

		expect(cached(REPO)).toBeUndefined();
		expect(getCached(REPO, "pr", 7, false, "other-credential")).toBeNull();
		expect(getCached(REPO, "issue", 7, false)?.rendered).toBe("issue");
		expect(cached(FORK)).toBe("head A");
		const current = await getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		expect(current.payload.files.map(file => file.path)).toEqual(["added.ts"]);
	});

	it("invalidates when a background push completes, not when it is dispatched", async () => {
		const pending = Promise.withResolvers<BashResult>();
		vi.spyOn(bashExecutor, "executeBash").mockReturnValue(pending.promise);
		const result = await bash().execute("bg", { command: "git push", async: true });
		expect(result.details?.async?.state).toBe("running");
		expect(cached(REPO)).toBe("head A");
		pending.resolve(exited(0));
		await manager.waitForAll();
		expect(cached(REPO)).toBeUndefined();
	});

	it.each([
		{ command: "git push", exitCode: 1 },
		{ command: "git push --dry-run", exitCode: 0 },
		{ command: "git push -fn origin main", exitCode: 0 },
		{ command: "echo git push", exitCode: 0 },
	])("keeps the cache for `$command` exiting $exitCode", async ({ command, exitCode }) => {
		await run(command, { exitCode });
		expect(cached(REPO)).toBe("head A");
	});

	it.each([
		{ command: "git push fork HEAD:main", config: [] },
		{ command: "git push --repo=fork", config: [] },
		{ command: "git push fork --repo=origin", config: [] },
		{ command: "git push https://github.com/contributor/example.git HEAD:main", config: [] },
		{ command: "git push", config: [["branch.main.remote", "fork"]] },
		{
			command: "git push",
			config: [
				["branch.main.remote", "origin"],
				["remote.pushDefault", "fork"],
			],
		},
		{
			command: "git push",
			config: [
				["remote.pushDefault", "origin"],
				["branch.main.pushRemote", "fork"],
			],
		},
		{
			command: "git push origin main",
			config: [["remote.origin.pushurl", "https://github.com/contributor/example"]],
		},
	])("`$command` with $config invalidates only the fork", async ({ command, config }) => {
		for (const [key, value] of config) await vcs.requireGit(cwd).configSet(key!, value!);
		await run(command);
		expect(cached(FORK)).toBeUndefined();
		expect(cached(REPO)).toBe("head A");
	});

	it("resolves repeated git -C arguments relative to the command's cwd", async () => {
		await fs.mkdir(path.join(cwd, "outer"));
		await run(`git -C ${JSON.stringify(path.join(cwd, "outer"))} -C .. push origin HEAD:main`, { cwd: os.tmpdir() });
		expect(cached(REPO)).toBeUndefined();
	});

	it("falls back to the only remote when it is not named origin", async () => {
		await $`git -C ${cwd} remote remove fork`.quiet();
		await $`git -C ${cwd} remote rename origin only`.quiet();
		await run("git push");
		expect(cached(REPO)).toBeUndefined();
	});

	it("keeps the same slug on other hosts when pushing an enterprise remote", async () => {
		await vcs.requireGit(cwd).remoteAdd("enterprise", "ssh://git@ghe.example.com/owner/example.git");
		seed("ghe.example.com/owner/example");
		await run("git push enterprise main");
		expect(getCached("ghe.example.com/owner/example", "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
		expect(cached(REPO)).toBe("head A");
	});
});
