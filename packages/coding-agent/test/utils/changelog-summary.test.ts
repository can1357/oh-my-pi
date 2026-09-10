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

	test("counts a top-level bullet after an intervening paragraph", () => {
		const selection = summarize(`
### Fixed

- First fix.

An intervening paragraph closes the list.

   - Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("counts a top-level bullet after a subheading", () => {
		const selection = summarize(`
### Fixed

- First fix.

#### Subheading

   - Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("keeps a list open across an indented continuation line", () => {
		const selection = summarize(`
### Fixed

- First fix.
  Continued description of the first fix.
  - nested detail
- Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("does not count a one-space-indented detail bullet as a separate change", () => {
		const selection = summarize(`
### Fixed

- Fixed a thing.

 - detail kept inside the item above
`);

		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Fixed: 1 });
	});

	test("counts dedented bullets against the open list", () => {
		const selection = summarize(`
### Fixed

  - First fix.
- Second fix.
 - Third fix.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("treats a deeper bullet after an indented list as nested", () => {
		const selection = summarize(`
### Fixed

   - First fix.

    - detail kept inside the item above
`);

		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Fixed: 1 });
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

	test("does not count a thematic break as a change", () => {
		const selection = summarize(`
### Fixed

- First fix.

* * *

- Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("counts a separator run that continues the open list", () => {
		// The renderer lexes `- - -` with the open list's own marker as an item, not `hr`.
		const selection = summarize(`
### Fixed

- First fix.
- - -
- Second fix.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("restarts the list after an indented thematic break", () => {
		// The renderer lexes the `* * *` run as `hr`, closing the open list, so the
		// deeper bullet below it opens a new top-level list instead of nesting.
		const selection = summarize(`
### Fixed

 - First fix.
 * * *
  - Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("keeps the list open across a deeper thematic break", () => {
		// Indented past the open item, the break run is absorbed into the item above,
		// so the bullet below it stays nested rather than starting a new list.
		const selection = summarize(`
### Fixed

- First fix.
   * * *
  - nested detail
`);

		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Fixed: 1 });
	});

	test("refreshes the tracked marker when the list changes delimiters", () => {
		// The renderer starts a new `*` list at the second line, so the run below it
		// is an item of that list — not `hr` against the stale `-` marker.
		const selection = summarize(`
### Fixed

- First fix.
* Second fix.
* * *
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("treats a break with a stale marker as a separator", () => {
		// The second line opens a `*` list, so the `- - -` run below renders as `hr`.
		const selection = summarize(`
### Fixed

- First fix.
* Second fix.
- - -
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("adopts the new list indent on delimiter change", () => {
		const selection = summarize(`
### Fixed

  - First fix.
  * Second fix.
 - Third fix.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("restarts the list after an underscore thematic break", () => {
		// `_ _ _` never parses as a list bullet, but the renderer still lexes it as `hr`
		// and closes the list — the deeper bullet below opens a new top-level list.
		const selection = summarize(`
### Fixed

 - First fix.
 _ _ _
  - Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("restarts the list after a spaceless thematic break", () => {
		// `***` carries no list marker either, yet still renders as `hr`.
		const selection = summarize(`
### Fixed

 - First fix.
 ***
  - Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("keeps the list open across a deeper underscore break", () => {
		// Past the open indent the break is absorbed into the item above, so the
		// bullet below it stays nested rather than starting a new list.
		const selection = summarize(`
### Fixed

- First fix.
   _ _ _
  - nested detail
`);

		expect(selection.changeCount).toBe(1);
		expect(selection.categoryCounts).toEqual({ Fixed: 1 });
	});

	test("restarts the list after a blank-separated indented paragraph", () => {
		// The blank lookahead detaches the paragraph from the open item, so the deeper
		// bullet below it opens a new top-level list instead of nesting under the old one.
		const selection = summarize(`
### Fixed

  - First fix.
 * Second fix.

 Paragraph.

  * Third fix.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("keeps the list open across a blank-separated deep continuation", () => {
		// Past the open indent the continuation stays absorbed, so the bullet below it
		// is still nested — resetting on any blank-separated line would overcount here.
		const selection = summarize(`
### Fixed

- First fix.

  Continued description.
  - nested detail

- Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("restarts the list after an indented blockquote", () => {
		// The blockquote closes the open list, so the deeper bullet below it opens a new
		// top-level list instead of nesting under the old one.
		const selection = summarize(`
### Fixed

  - First fix.
 + Second fix.
 > Quote.
  - Third fix.
`);

		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Fixed: 3 });
	});

	test("does not count bullets inside a fenced code block", () => {
		const selection = summarize(`
### Fixed

- First fix.

\`\`\`
- not a change
\`\`\`

- Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("counts ordered list items like unordered ones", () => {
		// The renderer shows them as list items, so the announced count includes them.
		const selection = summarize(`
### Fixed

1. First fix.
2. Second fix.
`);

		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("announces unreleased-shaped notes truthfully", () => {
		const selection = summarize(`
- Uncategorized note.

### Fixed

   - Indented fix.
- Ordinary fix.
`);

		const breakdown = Object.values(selection.categoryCounts).reduce((total, count) => total + count, 0);
		expect(selection.changeCount).toBe(breakdown);
		expect(selection.changeCount).toBe(3);
		expect(selection.categoryCounts).toEqual({ Other: 1, Fixed: 2 });
	});
});
