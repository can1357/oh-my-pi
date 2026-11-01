import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { FIX_COMMAND } from "./check-released-changelogs";
import { MAX_CHANGELOG_BYTES, type RunChangelogFixerResult, runChangelogFixer } from "./fix-changelogs";
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
const THREE_RELEASES = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-03-01

### Added

- Added a newest feature

## [1.1.0] - 2026-02-01

### Fixed

- Fixed a middle bug

## [1.0.0] - 2026-01-01

### Fixed

- Fixed an old bug
`;
const ARCHIVE_FOOTER =
	"Older entries are archived in [packages/tui/CHANGELOG.md@abcdef012345](https://github.com/can1357/oh-my-pi/blob/abcdef012345/packages/tui/CHANGELOG.md).";
const RELEASES = THREE_RELEASES.slice(THREE_RELEASES.indexOf("## [1.2.0]"));

/** The footer `bun run fix:changelogs` writes when it archives sections that `commit` still holds. */
function fixerFooter(commit: string): string {
	const repo = process.env.OMP_REPO ?? process.env.GITHUB_REPOSITORY ?? "can1357/oh-my-pi";
	return `Older entries are archived in [${CHANGELOG}@${commit.slice(0, 12)}](https://github.com/${repo}/blob/${commit}/${CHANGELOG}).`;
}
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

/** A repository whose main holds `content`, committed and tagged v1.0.0, with the repository's union merge driver. */
async function repoWith(content: string): Promise<Repo> {
	const repo = repoAt(await tempDir("released-changelogs-"));
	await repo.git("init", "-q", "-b", "main");
	await Bun.write(path.join(repo.dir, ".gitattributes"), "packages/*/CHANGELOG.md merge=union\n");
	await repo.write(content);
	await repo.git("add", "-A");
	await repo.git("commit", "-qm", "chore: start");
	await repo.git("tag", "v1.0.0");
	return repo;
}

/** Runs the repository's changelog fixer, as `bun run fix:changelogs` does. */
async function fixChangelogs(repo: Repo): Promise<RunChangelogFixerResult> {
	return runChangelogFixer({ repoRoot: repo.dir });
}

/** The changelog half of `bun run release`, committed and tagged as the release script does. */
async function cutRelease(repo: Repo, version: string): Promise<void> {
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await fixChangelogs(repo);
		await updateChangelogsForRelease(version, repo.dir);
	} finally {
		log.mockRestore();
	}
	await repo.git("commit", "-qam", `chore: bump version to ${version}`);
	await repo.git("tag", `v${version}`);
}

/** `feature` adds BRANCH_ENTRY under [Unreleased]; meanwhile main releases 1.1.0. */
async function branchBehindRelease(): Promise<Repo> {
	const repo = await repoWith(BASE_CHANGELOG);
	await repo.git("checkout", "-qb", "feature");
	await repo.write(BASE_CHANGELOG.replace(`${FIRST_ENTRY}\n`, `${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`));
	await repo.git("commit", "-qam", "feat: add branch entry");
	await repo.git("checkout", "-q", "main");
	await cutRelease(repo, "1.1.0");
	return repo;
}

