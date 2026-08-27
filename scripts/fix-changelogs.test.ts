import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	collapseChangelogTail,
	collectPromotableAddedItemLines,
	fixChangelogContent,
	runChangelogFixer,
	splitArchiveFooter,
} from "./fix-changelogs";

describe("collectPromotableAddedItemLines", () => {
	it("keeps new changelog item additions while ignoring moves and edits", () => {
		const diff = [
			"diff --git a/packages/example/CHANGELOG.md b/packages/example/CHANGELOG.md",
			"--- a/packages/example/CHANGELOG.md",
			"+++ b/packages/example/CHANGELOG.md",
			"@@ -10,0 +11,2 @@",
			"+",
			"+- Added after the latest tag in a released section.",
			"@@ -20 +22 @@",
			"-- Moved historical entry.",
			"+- Moved historical entry.",
			"@@ -30 +32,2 @@",
			"-- Historical entry with old wording.",
			"+- Historical entry with new wording.",
			"+- Another brand-new item in the same hunk.",
		].join("\n");

		const lines = collectPromotableAddedItemLines(diff);

		expect(lines.get("packages/example/CHANGELOG.md")).toEqual(new Set([12, 33]));
	});

	it("does not promote items from newly added release sections", () => {
		const diff = [
			"diff --git a/packages/example/CHANGELOG.md b/packages/example/CHANGELOG.md",
			"--- a/packages/example/CHANGELOG.md",
			"+++ b/packages/example/CHANGELOG.md",
			"@@ -1,0 +1,8 @@",
			"+# Changelog",
			"+",
			"+## [1.0.0] - 2026-01-01",
			"+",
			"+### Fixed",
			"+",
			"+- Released fix.",
			"+- Another released fix.",
		].join("\n");

		const lines = collectPromotableAddedItemLines(diff);

		expect(lines.get("packages/example/CHANGELOG.md")).toBeUndefined();
	});
});

describe("fixChangelogContent", () => {
	it("moves added released-section items to Unreleased and merges duplicate category headings", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"### Fixed",
			"",
			"- Existing fix.",
			"",
			"### Fixed",
			"",
			"- Second fix.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Added",
			"",
			"- Historical addition.",
			"- New addition in released section.",
			"",
			"### Fixed",
			"",
			"- Historical fix.",
			"- New fix in released section.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set([17, 22]));

		expect(result.promotedItems).toBe(2);
		expect(result.mergedDuplicateHeadings).toBe(1);
		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Added",
				"",
				"- New addition in released section.",
				"",
				"### Fixed",
				"",
				"- Existing fix.",
				"- Second fix.",
				"- New fix in released section.",
				"",
				"## [1.0.0] - 2026-01-01",
				"",
				"### Added",
				"",
				"- Historical addition.",
				"",
				"### Fixed",
				"",
				"- Historical fix.",
				"",
			].join("\n"),
		);
	});

	it("drops Unreleased items that already appear verbatim in a released section", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Brand-new unreleased feature.",
			"- Added fullscreen settings mouse-event handling.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
			"### Added",
			"",
			"- Added fullscreen settings mouse-event handling.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.droppedReleasedDuplicates).toBe(1);
		expect(result.promotedItems).toBe(0);
		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Added",
				"",
				"- Brand-new unreleased feature.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
				"### Added",
				"",
				"- Added fullscreen settings mouse-event handling.",
				"",
			].join("\n"),
		);
	});

	it("can recover Unreleased by dropping bullets known to be historically released", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- Historical fix still stranded in Unreleased.",
			"- Brand-new fix.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
		].join("\n");

		const result = fixChangelogContent(
			content,
			new Set(),
			new Set(["- Historical fix still stranded in Unreleased."]),
		);

		expect(result.droppedReleasedDuplicates).toBe(1);
		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Fixed",
				"",
				"- Brand-new fix.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
			].join("\n"),
		);
	});

	it("compacts blank separators between adjacent bullet items", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- First fix.",
			"",
			"- Second fix.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Fixed",
				"",
				"- First fix.",
				"- Second fix.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
			].join("\n"),
		);
	});

	it("leaves a clean changelog untouched", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Only an unreleased feature.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
			"### Added",
			"",
			"- A released feature.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.droppedReleasedDuplicates).toBe(0);
		expect(result.content).toBe(content);
	});
});

