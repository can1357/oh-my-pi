import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";
import { buildDiffDocument, buildLineSelectionPatch } from "@oh-my-pi/pi-tui/apps/git/diff-pane";

const repos: string[] = [];

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tui-patch-"));
	repos.push(repo);
	await $`git init --initial-branch=main`.cwd(repo).quiet();
	await $`git config user.name "Test User"`.cwd(repo).quiet();
	await $`git config user.email "test@example.com"`.cwd(repo).quiet();
	return repo;
}

afterEach(async () => {
	await Promise.all(repos.splice(0).map(repo => fs.rm(repo, { recursive: true, force: true })));
});

const OLD = "alpha\nbravo\ncharlie\n";
const NEW = "alpha\nBRAVO\ncharlie\n";

describe("git TUI patch actions", () => {
	test("discards a hunk by reverting its patch onto the worktree", async () => {
		const repo = await createRepo();
		const file = path.join(repo, "tracked.txt");
		await Bun.write(file, OLD);
		await $`git add tracked.txt`.cwd(repo).quiet();
		await $`git commit -m base`.cwd(repo).quiet();
		await Bun.write(file, NEW);

		const doc = buildDiffDocument(OLD, NEW, "tracked.txt");
		const patch = doc.hunks[0]?.patch ?? "";
		expect(patch.length).toBeGreaterThan(0);

		await vcs.requireGit(repo).applyPatch(patch, { reverse: true });
		expect(await Bun.file(file).text()).toBe(OLD);
	});

	test("stages a selected line range through the index", async () => {
		const repo = await createRepo();
		const file = path.join(repo, "tracked.txt");
		await Bun.write(file, OLD);
		await $`git add tracked.txt`.cwd(repo).quiet();
		await $`git commit -m base`.cwd(repo).quiet();
		await Bun.write(file, NEW);

		const doc = buildDiffDocument(OLD, NEW, "tracked.txt");
		const patch = buildLineSelectionPatch(doc, 0, doc.rows.length - 1, "apply");
		expect(patch).not.toBeNull();

		await vcs.requireGit(repo).applyPatch(patch ?? "", { cached: true });
		expect(await $`git show :tracked.txt`.cwd(repo).quiet().text()).toBe(NEW);
	});
});
