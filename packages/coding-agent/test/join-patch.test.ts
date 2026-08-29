import { describe, expect, test } from "bun:test";
import { parseFileDiffs } from "@oh-my-pi/pi-coding-agent/commit/git/diff";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

describe("joinPatch", () => {
	test("preserves space character in empty context line at end of patch", () => {
		// This simulates a hunk ending with an empty context line represented as " \n"
		const parts = [
			"@@ -1,2 +1,2 @@\n",
			"foo\n",
			"@@ -10,4 +10,4 @@\n",
			"line1\n",
			"-old\n",
			"+new\n",
			" \n", // Empty context line = space + newline
		];

		const result = vcs.joinPatches(parts);

		// The result should end with a space character (the empty context line)
		// but NOT start/end with multiple newlines
		expect(result.endsWith(" \n")).toBe(true);
		expect(result.replace(/[ \t]+$/, "")).toEqual(result); // No trailing spaces should be removed
	});

	test("normalizes multiple trailing newlines in parts", () => {
		const parts = ["line1\n", "line2\n", "line3"];
		const result = vcs.joinPatches(parts);

		// Should join with single newlines and end with one newline
		expect(result.endsWith("\n")).toBe(true);
	});

	test("adds newline to parts that are missing them", () => {
		const parts = ["line1", "line2"];
		const result = vcs.joinPatches(parts);

		// Should add newlines to both parts
		expect(result.includes("line1\n")).toBe(true);
		expect(result.endsWith("line2\n")).toBe(true);
	});
});

describe("parseFileDiffs + patch.join binary round-trip", () => {
	// git's `GIT binary patch` block is terminated by a blank line that
	// `git apply --binary` requires. parseFileDiffs → patch.join must preserve
	// it byte-exact whether or not the binary block is the last file (#8899).
	const textBlock = "diff --git a/a.txt b/a.txt\n" + "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b changed\n";
	const binaryBlock =
		"diff --git a/bin.dat b/bin.dat\n" +
		"index 1111111..2222222 100644\n" +
		"GIT binary patch\n" +
		"literal 6\n" +
		"zc$@zAB0000\n" +
		"\n";

	test("preserves binary terminator when binary block is last", () => {
		const diff = textBlock + binaryBlock;
		const rebuilt = vcs.joinPatches(parseFileDiffs(diff).map(f => f.content));
		expect(rebuilt).toBe(diff);
		expect(rebuilt.endsWith("zc$@zAB0000\n\n")).toBe(true);
	});

	test("preserves binary terminator when binary block is not last", () => {
		const diff = binaryBlock + textBlock;
		const rebuilt = vcs.joinPatches(parseFileDiffs(diff).map(f => f.content));
		expect(rebuilt).toBe(diff);
		expect(rebuilt.includes("zc$@zAB0000\n\ndiff --git a/a.txt")).toBe(true);
	});
});
