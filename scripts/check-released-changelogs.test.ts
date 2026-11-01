import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { runChangelogFixer } from "./fix-changelogs";
import { updateChangelogsForRelease } from "./release";

const CHANGELOG = "packages/tui/CHANGELOG.md";
const FIRST_ENTRY = "- Added the first unreleased entry";
const BRANCH_ENTRY = "- Added the branch entry";
const BASE_CHANGELOG = `# Changelog

## [Unreleased]

### Added

${FIRST_ENTRY}

## [1.0.0] - 2026-01-01

### Fixed

- Fixed an old bug
`;
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
// Each case drives real `git` and spawns the scripts under test; the 5 s default
// is short for that on a loaded machine.
const TEST_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface Repo {
	dir: string;
	git(...args: string[]): Promise<{ exitCode: number; output: string }>;
	read(): Promise<string>;
	write(content: string): Promise<void>;
}

function repoAt(dir: string): Repo {
	return {
		dir,
		async git(...args) {
			const result = await $`git ${args}`.cwd(dir).env(GIT_ENV).quiet().nothrow();
			return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
		},
		read: () => Bun.file(path.join(dir, CHANGELOG)).text(),
		write: async content => {
			await Bun.write(path.join(dir, CHANGELOG), content);
		},
	};
}

/** main with BASE_CHANGELOG tagged v1.0.0, and the repository's union merge driver for changelogs. */
async function baseRepo(): Promise<Repo> {
	const repo = repoAt(await tempDir("released-changelogs-"));
	await repo.git("init", "-q", "-b", "main");
	await Bun.write(path.join(repo.dir, ".gitattributes"), "packages/*/CHANGELOG.md merge=union\n");
	await repo.write(BASE_CHANGELOG);
	await repo.git("add", "-A");
	await repo.git("commit", "-qm", "chore: start");
	await repo.git("tag", "v1.0.0");
	return repo;
}

/** The changelog half of `bun run release`, committed as the release script names it. */
async function cutRelease(repo: Repo, version: string): Promise<void> {
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await runChangelogFixer({ repoRoot: repo.dir });
		await updateChangelogsForRelease(version, repo.dir);
	} finally {
		log.mockRestore();
	}
	await repo.git("commit", "-qam", `chore: bump version to ${version}`);
}

/** `feature` adds BRANCH_ENTRY under [Unreleased]; meanwhile main releases 1.1.0. */
async function branchBehindRelease(): Promise<Repo> {
	const repo = await baseRepo();
	await repo.git("checkout", "-qb", "feature");
	await repo.write(BASE_CHANGELOG.replace(`${FIRST_ENTRY}\n`, `${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`));
	await repo.git("commit", "-qam", "feat: add branch entry");
	await repo.git("checkout", "-q", "main");
	await cutRelease(repo, "1.1.0");
	return repo;
}

