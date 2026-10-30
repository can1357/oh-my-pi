import { describe, expect, it } from "bun:test";
import { evaluateChangelog, parseAddedLines, unreleasedRange } from "./check-changelog-attribution";

const REPO = "can1357/oh-my-pi";
const PATH = "packages/demo/CHANGELOG.md";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- Fixed a thing ([#12](https://github.com/can1357/oh-my-pi/pull/12) by [@octocat](https://github.com/octocat))

## [18.12.3] - 2026-10-19

### Fixed

- Old thing ([#9](https://github.com/can1357/oh-my-pi/issues/9))
`;

const UNRELEASED_LINE = 7;
const RELEASED_LINE = 13;

function check(
	added: { line: number; text: string }[],
	options: { association?: string; author?: string; prNumber?: number } = {},
): string[] {
	return evaluateChangelog({
		path: PATH,
		changelog: CHANGELOG,
		added,
		repo: REPO,
		prNumber: options.prNumber ?? 12,
		author: options.author ?? "octocat",
		association: options.association ?? "CONTRIBUTOR",
	});
}

describe("unreleasedRange", () => {
	it("spans the Unreleased body and stops before the next release heading", () => {
		const lines = CHANGELOG.split("\n");
		const range = unreleasedRange(lines);
		expect(range).not.toBeNull();
		expect(lines[range!.start - 1]).toBe("## [Unreleased]");
		expect(lines[range!.end]).toBe("## [18.12.3] - 2026-10-19");
	});
});

describe("changelog attribution", () => {
	it("accepts a correct external credit", () => {
		const entry = CHANGELOG.split("\n")[UNRELEASED_LINE - 1];
		expect(check([{ line: UNRELEASED_LINE, text: entry }])).toEqual([]);
	});

	it("rejects an external entry that cites only an issue", () => {
		const entry = "- Fixed a thing ([#9](https://github.com/can1357/oh-my-pi/issues/9))";
		const problems = check([{ line: UNRELEASED_LINE, text: entry }]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("must credit this PR");
		expect(problems[0]).toContain(`[#12](https://github.com/${REPO}/pull/12)`);
	});

	it("rejects a pull link credited to someone else", () => {
		const entry =
			"- Fixed a thing ([#12](https://github.com/can1357/oh-my-pi/pull/12) by [@someone](https://github.com/someone))";
		const problems = check([{ line: UNRELEASED_LINE, text: entry }]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("[@octocat]");
	});

	it("accepts an internal contributor citing an issue", () => {
		const entry = "- Fixed a thing ([#9](https://github.com/can1357/oh-my-pi/issues/9))";
		expect(check([{ line: UNRELEASED_LINE, text: entry }], { association: "MEMBER" })).toEqual([]);
	});

	it("rejects an entry added to a released section", () => {
		const entry = "- Reworded history ([#77](https://github.com/can1357/oh-my-pi/issues/77))";
		const problems = check([{ line: RELEASED_LINE, text: entry }]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("outside");
	});

	it("rejects an entry with no link at all", () => {
		const problems = check([{ line: UNRELEASED_LINE, text: "- Fixed a thing with no attribution" }]);
		expect(problems).toEqual([`${PATH}:${UNRELEASED_LINE} has no issue or pull request link`]);
	});
});

describe("parseAddedLines", () => {
	it("maps added lines to new-file line numbers and ignores removals", () => {
		const diff = [
			"diff --git a/packages/demo/CHANGELOG.md b/packages/demo/CHANGELOG.md",
			"--- a/packages/demo/CHANGELOG.md",
			"+++ b/packages/demo/CHANGELOG.md",
			"@@ -1,0 +2,2 @@",
			"+- Added first",
			"+- Added second",
			"@@ -8 +9,0 @@",
			"+- Removed elsewhere",
		].join("\n");
		expect(parseAddedLines(diff)).toEqual([
			{ path: "packages/demo/CHANGELOG.md", line: 2, text: "- Added first" },
			{ path: "packages/demo/CHANGELOG.md", line: 3, text: "- Added second" },
			{ path: "packages/demo/CHANGELOG.md", line: 9, text: "- Removed elsewhere" },
		]);
	});
});

describe("review regressions", () => {
	const doc = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"",
		"- Fixed crash",
		"  ([#12](https://github.com/can1357/oh-my-pi/pull/12) by [@octocat](https://github.com/octocat))",
		"- Internal housekeeping",
		"",
		"## [1.0.0]",
		"",
		"- Old",
		"  - Nested released",
	].join("\n");
	const run = (added: { line: number; text: string }[], pr = true) =>
		evaluateChangelog({
			path: PATH,
			changelog: doc,
			added,
			repo: REPO,
			...(pr ? { prNumber: 12, author: "octocat", association: "CONTRIBUTOR" } : {}),
		});

	it("treats an indented bullet in a released section as an entry", () => {
		expect(run([{ line: 14, text: "  - Nested released" }])[0]).toContain("outside");
	});

	it("rejects an indented uncredited bullet under Unreleased", () => {
		const local = doc.replace("- Internal housekeeping", "  - Internal housekeeping");
		const problems = evaluateChangelog({
			path: PATH,
			changelog: local,
			added: [{ line: 9, text: "  - Internal housekeeping" }],
			repo: REPO,
			prNumber: 12,
			author: "octocat",
			association: "CONTRIBUTOR",
		});
		expect(problems).toEqual([`${PATH}:9 has no issue or pull request link`]);
	});

	it("reads the credit from a wrapped continuation line", () => {
		expect(run([{ line: 7, text: "- Fixed crash" }])).toEqual([]);
	});

	it("only checks placement without --pr", () => {
		expect(run([{ line: 9, text: "- Internal housekeeping" }], false)).toEqual([]);
		expect(run([{ line: 14, text: "  - Nested released" }], false)[0]).toContain("outside");
	});
});
