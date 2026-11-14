import { describe, expect, it } from "bun:test";
import { parseReviewDiffSnapshot } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/diff";
import type { ReviewDiffRow, ReviewSourceRow } from "@oh-my-pi/pi-tui/overlays/annotation-types";

function rowOfKind(rows: readonly ReviewDiffRow[], kind: "context" | "added" | "removed"): ReviewSourceRow;
function rowOfKind(
	rows: readonly ReviewDiffRow[],
	kind: "hunk" | "no-newline",
): Extract<ReviewDiffRow, { kind: "hunk" | "no-newline" }>;
function rowOfKind(rows: readonly ReviewDiffRow[], kind: ReviewDiffRow["kind"]): ReviewDiffRow {
	const row = rows.find(candidate => candidate.kind === kind);
	if (row === undefined) throw new Error(`missing ${kind} row`);
	return row;
}

describe("parseReviewDiffSnapshot", () => {
	it("keeps header-looking hunk rows on the quoted file with their line anchors", () => {
		const snapshot = parseReviewDiffSnapshot(
			[
				'diff --git "a/src/quoted name.ts" "b/src/quoted name.ts"',
				"index 1111111..2222222 100644",
				'--- "a/src/quoted name.ts"',
				'+++ "b/src/quoted name.ts"',
				"@@ -7,3 +7,3 @@ parse()",
				" context",
				"--- source-looking header",
				"+++ source-looking header",
				"\\ No newline at end of file",
				" context after",
			].join("\n"),
		);

		expect(snapshot.files).toHaveLength(1);
		const file = snapshot.files[0]!;
		expect(file.path).toBe("src/quoted name.ts");
		expect(file.oldPath).toBe("src/quoted name.ts");
		expect(file.newPath).toBe("src/quoted name.ts");
		expect(file.linesAdded).toBe(1);
		expect(file.linesRemoved).toBe(1);

		const removed = rowOfKind(file.rows, "removed");
		expect(removed.kind).toBe("removed");
		expect(removed.raw).toBe("--- source-looking header");
		expect(removed.content).toBe("-- source-looking header");
		expect(removed.oldLine).toBe(8);
		expect(removed.newLine).toBeUndefined();
		const added = rowOfKind(file.rows, "added");
		expect(added.kind).toBe("added");
		expect(added.raw).toBe("+++ source-looking header");
		expect(added.content).toBe("++ source-looking header");
		expect(added.oldLine).toBeUndefined();
		expect(added.newLine).toBe(8);
		const noNewline = rowOfKind(file.rows, "no-newline");
		expect(noNewline).toEqual({
			kind: "no-newline",
			raw: "\\ No newline at end of file",
			hunkHeader: "@@ -7,3 +7,3 @@ parse()",
		});
		const contextRows = file.rows.filter(row => row.kind === "context");
		expect(contextRows[1]).toMatchObject({ oldLine: 9, newLine: 9, content: "context after" });
	});

	it("preserves quoted rename/deletion identity and duplicate occurrences", () => {
		const rename = [
			'diff --git "a/src/old name.ts" "b/src/new name.ts"',
			"similarity index 100%",
			"rename from src/old name.ts",
			"rename to src/new name.ts",
		].join("\n");
		const deletion = [
			'diff --git "a/src/deleted name.ts" "b/src/deleted name.ts"',
			"deleted file mode 100644",
			"index 1234567..0000000",
			'--- "a/src/deleted name.ts"',
			"+++ /dev/null",
			"@@ -4,2 +0,0 @@",
			"-first",
			"-second",
		].join("\n");
		const duplicate = [
			'diff --git "a/src/repeated name.ts" "b/src/repeated name.ts"',
			'--- "a/src/repeated name.ts"',
			'+++ "b/src/repeated name.ts"',
			"@@ -10 +12,2 @@",
			"-old",
			"+new",
			"+extra",
		].join("\n");

		const snapshot = parseReviewDiffSnapshot([rename, deletion, duplicate, duplicate].join("\n"));
		const renamed = snapshot.files[0]!;
		expect(renamed.path).toBe("src/new name.ts");
		expect(renamed.oldPath).toBe("src/old name.ts");
		expect(renamed.newPath).toBe("src/new name.ts");

		const removed = snapshot.files[1]!;
		expect(removed.path).toBe("src/deleted name.ts");
		expect(removed.oldPath).toBe("src/deleted name.ts");
		expect(removed.newPath).toBeUndefined();
		expect(removed.rows.flatMap(row => (row.kind === "removed" ? [row.oldLine] : []))).toEqual([4, 5]);

		expect(snapshot.files.slice(2).map(file => [file.path, file.occurrence])).toEqual([
			["src/repeated name.ts", 1],
			["src/repeated name.ts", 2],
		]);
	});

	it("parses CRLF supplied diffs correctly without trailing carriage returns", () => {
		const snapshot = parseReviewDiffSnapshot(
			[
				"diff --git a/test.ts b/test.ts\r",
				"index a0b1c2d..e3f4g5h 100644\r",
				"--- a/test.ts\r",
				"+++ b/test.ts\r",
				"@@ -1 +1 @@\r",
				"-hello\r",
				"+world\r",
				"",
			].join("\n"),
		);
		expect(snapshot.files).toHaveLength(1);
		const file = snapshot.files[0]!;
		expect(file.path).toBe("test.ts");
		expect(file.linesAdded).toBe(1);
		expect(file.linesRemoved).toBe(1);
		const added = rowOfKind(file.rows, "added");
		expect(added.raw).toBe("+world");
		expect(added.content).toBe("world");
	});

	it("preserves unquoted spaced paths on mode-only diffs and decodes octal rename paths", () => {
		const modeOnly = ["diff --git a/src/my script.sh b/src/my script.sh", "old mode 100644", "new mode 100755"].join(
			"\n",
		);
		const octalRename = [
			'diff --git "a/src/caf\\303\\251 old.ts" "b/src/caf\\303\\251 new.ts"',
			"similarity index 100%",
			'rename from "src/caf\\303\\251 old.ts"',
			'rename to "src/caf\\303\\251 new.ts"',
		].join("\n");

		const snapshot = parseReviewDiffSnapshot([modeOnly, octalRename].join("\n"));
		expect(snapshot.files).toHaveLength(2);
		expect(snapshot.files[0]).toMatchObject({
			path: "src/my script.sh",
			oldPath: "src/my script.sh",
			newPath: "src/my script.sh",
		});
		expect(snapshot.files[1]).toMatchObject({
			path: "src/café new.ts",
			oldPath: "src/café old.ts",
			newPath: "src/café new.ts",
		});
	});

	it("strips custom source and destination prefixes from supplied diffs", () => {
		const snapshot = parseReviewDiffSnapshot(
			[
				"diff --git old/src/a.ts new/src/a.ts",
				"index 1234567..89abcdef 100644",
				"--- old/src/a.ts",
				"+++ new/src/a.ts",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\n"),
		);

		expect(snapshot.files).toHaveLength(1);
		expect(snapshot.files[0]).toMatchObject({
			path: "src/a.ts",
			oldPath: "src/a.ts",
			newPath: "src/a.ts",
			linesAdded: 1,
			linesRemoved: 1,
		});
	});

	it("normalizes CRLF rename-only sections without similarity metadata", () => {
		const snapshot = parseReviewDiffSnapshot(
			["diff --git a/old.ts b/new.ts\r", "rename from old.ts\r", "rename to new.ts\r", ""].join("\n"),
		);

		expect(snapshot.files).toHaveLength(1);
		expect(snapshot.files[0]).toMatchObject({ path: "new.ts", oldPath: "old.ts", newPath: "new.ts" });
	});
});
