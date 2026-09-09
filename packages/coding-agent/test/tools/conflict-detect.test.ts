import { describe, expect, it } from "bun:test";
import {
	type ConflictEntry,
	ConflictHistory,
	expandContentTokens,
	formatConflictWarning,
	parseConflictUri,
	renderConflictRegion,
	scanConflictLines,
	spliceConflict,
} from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

describe("scanConflictLines", () => {
	it("detects a 2-way conflict with correct line numbers and labels", () => {
		const lines = [
			"line A",
			"<<<<<<< HEAD",
			"ours one",
			"ours two",
			"=======",
			"theirs one",
			">>>>>>> feature/x",
			"line Z",
		];
		const blocks = scanConflictLines(lines, 1);
		expect(blocks).toHaveLength(1);
		const block = blocks[0];
		expect(block.startLine).toBe(2);
		expect(block.separatorLine).toBe(5);
		expect(block.endLine).toBe(7);
		expect(block.baseLine).toBeUndefined();
		expect(block.oursLabel).toBe("HEAD");
		expect(block.theirsLabel).toBe("feature/x");
		expect(block.oursLines).toEqual(["ours one", "ours two"]);
		expect(block.theirsLines).toEqual(["theirs one"]);
	});

	it("detects a 3-way diff3 conflict with base section", () => {
		const blocks = scanConflictLines(
			["<<<<<<< HEAD", "ours", "||||||| merged common ancestor", "base", "=======", "theirs", ">>>>>>> branch"],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].baseLine).toBe(3);
		expect(blocks[0].baseLabel).toBe("merged common ancestor");
		expect(blocks[0].baseLines).toEqual(["base"]);
		expect(blocks[0].oursLines).toEqual(["ours"]);
		expect(blocks[0].theirsLines).toEqual(["theirs"]);
	});

	it("offsets line numbers by firstLineNumber", () => {
		const blocks = scanConflictLines(["<<<<<<<", "o", "=======", "t", ">>>>>>>"], 100);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].startLine).toBe(100);
		expect(blocks[0].separatorLine).toBe(102);
		expect(blocks[0].endLine).toBe(104);
	});

	it("returns multiple blocks in file order", () => {
		const blocks = scanConflictLines(
			["<<<<<<< A", "o1", "=======", "t1", ">>>>>>> A", "middle", "<<<<<<< B", "o2", "=======", "t2", ">>>>>>> B"],
			1,
		);
		expect(blocks.map(b => b.oursLabel)).toEqual(["A", "B"]);
	});

	it("ignores unclosed openers", () => {
		const blocks = scanConflictLines(["<<<<<<< HEAD", "ours", "=======", "theirs"], 1);
		expect(blocks).toEqual([]);
	});

	it("ignores mis-shaped or indented marker lookalikes", () => {
		const blocks = scanConflictLines(
			[" <<<<<<< HEAD", " =======", " >>>>>>> branch", "<<<<<<<x", "========", ">>>>>>>x", "const a = 1;"],
			1,
		);
		expect(blocks).toEqual([]);
	});

	it("accepts label-less markers", () => {
		const blocks = scanConflictLines(["<<<<<<<", "ours", "=======", "theirs", ">>>>>>>"], 1);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLabel).toBeUndefined();
		expect(blocks[0].theirsLabel).toBeUndefined();
	});

	it("treats a re-opened `<<<<<<<` as a fresh block", () => {
		const blocks = scanConflictLines(
			["<<<<<<< first", "stale ours", "<<<<<<< second", "good ours", "=======", "good theirs", ">>>>>>> end"],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLabel).toBe("second");
		expect(blocks[0].oursLines).toEqual(["good ours"]);
	});

	it("detects conflicts in CRLF files and stores LF-normalized sections", () => {
		const blocks = scanConflictLines(["<<<<<<< HEAD\r", "ours\r", "=======\r", "theirs\r", ">>>>>>> feat\r"], 1);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLabel).toBe("HEAD");
		expect(blocks[0].theirsLabel).toBe("feat");
		expect(blocks[0].oursLines).toEqual(["ours"]);
		expect(blocks[0].theirsLines).toEqual(["theirs"]);
	});
});

