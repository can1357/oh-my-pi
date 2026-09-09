import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Regression coverage for #1589: `git.clone({ sha })` used to hardcode
// `--depth 1`, producing a shallow clone whose object store never contained
// non-tip commits. The subsequent `git checkout <sha>` then failed with
// "shallow clone may not contain this commit".

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

function gitRun(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

describe("git.clone with options.sha", () => {
	let tmpRoot: string;
	let upstreamUrl: string;
	let firstSha: string;
	let tipSha: string;

	beforeAll(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-clone-test-"));
		const upstream = path.join(tmpRoot, "upstream");
		await fs.mkdir(upstream, { recursive: true });

		// `file://` is required: local-path clones ignore `--depth`, which would
		// mask the bug. See git-clone(1) "GIT URLS" / "LOCAL PROTOCOL".
		upstreamUrl = url.pathToFileURL(upstream).href;

		gitRun(upstream, ["init", "-q", "-b", "main"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "first"]);
		firstSha = gitRun(upstream, ["rev-parse", "HEAD"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "second"]);
		gitRun(upstream, ["commit", "-q", "--allow-empty", "-m", "third"]);
		tipSha = gitRun(upstream, ["rev-parse", "HEAD"]);
	});

	afterAll(async () => {
		await removeWithRetries(tmpRoot);
	});

	test("checks out a non-tip SHA (regression for #1589)", async () => {
		const target = path.join(tmpRoot, "clone-non-tip");
		await vcs.clone(upstreamUrl, target, { sha: firstSha });
		expect(gitRun(target, ["rev-parse", "HEAD"])).toBe(firstSha);
	});

	test("still succeeds when SHA happens to be the tip", async () => {
		const target = path.join(tmpRoot, "clone-tip");
		await vcs.clone(upstreamUrl, target, { sha: tipSha });
		expect(gitRun(target, ["rev-parse", "HEAD"])).toBe(tipSha);
	});

	test("cleans up the target directory when SHA does not exist", async () => {
		const target = path.join(tmpRoot, "clone-missing");
		await expect(vcs.clone(upstreamUrl, target, { sha: "0".repeat(40) })).rejects.toThrow(/failed to checkout SHA/);
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
