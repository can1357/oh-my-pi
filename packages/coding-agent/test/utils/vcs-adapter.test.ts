import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

const repos: string[] = [];

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-vcs-adapter-"));
	repos.push(repo);
	await $`git init --initial-branch=main`.cwd(repo).quiet();
	await $`git config user.name "Test User"`.cwd(repo).quiet();
	await $`git config user.email "test@example.com"`.cwd(repo).quiet();
	return repo;
}

afterEach(async () => {
	await Promise.all(repos.splice(0).map(repo => fs.rm(repo, { recursive: true, force: true })));
});

describe("native Git adapter regressions", () => {
	test("status collapses a populated untracked directory and ignores empty trees", async () => {
		const repo = await createRepo();
		await fs.mkdir(path.join(repo, "newdir"));
		await Promise.all([
			Bun.write(path.join(repo, "newdir", "a"), "a\n"),
			Bun.write(path.join(repo, "newdir", "b"), "b\n"),
			fs.mkdir(path.join(repo, "empty", "nested"), { recursive: true }),
		]);

		expect(await vcs.requireGit(repo).statusSummary()).toEqual({ staged: 0, unstaged: 0, untracked: 1 });
	});

	test("alternate-index tree synthesis leaves the real index untouched", async () => {
		const repo = await createRepo();
		await Bun.write(path.join(repo, "tracked.txt"), "before\n");
		await $`git add tracked.txt`.cwd(repo).quiet();
		await $`git commit -m baseline`.cwd(repo).quiet();

		const indexPath = path.join(repo, ".git", "synthetic.index");
		const repository = vcs.requireGit(repo);
		await repository.readTree("HEAD", indexPath);
		await repository.applyPatch(
			[
				"diff --git a/tracked.txt b/tracked.txt",
				"--- a/tracked.txt",
				"+++ b/tracked.txt",
				"@@ -1 +1 @@",
				"-before",
				"+after",
				"",
			].join("\n"),
			{ cached: true, indexPath },
		);
		const tree = await repository.writeTree(indexPath);

		expect(await $`git show ${tree}:tracked.txt`.cwd(repo).quiet().text()).toBe("after\n");
		expect(await $`git status --porcelain`.cwd(repo).quiet().text()).toBe("");
	});
});