describe("ConflictHistory", () => {
	it("assigns monotonic ids and looks entries up by id", () => {
		const history = new ConflictHistory();
		const entry1 = history.register({
			absolutePath: "/abs/a.ts",
			displayPath: "a.ts",
			startLine: 10,
			separatorLine: 12,
			endLine: 14,
			oursLines: ["o"],
			theirsLines: ["t"],
		});
		const entry2 = history.register({
			absolutePath: "/abs/b.ts",
			displayPath: "b.ts",
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLines: ["o2"],
			theirsLines: ["t2"],
		});
		expect(entry1.id).toBe(1);
		expect(entry2.id).toBe(2);
		expect(history.get(1)?.absolutePath).toBe("/abs/a.ts");
		expect(history.get(2)?.absolutePath).toBe("/abs/b.ts");
		expect(history.get(99)).toBeUndefined();
	});

	it("dedupes registration by absolutePath+startLine and refreshes recorded body", () => {
		const history = new ConflictHistory();
		const first = history.register({
			absolutePath: "/abs/a.ts",
			displayPath: "a.ts",
			startLine: 10,
			separatorLine: 12,
			endLine: 14,
			oursLines: ["old-ours"],
			theirsLines: ["old-theirs"],
		});
		const second = history.register({
			absolutePath: "/abs/a.ts",
			displayPath: "a.ts",
			startLine: 10,
			separatorLine: 12,
			endLine: 16, // file gained 2 lines in the ours section
			oursLines: ["new-ours-1", "new-ours-2", "new-ours-3"],
			theirsLines: ["new-theirs"],
		});
		expect(second.id).toBe(first.id);
		expect(history.get(first.id)?.endLine).toBe(16);
		expect(history.get(first.id)?.oursLines).toEqual(["new-ours-1", "new-ours-2", "new-ours-3"]);
	});

	it("invalidatePath drops entries scoped to one absolutePath", () => {
		const history = new ConflictHistory();
		history.register({
			absolutePath: "/abs/a.ts",
			displayPath: "a.ts",
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLines: [],
			theirsLines: [],
		});
		history.register({
			absolutePath: "/abs/b.ts",
			displayPath: "b.ts",
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLines: [],
			theirsLines: [],
		});
		history.invalidatePath("/abs/a.ts");
		expect(history.get(1)).toBeUndefined();
		expect(history.get(2)).toBeDefined();
	});
});

describe("parseConflictUri", () => {
	it("parses well-formed URIs", () => {
		expect(parseConflictUri("conflict://1")).toEqual({ id: 1 });
		expect(parseConflictUri("conflict://42")).toEqual({ id: 42 });
	});

	it("returns null for non-conflict paths", () => {
		expect(parseConflictUri("src/foo.ts")).toBeNull();
		expect(parseConflictUri("file:///abs/path")).toBeNull();
		expect(parseConflictUri("conflict://")).toBeNull();
	});

	it("parses an optional scope segment", () => {
		expect(parseConflictUri("conflict://1/ours")).toEqual({ id: 1, scope: "ours" });
		expect(parseConflictUri("conflict://2/theirs")).toEqual({ id: 2, scope: "theirs" });
		expect(parseConflictUri("conflict://3/base")).toEqual({ id: 3, scope: "base" });
	});

	it("rejects unknown scope tokens", () => {
		expect(() => parseConflictUri("conflict://1/both")).toThrow(/scope must be one of/);
		expect(() => parseConflictUri("conflict://1/extras")).toThrow(/scope must be one of/);
	});

	it("parses the bulk wildcard `conflict://*`", () => {
		expect(parseConflictUri("conflict://*")).toEqual({ id: "*" });
	});

	it("rejects a scope segment on the wildcard", () => {
		expect(() => parseConflictUri("conflict://*/ours")).toThrow(/wildcard/);
	});

	it("rejects malformed ids with a ToolError", () => {
		expect(() => parseConflictUri("conflict://0")).toThrow(ToolError);
		expect(() => parseConflictUri("conflict://-1")).toThrow(ToolError);
		expect(() => parseConflictUri("conflict://1.5")).toThrow(ToolError);
		expect(() => parseConflictUri("conflict://abc")).toThrow(ToolError);
		expect(() => parseConflictUri("conflict://1/extra")).toThrow(ToolError);
	});

	it("recovers an erroneous `<file>:` prefix and surfaces it as `recoveredPrefix`", () => {
		expect(parseConflictUri("src/foo.ts:conflict://3")).toEqual({
			id: 3,
			recoveredPrefix: "src/foo.ts",
		});
		expect(parseConflictUri("packages/coding-agent/src/x.ts:conflict://*")).toEqual({
			id: "*",
			recoveredPrefix: "packages/coding-agent/src/x.ts",
		});
		expect(parseConflictUri("a.ts:conflict://2/theirs")).toEqual({
			id: 2,
			scope: "theirs",
			recoveredPrefix: "a.ts",
		});
	});

	it("does not set `recoveredPrefix` on clean URIs", () => {
		expect(parseConflictUri("conflict://1")).not.toHaveProperty("recoveredPrefix");
		expect(parseConflictUri("conflict://*")).not.toHaveProperty("recoveredPrefix");
	});
});