const ARCHIVE_LINK =
	"Older entries are archived in [packages/foo/CHANGELOG.md@abc123def456](https://github.com/can1357/oh-my-pi/blob/abc123def456abc123def456abc123def456abc1/packages/foo/CHANGELOG.md).";

const FOUR_SECTIONS = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"- New feature.",
	"",
	"## [1.2.0] - 2026-03-01",
	"",
	"### Fixed",
	"",
	"- Fix three.",
	"",
	"## [1.1.0] - 2026-02-01",
	"",
	"### Fixed",
	"",
	"- Fix two.",
	"",
	"## [1.0.0] - 2026-01-01",
	"",
	"### Fixed",
	"",
	"- Fix one.",
	"",
].join("\n");

describe("collapseChangelogTail", () => {
	const footerBytes = Buffer.byteLength(`\n${ARCHIVE_LINK}\n`, "utf8");

	it("drops the oldest release sections until the file plus footer fits the budget", () => {
		const keptThroughOneOne = `${FOUR_SECTIONS.slice(0, FOUR_SECTIONS.indexOf("\n\n## [1.0.0]"))}\n`;
		const maxBytes = Buffer.byteLength(keptThroughOneOne, "utf8") + footerBytes;

		const result = collapseChangelogTail(FOUR_SECTIONS, ARCHIVE_LINK, maxBytes);

		expect(result.collapsedReleases).toBe(1);
		expect(result.content).toBe(keptThroughOneOne);
		expect(Buffer.byteLength(result.content, "utf8") + footerBytes).toBeLessThanOrEqual(maxBytes);
	});

	it("always keeps Unreleased plus the newest release even when still over budget", () => {
		const result = collapseChangelogTail(FOUR_SECTIONS, ARCHIVE_LINK, 16);

		expect(result.collapsedReleases).toBe(2);
		expect(result.content).toContain("## [Unreleased]");
		expect(result.content).toContain("## [1.2.0]");
		expect(result.content).not.toContain("## [1.1.0]");
		expect(result.content).not.toContain("## [1.0.0]");
	});

	it("leaves content under the budget untouched", () => {
		const result = collapseChangelogTail(FOUR_SECTIONS, ARCHIVE_LINK, 1024 * 1024);

		expect(result.collapsedReleases).toBe(0);
		expect(result.content).toBe(FOUR_SECTIONS);
	});
});

describe("splitArchiveFooter", () => {
	it("strips a trailing archive footer so it is not parsed as section body", () => {
		const withFooter = `${FOUR_SECTIONS}\n${ARCHIVE_LINK}\n`;

		const result = splitArchiveFooter(withFooter);

		expect(result.archiveLink).toBe(ARCHIVE_LINK);
		expect(result.body).toBe(FOUR_SECTIONS);
	});

	it("passes through content without a footer", () => {
		const result = splitArchiveFooter(FOUR_SECTIONS);

		expect(result.archiveLink).toBeUndefined();
		expect(result.body).toBe(FOUR_SECTIONS);
	});
});

const RELEASED_ONLY = `# Changelog

## [Unreleased]

## [1.0.0] - 2025-01-01

### Fixed

- Old released bullet.
`;

const RELEASED_PLUS_RECOVERED = `# Changelog

## [Unreleased]

## [1.0.0] - 2025-01-01

### Fixed

- Old released bullet.
- Recovered bullet.
`;

