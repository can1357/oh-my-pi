import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { FIX_COMMAND, findReleasedSectionChanges, UnreadableInputError } from "./check-released-changelogs";
import {
	fixChangelogFile,
	MAX_CHANGELOG_BYTES,
	type RunChangelogFixerResult,
	runChangelogFixer,
} from "./fix-changelogs";
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

function lastLine(output: string): string | undefined {
	return output.trimEnd().split("\n").at(-1);
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
			// The report ends with the command a contributor pastes to check again: the one that ran.
			expect(lastLine(failed.output)).toBe("Check again: bun scripts/check-released-changelogs.ts --base main");

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
		"rejects a fabricated released section by default and permits a release transition only in release mode",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await repo.write(
				`${BASE_CHANGELOG}\n## [2.0.0] - 2026-02-01\n\n### Added\n\n- Fabricated as already shipped\n`,
			);

			const fabricated = await check(repo, "--base", "HEAD");
			expect(fabricated.exitCode).toBe(1);
			expect(fabricated.output).toContain("This released section is not at the base.");

			const releaseMode = await check(repo, "--base", "HEAD", "--release");
			expect(releaseMode.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"requires release mode for a real release transition and still rejects an edited released section",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			const beforeRelease = (await repo.git("rev-parse", "HEAD")).output.trim();
			await cutRelease(repo, "1.1.0");
			expect(await repo.read()).toMatch(/^# Changelog\n\n## \[Unreleased\]\n\n## \[1\.1\.0\] - /);

			const defaultMode = await check(repo, "--base", beforeRelease);
			expect(defaultMode.exitCode).toBe(1);
			expect(defaultMode.output).toContain("This released section is not at the base.");

			const released = await check(repo, "--base", beforeRelease, "--release");
			expect(released.output).toContain("Released changelog sections match");
			expect(released.exitCode).toBe(0);

			await repo.write((await repo.read()).replace("- Fixed an old bug\n", "- Fixed an old bug, reworded\n"));
			const edited = await check(repo, "--base", beforeRelease, "--release");
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

	/** A base just under the limit, and the fixer's archive of it after eight new [Unreleased] entries. */
	async function fixerArchived(): Promise<{ repo: Repo; baseline: string; archived: string }> {
		let content =
			"# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n";
		for (let index = 0; ; index++) {
			const line = `- Fixed historical rendering regression ${index} in the terminal screen.\n`;
			if (Buffer.byteLength(content + line) > MAX_CHANGELOG_BYTES - 128) break;
			content += line;
		}
		const repo = await repoWith(content);
		const baseline = (await repo.git("rev-parse", "HEAD")).output.trim();
		const entries = Array.from({ length: 8 }, (_, index) => `- Added a new terminal feature ${index}\n`).join("");
		await repo.write(content.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${entries}`));
		expect((await fixChangelogs(repo)).changedFiles.map(file => file.collapsedReleases)).toEqual([1]);
		return { repo, baseline, archived: await repo.read() };
	}

	test(
		"rejects the fixer's archive when the commit its footer names cannot be read",
		async () => {
			const { repo, baseline, archived } = await fixerArchived();
			const unknown = "1".repeat(40);
			await repo.write(
				archived.replaceAll(baseline, unknown).replace(`@${baseline.slice(0, 12)}]`, `@${unknown.slice(0, 12)}]`),
			);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				`${CHANGELOG}: ## [1.0.0] - 2026-01-01\n  Missing here, and the commit the new archive footer names does not hold it`,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"rejects removing an archive footer the base has",
		async () => {
			const { repo, archived } = await fixerArchived();
			await repo.git("commit", "-qam", "chore: archived");
			await repo.write(archived.replace(/\nOlder entries are archived in .*\n$/, ""));

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Archive footer differs from the base.");
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

			const unreleased = THREE_RELEASES.slice(0, THREE_RELEASES.indexOf("## [1.2.0]"));
			await repo.write(`${unreleased}${beforeOldest}${fakeOldRelease}${fixerFooter(baseline)}\n`);
			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(
				`${CHANGELOG}: ## [0.0.1] - 2025-12-01\n  This released section is not at the base.`,
			);
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

	/** What `bun run fix:changelogs` writes for `content`, archiving behind `commit`. */
	async function fixerOutput(
		content: string,
		commit: string,
	): Promise<{ content: string; collapsedReleases: number }> {
		return fixChangelogFile(CHANGELOG, content, {
			promotableAddedItemStartLines: new Set<number>(),
			maxBytes: MAX_CHANGELOG_BYTES,
			archiveCommit: async () => commit,
		});
	}

	test(
		"verifies every archived copy of a duplicated release: a footer commit that lacks the collapsed copy fails",
		async () => {
			const top =
				"# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug\n\n";
			const firstCopy = "## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Fixed in the first copy\n\n";
			const secondCopy = `## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Fixed in the second copy ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n`;
			const older = "## [0.9.0] - 2025-12-01\n\n### Fixed\n\n- Fixed an older bug\n";
			const base = `${top}${firstCopy}${secondCopy}${older}`;
			// The fixer keeps the first copy and archives the second with 0.9.0.
			const fixed = await fixerOutput(base, "a".repeat(40));
			expect(fixed.collapsedReleases).toBe(2);
			expect(fixed.content).toContain("- Fixed in the first copy\n");
			expect(fixed.content).not.toContain("second copy");

			const linkedTo = (linked: string) => ({ release: false, readArchive: async () => linked });
			const certified = await findReleasedSectionChanges(CHANGELOG, base, fixed.content, linkedTo(base));
			expect(certified.changes).toEqual([]);

			// The linked commit holds 0.9.0 and one copy of 1.0.0: the second copy's history would go.
			const partial = `${top}${firstCopy}${older}`;
			const { changes } = await findReleasedSectionChanges(CHANGELOG, base, fixed.content, linkedTo(partial));
			expect(changes.map(change => [change.heading, change.baseCopies, change.headCopies, change.problem])).toEqual([
				["## [1.0.0] - 2026-01-01", 2, 1, undefined],
				["## [0.9.0] - 2025-12-01", 1, 0, "archive-unverified"],
			]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"passes the fixer's archive of only empty releases when the footer's commit holds them, and fails it when it does not",
		async () => {
			const base = `# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- Fixed a recent bug ${"x".repeat(MAX_CHANGELOG_BYTES)}\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n`;
			const fixed = await fixerOutput(base, "a".repeat(40));
			expect(fixed.collapsedReleases).toBe(1);
			expect(fixed.content).not.toContain("## [1.0.0]");

			const certified = await findReleasedSectionChanges(CHANGELOG, base, fixed.content, {
				release: false,
				readArchive: async () => base,
			});
			expect([certified.archived, certified.changes]).toEqual([1, []]);

			const unread = await findReleasedSectionChanges(CHANGELOG, base, fixed.content, {
				release: false,
				readArchive: async () => undefined,
			});
			expect(unread.changes.map(change => change.problem)).toEqual(["archive-footer"]);
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

			const emptyGone = await check(repo, "--base", beforeRelease, "--release");
			expect(emptyGone.output).toContain("Released changelog sections match");
			expect(emptyGone.exitCode).toBe(0);

			await repo.write(released.slice(0, released.indexOf("## [1.0.0]")));
			const entriesGone = await check(repo, "--base", beforeRelease, "--release");
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
		"fails a missing changelog while any tracked package file remains, but accepts deleting the whole package",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			const packageManifest = path.join(repo.dir, "packages/tui/package.json");
			const packageSource = path.join(repo.dir, "packages/tui/src/index.ts");
			await Bun.write(packageManifest, "{}\n");
			await Bun.write(packageSource, "export {};\n");
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: package files");

			await fs.rm(path.join(repo.dir, CHANGELOG));
			const missingChangelog = await check(repo, "--base", "HEAD", "--github-annotations");
			expect(missingChangelog.exitCode).toBe(1);
			expect(missingChangelog.output).toContain(`${CHANGELOG}: CHANGELOG.md is missing`);
			expect(missingChangelog.output).toContain(
				"This is not a package removal: a file of the package is still here",
			);
			expect(missingChangelog.output).toContain("    Still here: packages/tui/package.json\n");
			expect(missingChangelog.output).toContain(
				"::error file=packages/tui/CHANGELOG.md,title=Released changelog section changed::CHANGELOG.md is missing: changelog missing while package remains.",
			);

			await fs.rm(packageManifest);
			const manifestDeleted = await check(repo, "--base", "HEAD");
			expect(manifestDeleted.exitCode).toBe(1);

			await fs.rm(packageSource);
			const packageRemoved = await check(repo, "--base", "HEAD");
			expect(packageRemoved.exitCode).toBe(0);
			expect(packageRemoved.output).toContain(`1 sections in 1 changelogs; removed with its package: ${CHANGELOG}.`);

			// A file where the package directory was: nothing of the package is left either.
			await fs.rm(path.join(repo.dir, "packages/tui"), { recursive: true, force: true });
			await Bun.write(path.join(repo.dir, "packages/tui"), "moved\n");
			const replacedByFile = await check(repo, "--base", "HEAD");
			expect(replacedByFile.output).toContain("1 sections in 1 changelogs");
			expect(replacedByFile.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a changelog dropped from a package that lives on renamed or refilled, but accepts one merged into another package",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "packages/tui/src/index.ts"), "export const tui = 1;\n");
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "packages/ai/src/index.ts"), "export const ai = 1;\n");
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: two packages");
			const reset = async () => {
				await repo.git("reset", "-q", "--hard");
				await repo.git("clean", "-fdq");
			};

			// Renamed to a new package directory, or out of packages/: the changelog goes with it.
			for (const target of ["packages/terminal", "libs/tui"]) {
				await fs.mkdir(path.join(repo.dir, path.dirname(target)), { recursive: true });
				expect((await repo.git("mv", "packages/tui", target)).exitCode).toBe(0);
				expect((await repo.git("rm", "-qf", `${target}/CHANGELOG.md`)).exitCode).toBe(0);
				const renamed = await check(repo, "--base", "HEAD");
				expect(renamed.exitCode).toBe(1);
				expect(renamed.output).toContain(`${CHANGELOG}: CHANGELOG.md is missing`);
				expect(renamed.output).toContain(`    Moved: packages/tui/src/index.ts -> ${target}/src/index.ts\n`);
				await reset();
			}

			// Every file git tracked deleted, and a new one added in the same directory.
			await repo.git("rm", "-qr", "packages/tui");
			await Bun.write(path.join(repo.dir, "packages/tui/lib/main.ts"), "export {};\n");
			await repo.git("add", "-A");
			const refilled = await check(repo, "--base", "HEAD");
			expect(refilled.exitCode).toBe(1);
			expect(refilled.output).toContain("    Still here: packages/tui/lib/main.ts\n");
			await reset();

			// Merged into a package the base has: this package is removed, and the report names it.
			await repo.git("mv", "packages/tui/src/index.ts", "packages/ai/src/tui.ts");
			await repo.git("rm", "-qr", "packages/tui");
			const merged = await check(repo, "--base", "HEAD");
			expect(merged.output).toContain(`1 sections in 1 changelogs; removed with its package: ${CHANGELOG}.`);
			expect(merged.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test.each(["packages/tui", "packages"])(
		"fails a changelog once %s becomes a submodule, checked out or not",
		async directory => {
			// Holds the changelog where each submodule path puts it: at its root for packages/tui, in tui/ for packages.
			const submodule = repoAt(await tempDir("released-changelogs-submodule-"));
			await submodule.git("init", "-q", "-b", "main");
			await Bun.write(path.join(submodule.dir, "CHANGELOG.md"), BASE_CHANGELOG);
			await Bun.write(path.join(submodule.dir, "tui/CHANGELOG.md"), BASE_CHANGELOG);
			await submodule.git("add", "-A");
			await submodule.git("commit", "-qm", "chore: start");

			const repo = await repoWith(BASE_CHANGELOG);
			await repo.git("rm", "-qr", directory);
			await fs.rm(path.join(repo.dir, directory), { recursive: true, force: true });
			const added = await repo.git("-c", "protocol.file.allow=always", "submodule", "add", submodule.dir, directory);
			expect(added.exitCode).toBe(0);
			expect(await repo.read()).toBe(BASE_CHANGELOG);
			const checkedOut = await check(repo, "--base", "HEAD");
			expect(checkedOut.exitCode).toBe(1);
			expect(checkedOut.output).toContain(`${CHANGELOG}: The package directory is a submodule here`);

			// A CI checkout without submodules has no file there at all.
			expect((await repo.git("submodule", "--quiet", "deinit", "-f", directory)).exitCode).toBe(0);
			expect(await fs.readdir(path.join(repo.dir, directory))).toEqual([]);
			const absent = await check(repo, "--base", "HEAD");
			expect(absent.exitCode).toBe(1);
			expect(absent.output).toContain(`${CHANGELOG}: The package directory is a submodule here`);

			// Committed, the head lists the submodule where the changelog was.
			await repo.git("commit", "-qm", "chore: submodule");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(`${CHANGELOG}: The package directory is a submodule here`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a changelog turned into a symbolic link, and one that is already a symbolic link at the base",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "stored.md"), BASE_CHANGELOG);
			await fs.rm(path.join(repo.dir, CHANGELOG));
			await fs.symlink("../../stored.md", path.join(repo.dir, CHANGELOG));
			const converted = await check(repo, "--base", "HEAD");
			expect(converted.exitCode).toBe(1);
			expect(converted.output).toContain(`${CHANGELOG}: CHANGELOG.md is a symbolic link here`);

			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: symlinked changelog");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(`${CHANGELOG}: CHANGELOG.md is a symbolic link here`);
			const linkedBase = await check(repo, "--base", "HEAD");
			expect(linkedBase.exitCode).toBe(1);
			expect(linkedBase.output).toContain(`${CHANGELOG}: CHANGELOG.md is a symbolic link at the base`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"compares a renamed changelog at its new path, and fails released sections in a changelog the base does not have",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: second package");
			const renamedPath = path.join(repo.dir, "packages/terminal/CHANGELOG.md");
			await repo.git("mv", "packages/tui", "packages/terminal");
			const renamed = await check(repo, "--base", "HEAD");
			expect(renamed.output).toContain("2 sections in 2 changelogs");
			expect(renamed.exitCode).toBe(0);

			// The defect this check exists for, in a renamed package: an [Unreleased] entry under a release.
			const moved = BASE_CHANGELOG.replace(`${FIRST_ENTRY}\n`, "").replace(
				"- Fixed an old bug\n",
				`- Fixed an old bug\n${FIRST_ENTRY}\n`,
			);
			await Bun.write(renamedPath, moved);
			const movedEntry = await check(repo, "--base", "HEAD");
			expect(movedEntry.exitCode).toBe(1);
			expect(movedEntry.output).toContain(
				`packages/terminal/CHANGELOG.md (${CHANGELOG} at the base): ## [1.0.0] - 2026-01-01\n  Added under \`### Fixed\`; it belongs under \`## [Unreleased]\`, \`### Fixed\`:\n    ${FIRST_ENTRY}\n`,
			);

			await Bun.write(renamedPath, BASE_CHANGELOG);
			const freshPath = path.join(repo.dir, "packages/fresh/CHANGELOG.md");
			await Bun.write(freshPath, unreleasedPart(BASE_CHANGELOG));
			const freshPackage = await check(repo, "--base", "HEAD");
			expect(freshPackage.exitCode).toBe(0);

			// No release made it, so no released section may arrive with it.
			await Bun.write(freshPath, BASE_CHANGELOG);
			const freshRelease = await check(repo, "--base", "HEAD");
			expect(freshRelease.exitCode).toBe(1);
			expect(freshRelease.output).toContain(
				"packages/fresh/CHANGELOG.md: ## [1.0.0] - 2026-01-01\n  This released section is not at the base.",
			);
			expect((await check(repo, "--base", "HEAD", "--release")).exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a changelog reached through a linked package directory, and a package directory linked at the base, directly or through a chain of links",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: second package");
			await fs.mkdir(path.join(repo.dir, "vendor"));
			await fs.rename(path.join(repo.dir, "packages/tui"), path.join(repo.dir, "vendor/tui"));
			await fs.symlink("../vendor/tui", path.join(repo.dir, "packages/tui"));
			const linked = await check(repo, "--base", "HEAD");
			expect(linked.exitCode).toBe(1);
			expect(linked.output).toContain(`${CHANGELOG}: CHANGELOG.md is reached through a symbolic link here`);

			// Committed, the base lists the link instead of the changelog. With the link gone here,
			// only the base can show the history deleted behind it.
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: linked package directory");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(`${CHANGELOG}: CHANGELOG.md is reached through a symbolic link here`);
			await fs.rm(path.join(repo.dir, "packages/tui"));
			await Bun.write(path.join(repo.dir, "vendor/tui/CHANGELOG.md"), unreleasedPart(BASE_CHANGELOG));
			const linkedBase = await check(repo, "--base", "HEAD");
			expect(linkedBase.exitCode).toBe(1);
			expect(linkedBase.output).toContain(`${CHANGELOG}: The package directory is a symbolic link at the base`);

			// A chain of links hides the changelog from the base listing the same way.
			await Bun.write(path.join(repo.dir, "vendor/tui/CHANGELOG.md"), BASE_CHANGELOG);
			await fs.symlink("tui", path.join(repo.dir, "vendor/chain"));
			await fs.symlink("../vendor/chain", path.join(repo.dir, "packages/tui"));
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: chained package directory link");
			await fs.rm(path.join(repo.dir, "packages/tui"));
			await Bun.write(path.join(repo.dir, "vendor/tui/CHANGELOG.md"), unreleasedPart(BASE_CHANGELOG));
			const chainedBase = await check(repo, "--base", "HEAD");
			expect(chainedBase.exitCode).toBe(1);
			expect(chainedBase.output).toContain(`${CHANGELOG}: The package directory is a symbolic link at the base`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"refuses a package path that is not UTF-8, which would read as another package's, in the working tree and committed",
		async () => {
			// Byte 0x80 decodes, lossily, to U+FFFD: the name of the package beside it. One holds a fabricated release.
			const repo = await repoWith(BASE_CHANGELOG);
			const fabricated = `${unreleasedPart(BASE_CHANGELOG)}## [9.9.9] - 2026-01-01\n\n### Added\n\n- Fabricated release\n`;
			const script = [
				`raw="packages/$(printf '\\200')"`,
				`replacement="packages/$(printf '\\357\\277\\275')"`,
				`mkdir -p "$raw" "$replacement"`,
				`printf '%s' "$1" > "$raw/CHANGELOG.md"`,
				`printf '%s' "$2" > "$replacement/CHANGELOG.md"`,
			].join("\n");
			await $`bash -c ${script} _ ${fabricated} ${unreleasedPart(BASE_CHANGELOG)}`.cwd(repo.dir).quiet();

			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(2);
			expect(workingTree.output).toContain("that is not UTF-8");

			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: two packages");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(2);
			expect(committed.output).toContain("that is not UTF-8");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"keeps a byte order mark that starts a path: a file moved to \\uFEFFpackages/ leaves packages/, and a changelog under packages/\\uFEFFnew is compared",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "packages/tui/src/index.ts"), "export {};\n");
			await Bun.write(path.join(repo.dir, "packages/ai/CHANGELOG.md"), BASE_CHANGELOG);
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: two packages");

			// A decoder that drops the mark reads the move as one into packages/ai, a package the base has.
			const moved = "\uFEFFpackages/ai/src/tui.ts";
			await fs.mkdir(path.join(repo.dir, path.dirname(moved)), { recursive: true });
			await repo.git("mv", "packages/tui/src/index.ts", moved);
			await repo.git("rm", "-q", CHANGELOG);
			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(1);
			expect(workingTree.output).toContain(`    Moved: packages/tui/src/index.ts -> ${moved}\n`);
			await repo.git("commit", "-qm", "chore: move the source out of packages/");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(`    Moved: packages/tui/src/index.ts -> ${moved}\n`);

			await repo.git("reset", "-q", "--hard", "HEAD^");
			await Bun.write(path.join(repo.dir, "packages/\uFEFFnew/CHANGELOG.md"), BASE_CHANGELOG);
			const fresh = await check(repo, "--base", "HEAD");
			expect(fresh.exitCode).toBe(1);
			expect(fresh.output).toContain(
				"packages/\uFEFFnew/CHANGELOG.md: ## [1.0.0] - 2026-01-01\n  This released section is not at the base.",
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"refuses a changelog whose bytes are not UTF-8, which would read the same as the replacement character it replaced",
		async () => {
			const withReplacement = BASE_CHANGELOG.replace("- Fixed an old bug\n", "- Fixed an old bug \uFFFD\n");
			const repo = await repoWith(withReplacement);
			// The released line's valid U+FFFD becomes byte 0x80: another blob, the same text once decoded lossily.
			const bytes = Buffer.from(withReplacement, "utf8");
			const at = bytes.indexOf(Buffer.from("\uFFFD", "utf8"));
			await Bun.write(
				path.join(repo.dir, CHANGELOG),
				Buffer.concat([bytes.subarray(0, at), Buffer.from([0x80]), bytes.subarray(at + 3)]),
			);

			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(2);
			expect(workingTree.output).toContain("is not UTF-8");
			await repo.git("add", "-A");
			const index = await check(repo, "--base", "HEAD", "--index");
			expect(index.exitCode).toBe(2);
			expect(index.output).toContain("is not UTF-8");
			await repo.git("commit", "-qm", "chore: byte 0x80 in a released line");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(2);
			expect(committed.output).toContain("is not UTF-8");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"refuses a working tree with an entry under packages/ marked assume-unchanged, whose index and disk may differ",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "vendor/linked/README.md"), "vendored\n");
			await fs.symlink("../vendor/linked", path.join(repo.dir, "packages/linked"));
			await repo.git("add", "-A");
			await repo.git("update-index", "--assume-unchanged", "packages/linked");
			await fs.rm(path.join(repo.dir, "packages/linked"));

			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(2);
			expect(workingTree.output).toContain("assume packages/linked unchanged");
			const index = await check(repo, "--base", "HEAD", "--index");
			expect(index.exitCode).toBe(1);
			expect(index.output).toContain(
				"packages/linked/CHANGELOG.md: CHANGELOG.md is reached through a symbolic link here",
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"refuses a working tree that sparse checkout keeps part of packages/ out of, and checks the index with --index",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await repo.git("checkout", "-qb", "feature");
			await Bun.write(path.join(repo.dir, "vendor/linked/README.md"), "vendored\n");
			await fs.symlink("../vendor/linked", path.join(repo.dir, "packages/linked"));
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: linked package directory");
			await repo.git("checkout", "-q", "main");
			await repo.git("sparse-checkout", "set", "--no-cone", "/*", "!/packages/linked");
			expect((await repo.git("merge", "-q", "--no-ff", "--no-commit", "feature")).exitCode).toBe(0);
			// The merge stages the link; nothing of it is on disk.
			expect((await repo.git("ls-files", "-s", "--", "packages/linked")).output).toStartWith("120000 ");
			expect(await fs.lstat(path.join(repo.dir, "packages/linked")).catch(() => undefined)).toBeUndefined();

			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(2);
			expect(workingTree.output).toContain("sparse checkout");

			const index = await check(repo, "--base", "HEAD", "--index");
			expect(index.exitCode).toBe(1);
			expect(index.output).toContain(
				"packages/linked/CHANGELOG.md: CHANGELOG.md is reached through a symbolic link here",
			);
			expect(lastLine(index.output)).toBe(
				"Check again: bun scripts/check-released-changelogs.ts --base HEAD --index",
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a new package directory that is a symbolic link or a submodule with no changelog behind it, in the working tree and committed",
		async () => {
			// Neither holds a CHANGELOG.md, and the submodule is not checked out; nothing shows what either holds.
			const submodule = repoAt(await tempDir("released-changelogs-submodule-"));
			await submodule.git("init", "-q", "-b", "main");
			await Bun.write(path.join(submodule.dir, "README.md"), "vendored\n");
			await submodule.git("add", "-A");
			await submodule.git("commit", "-qm", "chore: start");
			const cases = [
				{
					dir: "packages/linked",
					heading: "CHANGELOG.md is reached through a symbolic link here",
					add: async (repo: Repo) => {
						await Bun.write(path.join(repo.dir, "vendor/linked/README.md"), "vendored\n");
						await fs.symlink("../vendor/linked", path.join(repo.dir, "packages/linked"));
						await repo.git("add", "-A");
					},
				},
				{
					dir: "packages/vendored",
					heading: "The package directory is a submodule here",
					add: async (repo: Repo) => {
						const args = ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add"];
						expect((await repo.git(...args, submodule.dir, "packages/vendored")).exitCode).toBe(0);
						expect((await repo.git("submodule", "--quiet", "deinit", "-f", "packages/vendored")).exitCode).toBe(
							0,
						);
					},
				},
			];
			for (const { dir, heading, add } of cases) {
				const repo = await repoWith(BASE_CHANGELOG);
				await add(repo);
				const workingTree = await check(repo, "--base", "HEAD");
				expect(workingTree.exitCode).toBe(1);
				expect(workingTree.output).toContain(`${dir}/CHANGELOG.md: ${heading}`);

				await repo.git("commit", "-qm", "chore: new package directory");
				const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
				expect(committed.exitCode).toBe(1);
				expect(committed.output).toContain(`${dir}/CHANGELOG.md: ${heading}`);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a package directory linked at the base under a name that holds a newline",
		async () => {
			const linked = "packages/linked\nnewline";
			const repo = await repoWith(BASE_CHANGELOG);
			await Bun.write(path.join(repo.dir, "vendor/linked/CHANGELOG.md"), BASE_CHANGELOG);
			await fs.symlink("../vendor/linked", path.join(repo.dir, linked));
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: linked package directory");
			// A regular package directory replaces the link, its changelog without the released history.
			await fs.rm(path.join(repo.dir, linked));
			await Bun.write(path.join(repo.dir, linked, "CHANGELOG.md"), unreleasedPart(BASE_CHANGELOG));
			const expected = `${linked}/CHANGELOG.md: The package directory is a symbolic link at the base`;

			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(1);
			expect(workingTree.output).toContain(expected);

			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: regular package directory");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(expected);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"compares changelogs as git stores them, so a working-tree encoding changes nothing, and still finds an entry added in that encoding",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			const changelogPath = path.join(repo.dir, CHANGELOG);
			await Bun.write(
				path.join(repo.dir, ".gitattributes"),
				"packages/*/CHANGELOG.md merge=union working-tree-encoding=UTF-16LE\n",
			);
			// Checked out again, the changelog is UTF-16LE on disk; the blob git stores is unchanged.
			await fs.rm(changelogPath);
			await repo.git("checkout", "--", CHANGELOG);
			expect((await fs.readFile(changelogPath)).subarray(0, 4)).toEqual(Buffer.from("# ", "utf16le"));
			await repo.git("commit", "-qam", "chore: changelogs in UTF-16LE on disk");
			expect((await repo.git("diff", "--quiet", "HEAD^", "HEAD", "--", CHANGELOG)).exitCode).toBe(0);

			const unchanged = await check(repo, "--base", "HEAD^");
			expect(unchanged.output).toContain("Released changelog sections match");
			expect(unchanged.exitCode).toBe(0);

			const added = BASE_CHANGELOG.replace("- Fixed an old bug\n", `- Fixed an old bug\n${BRANCH_ENTRY}\n`);
			await Bun.write(changelogPath, Buffer.from(added, "utf16le"));
			const workingTree = await check(repo, "--base", "HEAD");
			expect(workingTree.exitCode).toBe(1);
			expect(workingTree.output).toContain(`    ${BRANCH_ENTRY}\n`);

			await repo.git("commit", "-qam", "feat: entry in a released section");
			const committed = await check(repo, "--base", "HEAD^", "--head", "HEAD");
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(`    ${BRANCH_ENTRY}\n`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"checks a committed head from git objects alone, and ends with the command that checks it again",
		async () => {
			const repo = await branchBehindRelease();
			await repo.git("checkout", "-q", "feature");
			await repo.git("merge", "--no-edit", "main");
			const merge = (await repo.git("rev-parse", "HEAD")).output.trim();
			// The working tree holds the base, as the CI checkout does; only the merge commit has the change.
			await repo.git("checkout", "-q", "main");

			const committed = await check(repo, "--base", `${merge}^2`, "--head", merge);
			expect(committed.exitCode).toBe(1);
			expect(committed.output).toContain(
				`Added under \`### Added\`; it belongs under \`## [Unreleased]\`, \`### Added\`:\n    ${BRANCH_ENTRY}\n`,
			);
			expect(lastLine(committed.output)).toBe(
				`Check again: bun scripts/check-released-changelogs.ts --base '${merge}^2' --head ${merge}`,
			);

			// A released section changed in the working tree is not part of a committed head.
			await repo.write((await repo.read()).replace("- Fixed an old bug\n", "- Fixed a rewritten bug\n"));
			expect((await check(repo, "--base", "main")).exitCode).toBe(1);
			const head = await check(repo, "--base", "main", "--head", "main");
			expect(head.output).toContain("Released changelog sections match");
			expect(head.exitCode).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"compares the releases of a changelog that starts with a byte order mark before its title",
		async () => {
			const released = BASE_CHANGELOG.slice(BASE_CHANGELOG.indexOf("## [1.0.0]"));
			const repo = await repoWith(`\uFEFF# Changelog\n\n${released}`);
			await repo.write(`\uFEFF# Changelog\n\n${released.replace("- Fixed an old bug\n", "")}`);

			const result = await check(repo, "--base", "HEAD");
			expect(result.exitCode).toBe(1);
			// The section's only bullet goes, so normalization drops its empty `### Fixed` too.
			expect(result.output).toContain("Removed; put back:\n    ### Fixed\n    - Fixed an old bug\n");
		},
		TEST_TIMEOUT_MS,
	);

	// Markdown shows each of these as a level-2 release heading; the fixer reads only `## [`.
	const UNREAD_RELEASE_HEADINGS = [
		{ name: "two spaces after the #s", heading: "##  [9.9.9]" },
		{ name: "a tab after the #s", heading: "##\t[9.9.9]" },
		{ name: "one space before the #s", heading: " ## [9.9.9]" },
		{ name: "a dashed underline", heading: "[9.9.9]\n---------" },
	];

	/** Checks the working tree, then the index, then the commit of it, each against `base`. */
	async function checkEveryHead(repo: Repo, base: string): Promise<{ exitCode: number; output: string }[]> {
		const results = [await check(repo, "--base", base)];
		await repo.git("add", "-A");
		results.push(await check(repo, "--base", base, "--index"));
		await repo.git("commit", "-qm", "chore: change the changelog");
		results.push(await check(repo, "--base", base, "--head", "HEAD"));
		return results;
	}

	test.each(UNREAD_RELEASE_HEADINGS)(
		"fails a release added with $name, which Markdown shows and the fixer does not read, in the working tree, the index and a commit",
		async ({ heading }) => {
			const repo = await repoWith(BASE_CHANGELOG);
			const base = (await repo.git("rev-parse", "HEAD")).output.trim();
			await repo.write(
				BASE_CHANGELOG.replace("## [1.0.0]", `${heading}\n\n### Added\n\n- Fabricated as shipped\n\n## [1.0.0]`),
			);
			const line =
				BASE_CHANGELOG.split("\n").indexOf("## [1.0.0] - 2026-01-01") + 1 + heading.split("\n").length - 1;

			const results = await checkEveryHead(repo, base);
			expect(results.map(result => result.exitCode)).toEqual([1, 1, 1]);
			for (const result of results) {
				expect(result.output).toContain(
					`${CHANGELOG}: line ${line}, ${JSON.stringify(heading.split("\n").at(-1))}: Markdown shows a level-2 heading "[9.9.9]" where the changelog tools read no heading\n`,
				);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test.each(UNREAD_RELEASE_HEADINGS)(
		"refuses a base whose release is written with $name, so deleting it does not pass, in the working tree, the index and a commit",
		async ({ heading }) => {
			const published = BASE_CHANGELOG.replace("## [1.0.0]", `${heading}\n\n### Fixed\n\n- Published\n\n## [1.0.0]`);
			const repo = await repoWith(published);
			const base = (await repo.git("rev-parse", "HEAD")).output.trim();
			await repo.write(BASE_CHANGELOG);

			const results = await checkEveryHead(repo, base);
			expect(results.map(result => result.exitCode)).toEqual([2, 2, 2]);
			for (const result of results) {
				expect(result.output).toContain(`error: ${CHANGELOG} at the base, line `);
				expect(result.output).toContain(
					'Markdown shows a level-2 heading "[9.9.9]" where the changelog tools read no heading.',
				);
			}
		},
		TEST_TIMEOUT_MS,
	);

	// Every other way Markdown and the fixer can disagree about a heading: each is its own CommonMark rule.
	test.each([
		{ name: "a line indented three spaces", text: "   ## [9.9.9]", shown: 'a level-2 heading "[9.9.9]"' },
		{ name: "a list item", text: "- ## [9.9.9]", shown: 'a level-2 heading "[9.9.9]"' },
		{ name: "a quote", text: "> ## [9.9.9]", shown: 'a level-2 heading "[9.9.9]"' },
		{ name: "an underline of =", text: "[9.9.9]\n===", shown: 'a level-1 heading "[9.9.9]"' },
		{ name: "a level-1 heading below a release", text: "# [9.9.9]", shown: 'a level-1 heading "[9.9.9]"' },
		{ name: "a level-4 heading", text: "#### [9.9.9]", shown: 'a level-4 heading "[9.9.9]"' },
		{ name: "a level-2 heading without brackets", text: "## 9.9.9", shown: 'a level-2 heading "9.9.9"' },
		{ name: "an HTML heading", text: "<h2>[9.9.9]</h2>", shown: "an HTML heading element" },
		{ name: "an HTML heading inside text", text: "Shipped <h2>[9.9.9]</h2>", shown: "an HTML heading element" },
		{ name: "a code fence that hides the releases below it", text: "```", shown: "no heading" },
		{ name: "an HTML comment that hides the releases below it", text: "<!--", shown: "no heading" },
	])(
		"fails a head where Markdown shows the headings otherwise than the fixer reads them: $name",
		async ({ text, shown }) => {
			const head = BASE_CHANGELOG.replace("## [1.0.0]", `${text}\n\n## [1.0.0]`);
			const options = { release: false, readArchive: async () => undefined };
			const { changes } = await findReleasedSectionChanges(CHANGELOG, BASE_CHANGELOG, head, options);
			expect(changes.map(change => change.problem)).toEqual(["heading"]);
			expect(changes[0]?.heading).toContain(`: Markdown shows ${shown} where the changelog tools read `);
			// The same text at the base leaves nothing the check can compare.
			await expect(findReleasedSectionChanges(CHANGELOG, head, BASE_CHANGELOG, options)).rejects.toBeInstanceOf(
				UnreadableInputError,
			);
		},
		TEST_TIMEOUT_MS,
	);

	// `bun run release` moves only a bare `## [Unreleased]`, and adds the next one below a `# Changelog` title.
	test.each([
		{
			name: "an [Unreleased] heading with closing #s",
			head: BASE_CHANGELOG.replace("## [Unreleased]", "## [Unreleased] ##"),
		},
		{ name: "no # Changelog title", head: BASE_CHANGELOG.replace("# Changelog\n\n", "") },
		{ name: "another title", head: BASE_CHANGELOG.replace("# Changelog", "# Wrong") },
		{
			name: "a second level-1 heading above the first release",
			head: BASE_CHANGELOG.replace("# Changelog\n", "# Changelog\n\n# Notes\n"),
		},
	])(
		"fails a head with $name, and refuses a base with it",
		async ({ head }) => {
			const options = { release: false, readArchive: async () => undefined };
			const { changes } = await findReleasedSectionChanges(CHANGELOG, BASE_CHANGELOG, head, options);
			expect(changes.map(change => change.problem)).toEqual(["heading"]);
			await expect(findReleasedSectionChanges(CHANGELOG, head, BASE_CHANGELOG, options)).rejects.toBeInstanceOf(
				UnreadableInputError,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"reads a release heading with closing #s, which Markdown shows the same, and fails it as a release the base lacks",
		async () => {
			const head = BASE_CHANGELOG.replace("## [1.0.0]", "## [9.9.9] ##\n\n### Added\n\n- Fabricated\n\n## [1.0.0]");
			const options = { release: false, readArchive: async () => undefined };
			const { changes } = await findReleasedSectionChanges(CHANGELOG, BASE_CHANGELOG, head, options);
			expect(changes.map(change => [change.problem, change.heading])).toEqual([["not-at-base", "## [9.9.9] ##"]]);
		},
		TEST_TIMEOUT_MS,
	);

	// Each heading the fixer reads still matches one Markdown shows, by text; Markdown readers see other releases.
	test.each([
		{
			name: "an indented release above an HTML block that hides the real heading of the same name",
			change: (released: string) =>
				released.replace("## [1.0.0]", " ## [1.0.0] - 2026-01-01\n\n- Fabricated as released\n\n<hr>\n## [1.0.0]"),
			shown: 'Markdown shows a level-2 heading "[1.0.0] - 2026-01-01" where the changelog tools read no heading',
		},
		{
			name: "a footnote definition, whose text GitHub renders as a release heading",
			change: (released: string) =>
				released.replace("## [1.0.0]", "[^ship]: ## [9.9.9] - 2026-02-02\n\nShipped[^ship].\n\n## [1.0.0]"),
			shown: "Markdown shows a footnote definition, whose text GitHub renders as Markdown at the end of the page, where the changelog tools read text",
		},
	])(
		"fails $name, added or already at the base, in the working tree, the index and a commit",
		async ({ change, shown }) => {
			const added = await repoWith(BASE_CHANGELOG);
			const addedBase = (await added.git("rev-parse", "HEAD")).output.trim();
			await added.write(change(BASE_CHANGELOG));
			const adding = await checkEveryHead(added, addedBase);
			expect(adding.map(result => result.exitCode)).toEqual([1, 1, 1]);
			for (const result of adding) expect(result.output).toContain(shown);

			const removed = await repoWith(change(BASE_CHANGELOG));
			const removedBase = (await removed.git("rev-parse", "HEAD")).output.trim();
			await removed.write(BASE_CHANGELOG);
			const removing = await checkEveryHead(removed, removedBase);
			expect(removing.map(result => result.exitCode)).toEqual([2, 2, 2]);
			for (const result of removing) expect(result.output).toContain(shown);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"matches a heading to its own line, not its text, so a reference link that renders a release heading as a link passes",
		async () => {
			const head = BASE_CHANGELOG.replace("## [1.0.0]", "[1.0.0]: https://example.com/1.0.0\n\n## [1.0.0]");
			const options = { release: false, readArchive: async () => undefined };
			expect((await findReleasedSectionChanges(CHANGELOG, BASE_CHANGELOG, head, options)).changes).toEqual([]);
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
		{
			name: "--head cannot be resolved",
			args: ["--base", "HEAD", "--head", "no-such-commit"],
			expected: "cannot resolve --head no-such-commit",
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
	async function mergePr(repo: Repo, branch = "feature"): Promise<{ exitCode: number; output: string }> {
		// merge-pr asks `gh` for the PR's number and author.
		const bin = await tempDir("released-changelogs-gh-");
		await Bun.write(
			path.join(bin, "gh"),
			`#!/bin/sh\necho '{"number":7,"title":"feat: add branch entry","author":{"login":"alice"}}'\n`,
		);
		await fs.chmod(path.join(bin, "gh"), 0o755);
		return runScript(repo.dir, "merge-pr.ts", [branch, "--pr", "7"], {
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

	test(
		"leaves uncommitted a merge whose index adds a linked package directory that sparse checkout keeps off disk",
		async () => {
			const repo = await repoWith(BASE_CHANGELOG);
			await repo.git("checkout", "-qb", "feature");
			await Bun.write(path.join(repo.dir, "vendor/linked/README.md"), "vendored\n");
			await fs.symlink("../vendor/linked", path.join(repo.dir, "packages/linked"));
			await repo.git("add", "-A");
			await repo.git("commit", "-qm", "chore: linked package directory");
			await repo.git("checkout", "-q", "main");
			await repo.git("sparse-checkout", "set", "--no-cone", "/*", "!/packages/linked");
			const mainTip = (await repo.git("rev-parse", "HEAD")).output.trim();

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(1);
			expect(merge.output).toContain(
				"packages/linked/CHANGELOG.md: CHANGELOG.md is reached through a symbolic link here",
			);
			expect((await repo.git("rev-parse", "HEAD")).output.trim()).toBe(mainTip);
		},
		TEST_TIMEOUT_MS,
	);

	/** `feature` adds BRANCH_ENTRY under [Unreleased]; main does not move. */
	async function cleanBranch(): Promise<Repo> {
		const repo = await repoWith(BASE_CHANGELOG);
		await repo.git("checkout", "-qb", "feature");
		await repo.write(BASE_CHANGELOG.replace(`${FIRST_ENTRY}\n`, `${FIRST_ENTRY}\n${BRANCH_ENTRY}\n`));
		await repo.git("commit", "-qam", "feat: add branch entry");
		await repo.git("checkout", "-q", "main");
		return repo;
	}

	async function preCommitHook(repo: Repo, script: string): Promise<void> {
		const hook = path.join(repo.dir, ".git/hooks/pre-commit");
		await Bun.write(hook, `#!/bin/sh\nset -e\n${script}\n`);
		await fs.chmod(hook, 0o755);
	}

	test(
		"undoes a commit a pre-commit hook changed a released section in, after the index passed, leaving the merge uncommitted",
		async () => {
			const repo = await cleanBranch();
			const mainTip = (await repo.git("rev-parse", "HEAD")).output.trim();
			const hooked = "- Fixed by a hook";
			await preCommitHook(
				repo,
				`sed -i 's/^- Fixed an old bug$/- Fixed an old bug\\n${hooked}/' ${CHANGELOG}\ngit add ${CHANGELOG}`,
			);

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(1);
			expect(merge.output).toContain("A hook that `git commit` ran changed what it recorded");
			expect(merge.output).toContain(`    ${hooked}\n`);
			expect((await repo.git("rev-parse", "HEAD")).output.trim()).toBe(mainTip);
			expect((await repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).toBe(0);

			// Without the hook, the commit the report names concludes the same merge.
			await fs.rm(path.join(repo.dir, ".git/hooks/pre-commit"));
			await repo.write((await repo.read()).replace(`${hooked}\n`, ""));
			await repo.git("add", CHANGELOG);
			expect((await repo.git("commit", "--no-edit")).exitCode).toBe(0);
			expect((await repo.git("log", "-1", "--format=%s %P")).output.trim()).toMatch(
				/^Merge PR #7: feat: add branch entry \(@alice\) [0-9a-f]{40} [0-9a-f]{40}$/,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"keeps a commit a pre-commit hook changed outside released sections",
		async () => {
			const repo = await cleanBranch();
			await preCommitHook(repo, "echo hooked > HOOKED.txt\ngit add HOOKED.txt");

			const merge = await mergePr(repo);
			expect(merge.exitCode).toBe(0);
			expect((await repo.git("show", "HEAD:HOOKED.txt")).output).toBe("hooked\n");
			expect((await repo.git("log", "-1", "--format=%s")).output.trim()).toBe(
				"Merge PR #7: feat: add branch entry (@alice)",
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"refuses to merge over local changes to tracked files, which merge.autostash would put back after the commit it checks",
		async () => {
			const repo = await cleanBranch();
			const mainTip = (await repo.git("rev-parse", "HEAD")).output.trim();
			await repo.git("config", "merge.autostash", "true");
			// Both append to the same place: the autostash put back after the commit conflicts with the hook's line.
			const local = `${await repo.read()}- Unstaged local entry.\n`;
			await repo.write(local);
			await preCommitHook(repo, `printf '\\n- Fixed by a hook\\n' >> ${CHANGELOG}\ngit add ${CHANGELOG}`);

			const merge = await mergePr(repo);
			expect((await repo.git("rev-parse", "HEAD")).output.trim()).toBe(mainTip);
			expect(merge.exitCode).toBe(1);
			expect(merge.output).toContain("tracked files have local changes");
			expect((await repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).not.toBe(0);
			expect(await repo.read()).toBe(local);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"lets one run merge at a time in a worktree: a second run while the first is in its hooks stops before merging",
		async () => {
			const repo = await cleanBranch();
			await repo.git("checkout", "-qb", "two");
			await Bun.write(path.join(repo.dir, "two.txt"), "two\n");
			await repo.git("add", "two.txt");
			await repo.git("commit", "-qm", "feat: add two");
			await repo.git("checkout", "-q", "main");
			// The first commit's post-commit hook waits until released; a later commit's returns at once.
			const started = path.join(repo.dir, ".git/hook-started");
			const release = path.join(repo.dir, ".git/hook-release");
			const hook = path.join(repo.dir, ".git/hooks/post-commit");
			await Bun.write(
				hook,
				`#!/bin/sh\n[ -e '${started}' ] && exit 0\n: > '${started}'\ni=0\nwhile [ ! -e '${release}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done\n`,
			);
			await fs.chmod(hook, 0o755);

			const first = mergePr(repo);
			// The hook runs in another process and has no event to await: poll for the file it writes.
			for (let wait = 0; wait < 600 && !(await Bun.file(started).exists()); wait++) await Bun.sleep(100);
			const second = await mergePr(repo, "two");
			await Bun.write(release, "");
			const firstResult = await first;

			expect(second.exitCode).toBe(1);
			expect(second.output).toContain("another merge-pr.ts (pid ");
			expect(firstResult.exitCode).toBe(0);
			expect((await repo.git("log", "-1", "--format=%s")).output.trim()).toBe(
				"Merge PR #7: feat: add branch entry (@alice)",
			);
			expect((await repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).not.toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