function makeEntry(overrides: Partial<ConflictEntry> = {}): ConflictEntry {
	return {
		id: 1,
		absolutePath: "/abs/a.ts",
		displayPath: "a.ts",
		startLine: 2,
		separatorLine: 4,
		endLine: 6,
		oursLines: ["o"],
		theirsLines: ["t"],
		...overrides,
	};
}

describe("spliceConflict", () => {
	const file = ["before", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", "after", ""].join("\n");
	const entry = makeEntry({
		startLine: 2,
		separatorLine: 4,
		endLine: 6,
		oursLabel: "HEAD",
		theirsLabel: "feat",
		oursLines: ["ours"],
		theirsLines: ["theirs"],
	});

	it("replaces the marker region with the chosen content", () => {
		const result = spliceConflict(file, entry, "resolved\n");
		expect(result.text).toBe("before\nresolved\nafter\n");
	});

	it("accepts multi-line replacement", () => {
		const result = spliceConflict(file, entry, "alpha\nbeta\n");
		expect(result.text).toBe("before\nalpha\nbeta\nafter\n");
	});

	it("accepts empty replacement", () => {
		const result = spliceConflict(file, entry, "");
		expect(result.text).toBe("before\n\nafter\n");
	});

	it("relocates the block when earlier lines have been added (line numbers shift)", () => {
		const shifted = ["// new comment 1", "// new comment 2", ...file.split("\n")].join("\n");
		const result = spliceConflict(shifted, entry, "resolved\n");
		expect(result.text).toBe("// new comment 1\n// new comment 2\nbefore\nresolved\nafter\n");
	});

	it("rejects when the recorded marker block has been edited away", () => {
		const stale = ["before", "// resolved by hand", "after", ""].join("\n");
		expect(() => spliceConflict(stale, entry, "x\n")).toThrow(/no longer present/);
	});

	it("rejects when the file is shorter than the recorded region", () => {
		expect(() => spliceConflict("short\n", entry, "x\n")).toThrow(/no longer present/);
	});

	it("splices CRLF files and preserves CRLF line endings", () => {
		const crlfFile = ["before", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", "after", ""].join(
			"\r\n",
		);
		const result = spliceConflict(crlfFile, entry, "alpha\nbeta\n");
		expect(result.text).toBe("before\r\nalpha\r\nbeta\r\nafter\r\n");
	});

	it("does not append \\r when the spliced region ends the file without a trailing newline", () => {
		const crlfNoEof = ["before", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat"].join("\r\n");
		const result = spliceConflict(crlfNoEof, entry, "resolved");
		expect(result.text).toBe("before\r\nresolved");
	});
});

describe("spliceConflict boundary-echo repair", () => {
	// The 08-multi-file-rename shape: the two lines after the closer are the
	// function tail models love to re-emit when they paste the "whole
	// resolved function" as the replacement.
	const fnLines = [
		"const queue = [];",
		"<<<<<<< HEAD",
		"export function scheduleTask(task, priority = 0) {",
		"\tif (dupe(task)) {",
		"\t\treturn;",
		"\t}",
		"=======",
		"export function enqueueTask(task) {",
		"\tif (queued.has(task.id)) {",
		"\t\treturn;",
		"\t}",
		">>>>>>> feature",
		"\tqueue.push(task);",
		"}",
		"",
	];
	const fnEntry = makeEntry({
		startLine: 2,
		separatorLine: 7,
		endLine: 12,
		oursLabel: "HEAD",
		theirsLabel: "feature",
		oursLines: fnLines.slice(2, 6),
		theirsLines: fnLines.slice(7, 11),
	});

	it("drops a multi-line trailing echo of the context below the region", () => {
		const replacement = [
			"export function scheduleTask(task, priority = 0) {",
			"\tif (queued.has(task.id)) {",
			"\t\treturn;",
			"\t}",
			"\tqueue.push(task);",
			"}",
		].join("\n");
		const result = spliceConflict(fnLines.join("\n"), fnEntry, replacement);
		expect(result.trimmedTrailing).toBe(2);
		expect(result.trimmedLeading).toBe(0);
		expect(result.text).toBe(
			[
				"const queue = [];",
				"export function scheduleTask(task, priority = 0) {",
				"\tif (queued.has(task.id)) {",
				"\t\treturn;",
				"\t}",
				"\tqueue.push(task);",
				"}",
				"",
			].join("\n"),
		);
	});

	// The 02-rename-vs-limits shape: a lone `}` echoed after a body-only region.
	const bodyLines = [
		"function nextDelay(a) {",
		"<<<<<<< HEAD",
		"\tconst delay = BASE * 2 ** a;",
		"\treturn Math.min(delay, 10_000);",
		"=======",
		"\tconst d = B * 2 ** a;",
		"\treturn Math.min(d, 30_000);",
		">>>>>>> tune",
		"}",
		"",
	];
	const bodyEntry = makeEntry({
		startLine: 2,
		separatorLine: 5,
		endLine: 8,
		oursLabel: "HEAD",
		theirsLabel: "tune",
		oursLines: bodyLines.slice(2, 4),
		theirsLines: bodyLines.slice(5, 7),
	});

	it("drops a single-line echo when it fixes the region's delimiter balance", () => {
		const replacement = ["\tconst delay = BASE * 2 ** a;", "\treturn Math.min(delay, 30_000);", "}"].join("\n");
		const result = spliceConflict(bodyLines.join("\n"), bodyEntry, replacement);
		expect(result.trimmedTrailing).toBe(1);
		expect(result.text).toBe(
			[
				"function nextDelay(a) {",
				"\tconst delay = BASE * 2 ** a;",
				"\treturn Math.min(delay, 30_000);",
				"}",
				"",
			].join("\n"),
		);
	});

	it("keeps a single-line echo when the delimiter balance is already consistent", () => {
		const file = ["start", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x", "done();", ""].join("\n");
		const entry = makeEntry({
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "x",
			oursLines: ["a"],
			theirsLines: ["b"],
		});
		const result = spliceConflict(file, entry, "merged\ndone();");
		expect(result.trimmedTrailing).toBe(0);
		expect(result.text).toBe("start\nmerged\ndone();\ndone();\n");
	});

	it("drops a multi-line leading echo of the context above the region", () => {
		const file = [
			"// header",
			"const queue = [];",
			"<<<<<<< HEAD",
			"a",
			"=======",
			"b",
			">>>>>>> x",
			"tail",
			"",
		].join("\n");
		const entry = makeEntry({
			startLine: 3,
			separatorLine: 5,
			endLine: 7,
			oursLabel: "HEAD",
			theirsLabel: "x",
			oursLines: ["a"],
			theirsLines: ["b"],
		});
		const result = spliceConflict(file, entry, "// header\nconst queue = [];\nmerged");
		expect(result.trimmedLeading).toBe(2);
		expect(result.text).toBe("// header\nconst queue = [];\nmerged\ntail\n");
	});

	it("repairs echoes in CRLF files without breaking EOL round-trip", () => {
		const crlf = bodyLines.join("\r\n");
		const replacement = ["\tconst delay = BASE * 2 ** a;", "\treturn Math.min(delay, 30_000);", "}"].join("\n");
		const result = spliceConflict(crlf, bodyEntry, replacement);
		expect(result.trimmedTrailing).toBe(1);
		expect(result.text).toBe(
			[
				"function nextDelay(a) {",
				"\tconst delay = BASE * 2 ** a;",
				"\treturn Math.min(delay, 30_000);",
				"}",
				"",
			].join("\r\n"),
		);
	});
});

describe("renderConflictRegion", () => {
	const twoWay = makeEntry({
		startLine: 10,
		separatorLine: 13,
		endLine: 15,
		oursLabel: "HEAD",
		theirsLabel: "feature/x",
		oursLines: ["ours-1", "ours-2"],
		theirsLines: ["theirs-1"],
	});
	const threeWay = makeEntry({
		startLine: 20,
		baseLine: 22,
		separatorLine: 24,
		endLine: 26,
		oursLabel: "HEAD",
		baseLabel: "common ancestor",
		theirsLabel: "feat",
		oursLines: ["o"],
		baseLines: ["b"],
		theirsLines: ["t"],
	});

	it("returns full block with marker lines reconstructed from labels", () => {
		const region = renderConflictRegion(twoWay, undefined);
		expect(region.startLine).toBe(10);
		expect(region.lines).toEqual(["<<<<<<< HEAD", "ours-1", "ours-2", "=======", "theirs-1", ">>>>>>> feature/x"]);
	});

	it("includes the base section in a diff3 full block", () => {
		const region = renderConflictRegion(threeWay, undefined);
		expect(region.startLine).toBe(20);
		expect(region.lines).toEqual([
			"<<<<<<< HEAD",
			"o",
			"||||||| common ancestor",
			"b",
			"=======",
			"t",
			">>>>>>> feat",
		]);
	});

	it("omits the label when none was recorded", () => {
		const noLabels = makeEntry({
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLabel: undefined,
			theirsLabel: undefined,
			oursLines: ["o"],
			theirsLines: ["t"],
		});
		const region = renderConflictRegion(noLabels, undefined);
		expect(region.lines[0]).toBe("<<<<<<<");
		expect(region.lines[region.lines.length - 1]).toBe(">>>>>>>");
	});

	it("returns just the ours body with the line number after `<<<<<<<`", () => {
		const region = renderConflictRegion(twoWay, "ours");
		expect(region.startLine).toBe(11);
		expect(region.lines).toEqual(["ours-1", "ours-2"]);
	});

	it("returns just the theirs body with the line number after `=======`", () => {
		const region = renderConflictRegion(twoWay, "theirs");
		expect(region.startLine).toBe(14);
		expect(region.lines).toEqual(["theirs-1"]);
	});

	it("returns just the base body for a diff3 conflict", () => {
		const region = renderConflictRegion(threeWay, "base");
		expect(region.startLine).toBe(23);
		expect(region.lines).toEqual(["b"]);
	});

	it("rejects `base` scope for a 2-way conflict", () => {
		expect(() => renderConflictRegion(twoWay, "base")).toThrow(/no base section/);
	});
});

describe("formatConflictWarning", () => {
	it("emits empty string when no entries", () => {
		expect(formatConflictWarning([])).toBe("");
	});

	it("renders the compact diff-style block with labels aggregated at top", () => {
		const entry = makeEntry({
			id: 7,
			startLine: 12,
			separatorLine: 14,
			endLine: 16,
			oursLabel: "HEAD",
			theirsLabel: "feature/x",
			oursLines: ["a", "b"],
			theirsLines: ["c"],
		});
		const text = formatConflictWarning([entry]);
		expect(text).toContain("⚠ 1 unresolved conflict detected");
		expect(text).toContain("- ours = HEAD");
		expect(text).toContain("- theirs = feature/x");
		expect(text).toContain("──── #7  L12-16 ────");
		expect(text).toContain("<<< ours");
		expect(text).toContain("\na\n");
		expect(text).toContain("\nb\n");
		expect(text).toContain(">>> theirs");
		expect(text).toContain("\nc");
		// NOTICE line with shorthand tokens.
		expect(text).toContain("NOTICE: Inspect a block by reading `conflict://<N>`");
		expect(text).toContain('`write({ path: "conflict://<N>", content })`');
		expect(text).toContain('`write({ path: "conflict://*", content })`');
		expect(text).toContain("@ours");
		expect(text).toContain("@theirs");
		// No per-block invocation; the old verbose header is gone.
		expect(text).not.toContain('write({ path: "conflict://7"');
		expect(text).not.toContain("--- ours");
		expect(text).not.toContain("[conflict #7]");
	});

	it("pluralizes the summary count and emits one block per entry", () => {
		const e1 = makeEntry({ id: 1 });
		const e2 = makeEntry({ id: 2, startLine: 20, separatorLine: 22, endLine: 24 });
		const text = formatConflictWarning([e1, e2]);
		expect(text).toContain("⚠ 2 unresolved conflicts detected");
		expect(text).toContain("──── #1  L2-6 ────");
		expect(text).toContain("──── #2  L20-24 ────");
	});

	it("collapses base ≡ ours by skipping the redundant body", () => {
		const entry = makeEntry({
			id: 3,
			baseLines: ["o"],
			oursLines: ["o"],
			theirsLines: ["t"],
			baseLabel: "ancestor",
		});
		const text = formatConflictWarning([entry]);
		expect(text).toContain("=== base ≡ ours");
		// Base body should not be duplicated.
		const baseHeaderIdx = text.indexOf("=== base ≡ ours");
		const theirsHeaderIdx = text.indexOf(">>> theirs");
		expect(theirsHeaderIdx).toBeGreaterThan(baseHeaderIdx);
		const between = text.slice(baseHeaderIdx + "=== base ≡ ours".length, theirsHeaderIdx).trim();
		expect(between).toBe("");
	});

	it("collapses base ≡ theirs the same way", () => {
		const entry = makeEntry({
			id: 4,
			baseLines: ["t"],
			oursLines: ["o"],
			theirsLines: ["t"],
		});
		const text = formatConflictWarning([entry]);
		expect(text).toContain("=== base ≡ theirs");
	});

	it("prints the base body when base differs from both sides", () => {
		const entry = makeEntry({
			id: 5,
			baseLines: ["b"],
			oursLines: ["o"],
			theirsLines: ["t"],
			baseLabel: "common ancestor",
		});
		const text = formatConflictWarning([entry]);
		expect(text).toContain("- base = common ancestor");
		expect(text).toContain("=== base");
		expect(text).not.toContain("=== base ≡");
		expect(text).toContain("\nb\n");
	});

	it("omits the ours/theirs label lines when no entry has labels", () => {
		const entry = makeEntry({ oursLabel: undefined, theirsLabel: undefined });
		const text = formatConflictWarning([entry]);
		expect(text).not.toContain("- ours =");
		expect(text).not.toContain("- theirs =");
	});

	it("caps the body preview at PREVIEW_SIDE_LINES with a `… N more lines` footer", () => {
		const ours = Array.from({ length: 20 }, (_v, i) => `o${i}`);
		const entry = makeEntry({ id: 6, oursLines: ours, theirsLines: ["t"] });
		const text = formatConflictWarning([entry]);
		expect(text).toContain("\no0\n");
		expect(text).toContain("\no5\n");
		// 6 lines shown, so 14 remain.
		expect(text).toContain("… (14 more lines)");
		// Lines past the cap are dropped from the preview.
		expect(text).not.toContain("\no6\n");
	});
});

describe("expandContentTokens", () => {
	const entry = makeEntry({
		oursLines: ["o1", "o2"],
		theirsLines: ["t1"],
	});

	it("returns content unchanged when no tokens are present", () => {
		expect(expandContentTokens("hand-written\nline\n", entry)).toBe("hand-written\nline\n");
	});

	it("expands a bare `@ours` token", () => {
		expect(expandContentTokens("@ours", entry)).toBe("o1\no2");
	});

	it("expands `@theirs` and `@both` line tokens", () => {
		expect(expandContentTokens("@theirs", entry)).toBe("t1");
		expect(expandContentTokens("@both", entry)).toBe("o1\no2\nt1");
	});

	it("mixes tokens with literal lines", () => {
		expect(expandContentTokens("// keep both\n@ours\n@theirs", entry)).toBe("// keep both\no1\no2\nt1");
	});

	it("expands `@base` only when the entry has a base section", () => {
		const withBase = makeEntry({ baseLines: ["b1"], oursLines: ["o"], theirsLines: ["t"] });
		expect(expandContentTokens("@base", withBase)).toBe("b1");
		expect(() => expandContentTokens("@base", entry)).toThrow(ToolError);
	});

	it("leaves `@ours` inside a real code line literal (token must be the whole line)", () => {
		expect(expandContentTokens("const x = '@ours';", entry)).toBe("const x = '@ours';");
	});

	it("handles CRLF input lines", () => {
		expect(expandContentTokens("@ours\r\n@theirs", entry)).toBe("o1\no2\nt1");
	});
});