describe("runChangelogFixer baseline pin", () => {
	it("uses the clog baseline ref as the diff floor so a recovered released bullet is not re-promoted", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clog-fix-"));
		const git = (...args: string[]) =>
			$`git ${args}`
				.cwd(repoRoot)
				.quiet()
				.env({
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				});
		try {
			const changelogPath = path.join(repoRoot, "packages/foo/CHANGELOG.md");
			await git("init", "-b", "main");
			await Bun.write(changelogPath, RELEASED_ONLY);
			await git("add", "-A");
			await git("commit", "-m", "release 1.0.0");
			await git("tag", "v1.0.0");

			// Simulate a `--recover` restoring a historically released bullet that the
			// v1.0.0 snapshot no longer carries.
			await Bun.write(changelogPath, RELEASED_PLUS_RECOVERED);
			await git("add", "-A");
			await git("commit", "-m", "recover dropped bullet");

			// No baseline tag: the floor is the latest version tag, which predates the
			// recovery, so the restored released bullet reads as added-in-a-released
			// section and is wrongly promoted back into [Unreleased].
			const withoutPin = await runChangelogFixer({ repoRoot, write: false });
			expect(withoutPin.since).toBe("v1.0.0");
			const promoted = withoutPin.changedFiles.find(file => file.path === "packages/foo/CHANGELOG.md");
			expect(promoted?.promotedItems).toBe(1);

			// Pin `clog` (a custom ref, not a tag — see resolveSince) to the recovery
			// commit: the plain run now diffs against it and leaves the bullet untouched.
			await git("update-ref", "refs/clog", "HEAD");
			const withPin = await runChangelogFixer({ repoRoot, write: false });
			expect(withPin.since).toBe("refs/clog");
			expect(withPin.changedFiles).toHaveLength(0);
		} finally {
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});
});
describe("runChangelogFixer size limit", () => {
	it("collapses oversized changelogs behind a link to the last commit containing them, idempotently", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clog-collapse-"));
		const git = (...args: string[]) =>
			$`git ${args}`
				.cwd(repoRoot)
				.quiet()
				.env({
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				});
		try {
			const changelogPath = path.join(repoRoot, "packages/foo/CHANGELOG.md");
			await git("init", "-b", "main");
			// The oldest section must outweigh the footer for a collapse to shrink the file.
			const content = FOUR_SECTIONS.replace("- Fix one.", `- Fix one. ${"x".repeat(400)}`);
			await Bun.write(changelogPath, content);
			await git("add", "-A");
			await git("commit", "-m", "release 1.2.0");
			await git("tag", "v1.2.0");
			const head = (await git("rev-parse", "HEAD")).text().trim();
			const repo = process.env.OMP_REPO ?? process.env.GITHUB_REPOSITORY ?? "can1357/oh-my-pi";
			const expectedLink = `Older entries are archived in [packages/foo/CHANGELOG.md@${head.slice(0, 12)}](https://github.com/${repo}/blob/${head}/packages/foo/CHANGELOG.md).`;

			// Budget only fits Unreleased + the two newest releases; 1.0.0 collapses.
			const maxBytes = content.indexOf("\n\n## [1.0.0]") + 1 + Buffer.byteLength(`\n${expectedLink}\n`, "utf8");
			const first = await runChangelogFixer({ repoRoot, maxBytes });
			expect(first.changedFiles).toEqual([
				{
					path: "packages/foo/CHANGELOG.md",
					promotedItems: 0,
					mergedDuplicateHeadings: 0,
					droppedReleasedDuplicates: 0,
					removedEmptyHeadings: 0,
					collapsedReleases: 1,
				},
			]);

			const collapsed = await Bun.file(changelogPath).text();
			expect(collapsed).not.toContain("## [1.0.0]");
			expect(collapsed).toContain("## [1.1.0]");
			expect(collapsed).toEndWith(`\n${expectedLink}\n`);
			expect(Buffer.byteLength(collapsed, "utf8")).toBeLessThanOrEqual(maxBytes);

			// The footer survives a second run verbatim and nothing is re-collapsed.
			const second = await runChangelogFixer({ repoRoot, maxBytes });
			expect(second.changedFiles).toHaveLength(0);
			expect(await Bun.file(changelogPath).text()).toBe(collapsed);
		} finally {
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});
});
