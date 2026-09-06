import { describe, expect, test } from "bun:test";
import type { ChangelogEntry } from "../../src/utils/changelog";
import { formatStartupChangelogSummary, parseChangelog, selectStartupChangelog } from "../../src/utils/changelog";

const shippedChangelogPath = `${import.meta.dir}/../../CHANGELOG.md`;

function summarize(content: string) {
	const entries: ChangelogEntry[] = [{ major: 1, minor: 1, patch: 0, content: `## [1.1.0] - 2026-01-01\n${content}` }];
	return selectStartupChangelog(entries, "1.0.0", "1.1.0");
}

describe("startup changelog summary", () => {
	test("counts a bullet written above any category heading", () => {
		const selection = summarize(`
- Fixed a thing before any heading.

### Changed

- Changed a thing.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Other: 1, Changed: 1 });
	});

	test("counts every CommonMark bullet marker", () => {
		const selection = summarize(`
### Added

- Added a dash entry.
+ Added a plus entry.
* Added a star entry.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Added: 3 });
	});

	test("counts a list indented up to three columns as top level", () => {
		const selection = summarize(`
### Changed

   - Changed a thing.
   - Changed another thing.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Changed: 2 });
	});

	test("does not count nested sub-bullets as separate changes", () => {
		const selection = summarize(`
### Fixed

- Fixed a thing with details:
  - detail one
  - detail two
- Fixed a second thing.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("does not count a bullet indented into a code block", () => {
		const selection = summarize(`
### Fixed

\t- Renders as an indented code block, not a change.
- Fixed a real thing.
`);

		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Fixed: 1 });
	});

	test("ignores bullet markers with no content", () => {
		const selection = summarize(`
### Changed

-
+ \t
`);

		expect(selection.changeCount).toBe(0);
		expect(selection.categoryCounts).toEqual({});
	});

	test("announced change count equals the sum of the rendered breakdown", () => {
		const selection = summarize(`
- Uncategorized fix.

### Breaking Changes

- Removed a flag.

### Fixed

- Ordinary fix.
  - nested detail
+ Plus-marker fix.
`);

		const breakdown = Object.values(selection.categoryCounts).reduce((total, count) => total + count, 0);
		expect(selection.changeCount).toBe(breakdown);
		expect(formatStartupChangelogSummary(selection)).toBe(
			"Updated to v1.1.0 · 4 changes in 1 release\n1 breaking change · 2 fixed · 1 other · Use /changelog for details.",
		);
	});

	test("keeps the uncategorized bullet of the released 18.1.12 notes in the count", async () => {
		const entries = await parseChangelog(shippedChangelogPath);
		const release = entries.find(entry => entry.major === 18 && entry.minor === 1 && entry.patch === 12);
		expect(release).toBeDefined();

		const selection = selectStartupChangelog([release as ChangelogEntry], "18.1.11", "18.1.12");
		const breakdown = Object.values(selection.categoryCounts).reduce((total, count) => total + count, 0);
		expect(selection.changeCount).toBe(breakdown);
		// The released section is immutable, so its bullet above `### Changed` stays uncategorized rather than lost.
		expect(selection.categoryCounts.Other).toBe(1);
	});

	test("unreleased section has no bullet the startup notice would misread", async () => {
		const changelog = await Bun.file(shippedChangelogPath).text();
		const unreleasedStart = changelog.indexOf("## [Unreleased]");
		expect(unreleasedStart).toBeGreaterThanOrEqual(0);
		const rest = changelog.slice(unreleasedStart + "## [Unreleased]".length);
		const nextRelease = rest.indexOf("\n## ");
		const unreleased = nextRelease === -1 ? rest : rest.slice(0, nextRelease);

		const misread: string[] = [];
		let sawHeading = false;
		let sawTopLevelBullet = false;
		for (const line of unreleased.split("\n")) {
			if (/^###\s/.test(line)) {
				sawHeading = true;
				sawTopLevelBullet = false;
				continue;
			}
			if (/^[-+*][ \t]+\S/.test(line)) {
				if (!sawHeading) misread.push(`above any heading: ${line.slice(0, 60)}`);
				sawTopLevelBullet = true;
				continue;
			}
			// An indented bullet with no shallower bullet above it renders as a code block, not a change.
			if (/^[ \t]+[-+*][ \t]+\S/.test(line) && !sawTopLevelBullet) {
				misread.push(`indented into a code block: ${line.trim().slice(0, 60)}`);
			}
		}

		expect(misread).toEqual([]);
	});
});