/** The part of a changelog above its first released section. */
function unreleasedPart(content: string): string {
	return content.slice(0, content.search(/^## \[\d/m));
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

function check(repo: Repo, ...args: string[]): Promise<{ exitCode: number; output: string }> {
	return runScript(repo.dir, "check-released-changelogs.ts", args);
}

describe("check-released-changelogs", () => {
	test(
		"fails a merge across a release with the moved line and the fix command, and that command makes it pass",
		async () => {
			const repo = await branchBehindRelease();
			await repo.git("checkout", "-q", "feature");

			// Git calls this merge clean, and the entry lands under the new release heading.
			expect((await repo.git("merge", "--no-edit", "main")).exitCode).toBe(0);
			expect(await repo.read()).toMatch(
				new RegExp(`## \\[1\\.1\\.0\\] - [0-9-]+\\n\\n### Added\\n\\n${FIRST_ENTRY}\\n${BRANCH_ENTRY}\\n`),
			);

			const failed = await check(repo, "--base", "main");
			expect(failed.exitCode).toBe(1);
			expect(failed.output).toContain(`${CHANGELOG}: ## [1.1.0] - `);
			expect(failed.output).toContain(
				`Added under \`### Added\`; it belongs under \`## [Unreleased]\`, \`### Added\`:\n    ${BRANCH_ENTRY}\n`,
			);
			expect(failed.output).toContain(FIX_COMMAND);

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.promotedItems)).toEqual([1]);
			expect(unreleasedPart(await repo.read())).toContain(BRANCH_ENTRY);

			const passed = await check(repo, "--base", "main");
			expect(passed.output).toContain("Released changelog sections match");
			expect(passed.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes a release commit, which turns [Unreleased] into a released section, and still fails an edit after it",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			const beforeRelease = (await repo.git("rev-parse", "HEAD")).output.trim();
			await cutRelease(repo, "1.1.0");
			expect(await repo.read()).toMatch(/^# Changelog\n\n## \[Unreleased\]\n\n## \[1\.1\.0\] - /);

			const released = await check(repo, "--base", beforeRelease);
			expect(released.output).toContain("Released changelog sections match");
			expect(released.exitCode).toBe(0);

			await repo.write((await repo.read()).replace("- Fixed an old bug\n", "- Fixed an old bug, reworded\n"));
			const edited = await check(repo, "--base", beforeRelease);
			expect(edited.exitCode).toBe(1);
			expect(edited.output).toContain("Removed; put back:\n    - Fixed an old bug\n");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a removed released line without offering the fix command, which cannot restore it",
		async () => {
			const twoBullets = BASE_CHANGELOG.replace(
				"- Fixed an old bug\n",
				"- Fixed an old bug\n- Fixed another old bug\n",
			);
			const repo = await repoWith(twoBullets);
			await repo.write(BASE_CHANGELOG.replace("- Fixed an old bug\n", "- Fixed another old bug\n"));

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Removed; put back:\n    - Fixed an old bug\n`,
			);
			expect(result.output).not.toContain(FIX_COMMAND);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a released section dropped without an archive footer",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			await repo.write(THREE_RELEASES.slice(0, THREE_RELEASES.indexOf("## [1.0.0]")));

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here. Restore it from \`git show `,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes the fixer's archive when new [Unreleased] entries push a changelog over the size limit, and still checks what remains",
		async () => {
			// A valid changelog just under the default limit; eight new entries take it over,
			// and `bun run fix:changelogs` moves the oldest release behind a footer.
			let content =
				"# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n";
			for (let index = 0; ; index++) {
				const line = `- Fixed historical rendering regression ${index} in the terminal screen.\n`;
				if (Buffer.byteLength(content + line) > MAX_CHANGELOG_BYTES - 128) break;
				content += line;
			}
			const repo = await repoWith(content);
			const entries = Array.from({ length: 8 }, (_, index) => `- Added a new terminal feature ${index}\n`).join("");
			await repo.write(content.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${entries}`));
			expect(Buffer.byteLength(await repo.read())).toBeGreaterThan(MAX_CHANGELOG_BYTES);

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([1]);
			const archivedContent = await repo.read();
			expect(archivedContent).toContain("Older entries are archived in [");
			expect(archivedContent).not.toContain("## [1.0.0]");

			const archived = await check(repo, "--base", "HEAD");
			expect(archived.output).toContain("; 1 oldest archived behind a new size-limit footer.");
			expect(archived.exitCode).toBe(0);

			await repo.write(archivedContent.replace("- Fixed a recent bug\n", `- Fixed a recent bug\n${BRANCH_ENTRY}\n`));
			const added = await check(repo, "--base", "HEAD");
			expect(added.exitCode).toBe(1);
			expect(added.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Added under \`### Fixed\``);
		},
		TEST_TIMEOUT_MS,
	);

	test.each([
		{ name: "a small changelog", fill: false },
		{ name: "a changelog whose full content exceeds the limit", fill: true },
	])(
		"rejects a footer naming the base commit that removes every release of $name",
		async ({ fill }) => {
			// The fixer archives nothing under the limit and always keeps the newest release over it.
			let content =
				"# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Fixed an old bug\n";
			for (let index = 0; fill; index++) {
				const line = `- Fixed historical rendering regression ${index} in the terminal screen.\n`;
				if (Buffer.byteLength(content + line) > MAX_CHANGELOG_BYTES - 128) break;
				content += line;
			}
			const repo = await repoWith(content);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			const archiveFooter = `Older entries are archived in [${CHANGELOG}@${baseline.slice(0, 12)}](https://github.com/can1357/oh-my-pi/blob/${baseline}/${CHANGELOG}).`;
			await repo.write(`# Changelog\n\n## [Unreleased]\n\n${archiveFooter}\n`);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"uses the fixer's version order before accepting a default-limit archive",
		async () => {
			// The oldest version is physically first. The fixer sorts it behind 1.1.0
			// before collapsing it, so the checker must sort the base identically.
			let content = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n";
			for (let index = 0; ; index++) {
				const line = `- Fixed historical rendering regression ${index} in the terminal screen.\n`;
				if (Buffer.byteLength(content + line) > MAX_CHANGELOG_BYTES - 128) break;
				content += line;
			}
			content += "\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n";
			const repo = await repoWith(content);
			const entries = Array.from({ length: 8 }, (_, index) => `- Added a new terminal feature ${index}\n`).join("");
			await repo.write(content.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${entries}`));

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([1]);
			const result = await check(repo, "--base", "HEAD");
			expect(result.output).toContain("; 1 oldest archived behind a new size-limit footer.");
			expect(result.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive that drops more releases than the fixer would",
		async () => {
			// Eight new entries make the fixer archive only 1.0.0; 1.1.0 still fits.
			let content =
				"# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-03-01\n\n### Fixed\n\n- Fixed a newer bug\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n";
			for (let index = 0; ; index++) {
				const line = `- Fixed historical rendering regression ${index} in the terminal screen.\n`;
				if (Buffer.byteLength(content + line) > MAX_CHANGELOG_BYTES - 128) break;
				content += line;
			}
			const repo = await repoWith(content);
			const entries = Array.from({ length: 8 }, (_, index) => `- Added a new terminal feature ${index}\n`).join("");
			await repo.write(content.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${entries}`));

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([1]);
			const archivedContent = await repo.read();
			const middle = archivedContent.slice(
				archivedContent.indexOf("## [1.1.0]"),
				archivedContent.indexOf("Older entries are archived in ["),
			);
			await repo.write(archivedContent.replace(middle, ""));

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
			expect(result.output).not.toContain("## [1.0.0]");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a section missing from the middle even when an archive footer was added",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			const middle = THREE_RELEASES.slice(
				THREE_RELEASES.indexOf("## [1.1.0]"),
				THREE_RELEASES.indexOf("## [1.0.0]"),
			);
			await repo.write(`${THREE_RELEASES.replace(middle, "")}\n${ARCHIVE_FOOTER}\n`);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive that drops the newest release behind two [Unreleased] headings, and passes the fixer's archive, which keeps it",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			const oversized = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n## [Unreleased]\n`;
			// What a collapse that keeps the first two sections, rather than the newest release, writes.
			await repo.write(`${oversized}\n${fixerFooter(baseline)}\n`);
			const dropped = await check(repo, "--base", "HEAD");
			expect(dropped.exitCode).toBe(1);
			expect(dropped.output).toContain(`${CHANGELOG}: ## [1.2.0] - 2026-03-01\n  Missing here.`);

			await repo.write(`${oversized}\n${RELEASES}`);
			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([2]);
			expect(await repo.read()).toContain("## [1.2.0] - 2026-03-01");
			const archived = await check(repo, "--base", "HEAD");
			expect(archived.output).toContain("; 2 oldest archived behind a new size-limit footer.");
			expect(archived.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive that only [Unreleased] copies of a released entry push over the limit, since the fixer drops the copies",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			const padded = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${"- Added a newest feature\n".repeat(18_000)}\n`;
			const newest = RELEASES.slice(0, RELEASES.indexOf("## [1.1.0]"));
			await repo.write(`${padded}${newest}${fixerFooter(baseline)}\n`);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here.`);

			// With every release present, the fixer removes the copies and archives nothing.
			await repo.write(`${padded}${RELEASES}`);
			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => [file.droppedReleasedDuplicates, file.collapsedReleases])).toEqual([
				[18_000, 0],
			]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive of a changelog one byte under the limit, which the fixer leaves alone",
		async () => {
			const newest = "- Added a newest feature";
			const filler = "x".repeat(MAX_CHANGELOG_BYTES - 2 - Buffer.byteLength(THREE_RELEASES));
			const content = THREE_RELEASES.replace(newest, `${newest} ${filler}`);
			expect(Buffer.byteLength(content)).toBe(MAX_CHANGELOG_BYTES - 1);
			const repo = await repoWith(content);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			expect((await fixChangelogs(repo)).changedFiles).toEqual([]);

			await repo.write(`${content.slice(0, content.indexOf("## [1.1.0]"))}${fixerFooter(baseline)}\n`);
			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes the fixer's archive of a changelog one byte over the limit",
		async () => {
			const newest = "- Added a newest feature";
			const filler = "x".repeat(MAX_CHANGELOG_BYTES - Buffer.byteLength(THREE_RELEASES));
			const content = THREE_RELEASES.replace(newest, `${newest} ${filler}`);
			expect(Buffer.byteLength(content)).toBe(MAX_CHANGELOG_BYTES + 1);
			const repo = await repoWith(content);

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([2]);
			const result = await check(repo, "--base", "HEAD");
			expect(result.output).toContain("; 2 oldest archived behind a new size-limit footer.");
			expect(result.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive behind a release section the base does not have, which leaves the base's newest release to be archived",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			await repo.write(
				`# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n## [9.9.9] - 2026-04-01\n\n### Added\n\n- Added a release main never cut\n\n${fixerFooter(baseline)}\n`,
			);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.2.0] - 2026-03-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects a head-only old release retained beside the real fixer's archive",
		async () => {
			const beforeOldest = RELEASES.slice(0, RELEASES.indexOf("## [1.0.0]"));
			const fakeOldRelease = `## [0.0.1] - 2025-12-01

### Fixed

- Added a release that the base never had
`;
			// The proposed head fits through the fake release. The genuine 1.0.0
			// section does not, so the real fixer removes it instead.
			const padding = "x".repeat(MAX_CHANGELOG_BYTES - Buffer.byteLength(THREE_RELEASES) + 1);
			const base = THREE_RELEASES.replace("- Fixed an old bug", `- Fixed an old bug ${padding}`);
			const repo = await repoWith(base);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles.map(file => file.collapsedReleases)).toEqual([1]);
			expect(await repo.read()).not.toContain("## [0.0.1]");

			await repo.write(`${beforeOldest}${fakeOldRelease}${fixerFooter(baseline)}\n`);
			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects an archive that keeps the oldest release but drops the one the fixer archives with it",
		async () => {
			// Over the limit, the fixer archives 1.1.0 and 1.0.0 together; this keeps 1.0.0.
			const repo = await repoWith(THREE_RELEASES);
			const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
			const newest = RELEASES.slice(0, RELEASES.indexOf("## [1.1.0]"));
			const oldest = RELEASES.slice(RELEASES.indexOf("## [1.0.0]"));
			await repo.write(
				`# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n${newest}${oldest}\n${fixerFooter(baseline)}\n`,
			);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here, and the new archive footer does not account for it`,
			);
			expect(result.output).not.toContain(`${CHANGELOG}: ## [1.0.0]`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects more releases gone behind the base's own footer, which the fixer never writes again",
		async () => {
			const repo = await repoWith(THREE_RELEASES);
			const first = (await repo.git("rev-parse", "HEAD")).output.trim();
			await repo.write(`${THREE_RELEASES}\n${fixerFooter(first)}\n`);
			await repo.git("commit", "-qam", "chore: archive footer");
			const newest = RELEASES.slice(0, RELEASES.indexOf("## [1.1.0]"));
			await repo.write(
				`# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n${newest}${fixerFooter(first)}\n`,
			);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${CHANGELOG}: ## [1.1.0] - 2026-02-01\n  Missing here.`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes what the fixer normalizes inside a released section, and still fails an entry added there",
		async () => {
			// Committed un-normalized: a stray blank between bullets, a padded heading,
			// a repeated `### Fixed` and an empty `### Removed`.
			const unnormalized = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01

###  Fixed  

- Fixed an old bug

- Fixed another old bug

### Fixed

- Fixed a third old bug

### Removed
`;
			const repo = await repoWith(unnormalized);

			const fixed = await fixChangelogs(repo);
			expect(fixed.changedFiles).toHaveLength(1);
			const normalized = await repo.read();
			expect(normalized).not.toBe(unnormalized);

			const passed = await check(repo, "--base", "HEAD");
			expect(passed.output).toContain("Released changelog sections match");
			expect(passed.exitCode).toBe(0);

			await repo.write(
				normalized.replace("- Fixed a third old bug\n", `- Fixed a third old bug\n${BRANCH_ENTRY}\n`),
			);
			const added = await check(repo, "--base", "HEAD");
			expect(added.exitCode).toBe(1);
			expect(added.output).toContain(`\`### Fixed\`:\n    ${BRANCH_ENTRY}\n`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes a release that removes an empty released version, but not a released section with entries going",
		async () => {
			const withEmpty = BASE_CHANGELOG.replace("## [1.0.0]", "## [0.9.0] - 2025-12-01\n\n## [1.0.0]");
			const repo = await repoWith(withEmpty);
			const beforeRelease = (await repo.git("rev-parse", "HEAD")).output.trim();
			await cutRelease(repo, "1.1.0");
			const released = await repo.read();
			expect(released).not.toContain("## [0.9.0]");

			const emptyGone = await check(repo, "--base", beforeRelease);
			expect(emptyGone.output).toContain("Released changelog sections match");
			expect(emptyGone.exitCode).toBe(0);

			await repo.write(released.slice(0, released.indexOf("## [1.0.0]")));
			const entriesGone = await check(repo, "--base", beforeRelease);
			expect(entriesGone.exitCode).toBe(1);
			expect(entriesGone.output).toContain(`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here.`);
			expect(entriesGone.output).not.toContain("## [0.9.0]");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a duplicated released section by asking to delete the extra copy, not to move it",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			const released = BASE_CHANGELOG.slice(BASE_CHANGELOG.indexOf("## [1.0.0]"));
			await repo.write(`${BASE_CHANGELOG}\n${released}`);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("This heading appears 2 times here and 1 at the base.");
			expect(result.output).toContain(
				"Repeated; the base has these fewer times, delete the extra:\n    ## [1.0.0] - 2026-01-01\n    ### Fixed\n    - Fixed an old bug\n",
			);
			expect(result.output).not.toContain("it belongs under `## [Unreleased]`");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails reordered released lines",
		async () => {
			const twoBullets = BASE_CHANGELOG.replace(
				"- Fixed an old bug\n",
				"- Fixed an old bug\n- Fixed another old bug\n",
			);
			const repo = await repoWith(twoBullets);
			await repo.write(
				BASE_CHANGELOG.replace("- Fixed an old bug\n", "- Fixed another old bug\n- Fixed an old bug\n"),
			);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Same lines in a different order; restore the base's order.");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"marks the changed file at its section heading for GitHub with --github-annotations",
		async () => {
			const repo = await branchBehindRelease();
			await repo.git("checkout", "-q", "feature");
			await repo.git("merge", "--no-edit", "main");
			const headingLine = (await repo.read()).split("\n").findIndex(line => line.startsWith("## [1.1.0]")) + 1;

			const result = await check(repo, "--base", "main", "--github-annotations");
			expect(result.exitCode).toBe(1);
			expect(result.output).toMatch(
				new RegExp(
					`^::error file=packages/tui/CHANGELOG\\.md,line=${headingLine},title=Released changelog section changed::## \\[1\\.1\\.0\\] - [0-9-]+: 1 line\\(s\\) added\\. Run \`bun run fix:changelogs\``,
					"m",
				),
			);
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

			const shallow = await runScript(depth1, "check-released-changelogs.ts", [
				"--base",
				"HEAD^1",
				"--github-annotations",
			]);
			expect(shallow.exitCode).toBe(2);
			expect(shallow.output).toContain(
				"::error title=Released changelog check could not run::cannot resolve --base HEAD^1",
			);

			const fetched = await runScript(depth2, "check-released-changelogs.ts", ["--base", "HEAD^1"]);
			expect(fetched.exitCode).toBe(1);
			expect(fetched.output).toContain(`    ${BRANCH_ENTRY}\n`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a deleted changelog while its package manifest remains, but accepts deleting the package too",
		async () => {
			// Another package's changelog stays, so the deleted one is the only difference.
			const repo = await repoWith(BASE_CHANGELOG);
			const packageManifest = path.join(repo.dir, "packages/tui/package.json");
			await Bun.write(packageManifest, "{}\n");
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: package manifest");

			await fs.rm(path.join(repo.dir, CHANGELOG));
			const missingChangelog = await check(repo, "--base", "HEAD", "--github-annotations");
			expect(missingChangelog.exitCode).toBe(1);
			expect(missingChangelog.output).toContain(`${CHANGELOG}: CHANGELOG.md is missing`);
			expect(missingChangelog.output).toContain("The package manifest remains, so this is not a package removal.");
			expect(missingChangelog.output).toContain(
				"::error file=packages/tui/CHANGELOG.md,title=Released changelog section changed::CHANGELOG.md is missing: changelog missing while package remains.",
			);

			await fs.rm(packageManifest);
			const packageRemoved = await check(repo, "--base", "HEAD");
			expect(packageRemoved.exitCode).toBe(0);
			expect(packageRemoved.output).toContain("1 sections in 1 changelogs");
		},
		TEST_TIMEOUT_MS,
	);

	test.each([
		{
			name: "no changelog exists at the base",
			args: ["--base", "HEAD~1"],
			expected: "no packages/*/CHANGELOG.md exists at",
		},
		{ name: "--base is missing", args: [], expected: "error: --base is required" },
		{
			name: "an argument is unknown",
			args: ["--base", "HEAD", "--bogus"],
			expected: "error: unexpected argument --bogus",
		},
	])(
		"exits 2 and compares nothing when $name",
		async ({ args, expected }) => {
			const repo = repoAt(await tempDir("released-changelogs-none-"));
			await repo.git("init", "-q", "-b", "main");
			await Bun.write(path.join(repo.dir, "README.md"), "readme\n");
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: no changelog yet");
			await repo.write(BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: add changelog");

			const result = await check(repo, ...args);
			expect(result.exitCode).toBe(2);
			expect(result.output).toContain(expected);
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
		"leaves a merge that moves a branch entry into a released section uncommitted, until the named fix",
		async () => {
			const repo = await branchBehindRelease();
			const mainTip = (await repo.git("rev-parse", "HEAD")).output.trim();

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(1);
			expect(merge.output).toContain(`${CHANGELOG}: ## [1.1.0] - `);
			expect(merge.output).toContain(`    ${BRANCH_ENTRY}\n`);
			expect(merge.output).toContain(FIX_COMMAND);
			expect((await repo.git("rev-parse", "HEAD")).output.trim()).toBe(mainTip);
			expect((await repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).toBe(0);

			// The fix the report names, then the commit it names.
			await fixChangelogs(repo);
			expect(unreleasedPart(await repo.read())).toContain(BRANCH_ENTRY);
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
			const repo = await repoWith(BASE_CHANGELOG);
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