async function runScript(
	cwd: string,
	script: string,
	args: string[],
	env: Record<string, string | undefined> = GIT_ENV,
): Promise<{ exitCode: number; output: string }> {
	const result = await $`${process.execPath} ${path.join(import.meta.dir, script)} ${args}`
		.cwd(cwd)
		.env(env)
		.quiet()
		.nothrow();
	return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

describe("check-released-changelogs", () => {
	test(
		"fails, naming file, section, line and destination, when merging a release moves a branch entry into it",
		async () => {
			const repo = await branchBehindRelease();
			await repo.git("checkout", "-q", "feature");

			// Git calls this merge clean, and the entry lands under the new release heading.
			expect((await repo.git("merge", "--no-edit", "main")).exitCode).toBe(0);
			expect(await repo.read()).toMatch(
				new RegExp(`## \\[1\\.1\\.0\\] - [0-9-]+\\n\\n### Added\\n\\n${FIRST_ENTRY}\\n${BRANCH_ENTRY}\\n`),
			);

			const check = await runScript(repo.dir, "check-released-changelogs.ts", ["--base", "main"]);
			expect(check.exitCode).toBe(1);
			expect(check.output).toContain(`${CHANGELOG}: ## [1.1.0] - `);
			expect(check.output).toContain(
				`Added under \`### Added\`; move under \`## [Unreleased]\`, \`### Added\`:\n    ${BRANCH_ENTRY}\n`,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes once the merged branch keeps its entries under [Unreleased]",
		async () => {
			const repo = await branchBehindRelease();
			await repo.git("checkout", "-q", "feature");
			await repo.git("merge", "--no-edit", "main");
			const merged = await repo.read();
			await repo.write(
				merged
					.replace(`${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`, `${FIRST_ENTRY}\n`)
					.replace("## [Unreleased]\n\n", `## [Unreleased]\n\n### Added\n\n${BRANCH_ENTRY}\n\n`),
			);
			await repo.git("commit", "-qam", "docs: move the entry back under [Unreleased]");

			const check = await runScript(repo.dir, "check-released-changelogs.ts", ["--base", "main"]);
			expect(check.output).toContain("Released changelog sections match");
			expect(check.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes a release commit, which turns [Unreleased] into a new released section above the old ones",
		async () => {
			const repo = await baseRepo();
			const beforeRelease = (await repo.git("rev-parse", "HEAD")).output.trim();
			await cutRelease(repo, "1.1.0");
			expect(await repo.read()).toMatch(/^# Changelog\n\n## \[Unreleased\]\n\n## \[1\.1\.0\] - /);

			const check = await runScript(repo.dir, "check-released-changelogs.ts", ["--base", beforeRelease]);
			expect(check.output).toContain("Released changelog sections match");
			expect(check.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test.each([
		{
			name: "a released line removed",
			edit: (content: string) => content.replace("- Fixed an old bug\n", ""),
			expected: "Removed; put back:\n    - Fixed an old bug",
		},
		{
			name: "a released section dropped",
			edit: (content: string) => content.slice(0, content.indexOf("## [1.0.0]")),
			expected: "Missing here. The base has this section (3 lines)",
		},
	])(
		"fails on $name",
		async ({ edit, expected }) => {
			const repo = await baseRepo();
			await repo.write(edit(await repo.read()));

			const check = await runScript(repo.dir, "check-released-changelogs.ts", ["--base", "HEAD"]);
			expect(check.exitCode).toBe(1);
			expect(check.output).toContain(`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  ${expected}`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes blank-line layout that scripts/fix-changelogs.ts rewrites inside a released section",
		async () => {
			const released = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01

### Fixed

- Fixed an old bug
- Fixed another old bug
`;
			const repo = repoAt(await tempDir("released-changelogs-blank-"));
			await repo.git("init", "-q", "-b", "main");
			await repo.write(released);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "release 1.0.0");
			await repo.git("tag", "v1.0.0");

			// A blank line between two bullets of the released section; the fixer drops it.
			await repo.write(released.replace("- Fixed an old bug\n", "- Fixed an old bug\n\n"));
			const log = spyOn(console, "log").mockImplementation(() => {});
			try {
				await runChangelogFixer({ repoRoot: repo.dir });
			} finally {
				log.mockRestore();
			}
			expect(await repo.read()).toBe(released);

			const check = await runScript(repo.dir, "check-released-changelogs.ts", ["--base", "HEAD"]);
			expect(check.output).toContain("Released changelog sections match");
			expect(check.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails loudly in a shallow clone that lacks the base, and finds the change once the base is fetched",
		async () => {
			// The pull request shape: a merge commit whose first parent is the released base.
			const repo = await branchBehindRelease();
			await repo.git("merge", "--no-ff", "--no-edit", "feature");

			const clones = await tempDir("released-changelogs-clone-");
			const depth1 = path.join(clones, "depth1");
			const depth2 = path.join(clones, "depth2");
			await repoAt(clones).git("clone", "-q", "--depth", "1", `file://${repo.dir}`, depth1);
			await repoAt(clones).git("clone", "-q", "--depth", "2", `file://${repo.dir}`, depth2);

			const shallow = await runScript(depth1, "check-released-changelogs.ts", ["--base", "HEAD^1"]);
			expect(shallow.exitCode).toBe(2);
			expect(shallow.output).toContain("cannot resolve --base HEAD^1 to a commit");

			const fetched = await runScript(depth2, "check-released-changelogs.ts", ["--base", "HEAD^1"]);
			expect(fetched.exitCode).toBe(1);
			expect(fetched.output).toContain(`    ${BRANCH_ENTRY}\n`);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("merge-pr", () => {
	async function mergePr(repo: Repo): Promise<{ exitCode: number; output: string }> {
		// merge-pr asks `gh` for the PR's number and author.
		const bin = await tempDir("released-changelogs-gh-");
		await Bun.write(
			path.join(bin, "gh"),
			`#!/bin/sh\necho '{"number":7,"title":"feat: add branch entry","author":{"login":"alice"}}'\n`,
		);
		await fs.chmod(path.join(bin, "gh"), 0o755);
		return runScript(repo.dir, "merge-pr.ts", ["feature", "--pr", "7"], {
			...GIT_ENV,
			PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		});
	}

	test(
		"leaves the merge uncommitted when it would move a branch entry into a released section",
		async () => {
			const repo = await branchBehindRelease();
			const mainTip = (await repo.git("rev-parse", "HEAD")).output.trim();

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(1);
			expect(merge.output).toContain(`${CHANGELOG}: ## [1.1.0] - `);
			expect(merge.output).toContain(`    ${BRANCH_ENTRY}\n`);
			expect((await repo.git("rev-parse", "HEAD")).output.trim()).toBe(mainTip);
			expect((await repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).toBe(0);

			// The fix the report asks for, then the commit it names.
			const merged = await repo.read();
			await repo.write(
				merged
					.replace(`${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`, `${FIRST_ENTRY}\n`)
					.replace("## [Unreleased]\n\n", `## [Unreleased]\n\n### Added\n\n${BRANCH_ENTRY}\n\n`),
			);
			await repo.git("add", CHANGELOG);
			expect((await repo.git("commit", "--no-edit")).exitCode).toBe(0);
			expect((await repo.git("log", "-1", "--format=%s")).output.trim()).toBe(
				"Merge PR #7: feat: add branch entry (@alice)",
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"commits a merge that keeps released sections unchanged, with the merge-commit message",
		async () => {
			const repo = await baseRepo();
			await repo.git("checkout", "-qb", "feature");
			await repo.write(BASE_CHANGELOG.replace(`${FIRST_ENTRY}\n`, `${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`));
			await repo.git("commit", "-qam", "feat: add branch entry");
			await repo.git("checkout", "-q", "main");

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(0);
			expect((await repo.git("log", "-1", "--format=%s %P")).output.trim()).toMatch(
				/^Merge PR #7: feat: add branch entry \(@alice\) [0-9a-f]{40} [0-9a-f]{40}$/,
			);
		},
		TEST_TIMEOUT_MS,
	);
});
