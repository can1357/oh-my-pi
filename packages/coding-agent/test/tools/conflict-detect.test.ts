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

	it("parses Jujutsu diff markers into indexed sides and bases", () => {
		const blocks = scanConflictLines(
			[
				"<<<<<<< conflict 1 of 1",
				"%%%%%%% diff from: merge base",
				`${"\\".repeat(7)}        to: commit A`,
				" apple",
				"-grape",
				"+grapefruit",
				" orange",
				"+++++++ commit B",
				"APPLE",
				"GRAPE",
				"ORANGE",
				">>>>>>> conflict 1 of 1 ends",
			],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].style).toBe("jj-diff");
		expect(blocks[0].sides?.map(section => section.label)).toEqual(["commit A", "commit B"]);
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([
			["apple", "grapefruit", "orange"],
			["APPLE", "GRAPE", "ORANGE"],
		]);
		expect(blocks[0].bases?.map(section => section.label)).toEqual(["merge base"]);
		expect(blocks[0].bases?.map(section => section.lines)).toEqual([["apple", "grape", "orange"]]);
	});

	it("parses multi-sided Jujutsu snapshot markers", () => {
		const blocks = scanConflictLines(
			[
				"<<<<<<< conflict 1 of 1",
				"+++++++ side one",
				"one",
				"------- base one",
				"base-1",
				"+++++++ side two",
				"two",
				"------- base two",
				"base-2",
				"+++++++ side three",
				"three",
				">>>>>>> conflict 1 of 1 ends",
			],
			1,
		);
		expect(blocks[0].style).toBe("jj-snapshot");
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([["one"], ["two"], ["three"]]);
		expect(blocks[0].bases?.map(section => section.lines)).toEqual([["base-1"], ["base-2"]]);
	});

	it("accepts conflict markers longer than seven characters", () => {
		const marker = 11;
		const blocks = scanConflictLines(
			[
				`${"<".repeat(marker)} left`,
				"ours",
				`${"|".repeat(marker)} base`,
				"ancestor",
				"=".repeat(marker),
				"theirs",
				`${">".repeat(marker)} right`,
			],
			1,
		);
		expect(blocks[0].markerLength).toBe(marker);
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([["ours"], ["theirs"]]);
	});

	it("requires exact internal and closing marker lengths for Git conflicts", () => {
		const blocks = scanConflictLines(
			["<<<<<<< HEAD", "left", "========", "=======", "right", ">>>>>>>> literal", ">>>>>>> branch"],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([
			["left", "========"],
			["right", ">>>>>>>> literal"],
		]);
	});

	it("prefers a complete Git block when ours starts with a Jujutsu-looking marker", () => {
		const blocks = scanConflictLines(
			["<<<<<<< HEAD", "+++++++ patch", "left", "=======", "right", ">>>>>>> branch"],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].style).toBe("git");
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([["+++++++ patch", "left"], ["right"]]);
	});

	it("rejects Jujutsu grammar when repository authority allows Git only", () => {
		const blocks = scanConflictLines(
			["<<<<<<< conflict", "+++++++ side one", "left", "+++++++ side two", "right", ">>>>>>> conflict ends"],
			1,
			7,
			true,
			"git",
		);
		expect(blocks).toEqual([]);
	});

	it("keeps a shorter opener-looking line inside a lengthened Jujutsu term", () => {
		const markerLength = 11;
		const blocks = scanConflictLines(
			[
				`${"<".repeat(markerLength)} conflict 1 of 1`,
				`${"+".repeat(markerLength)} left`,
				"left body",
				"<<<<<<< literal",
				`${"-".repeat(markerLength)} base`,
				"base body",
				`${"+".repeat(markerLength)} right`,
				"right body",
				`${">".repeat(markerLength)} conflict 1 of 1 ends`,
			],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([
			["left body", "<<<<<<< literal"],
			["right body"],
		]);
		expect(blocks[0].bases?.map(section => section.lines)).toEqual([["base body"]]);
	});

	it("accepts Jujutsu term and closing markers longer than the opener", () => {
		const blocks = scanConflictLines(
			[
				"<<<<<<< conflict 1 of 1",
				"++++++++ left",
				"left body",
				"-------- base",
				"base body",
				"++++++++ right",
				"right body",
				">>>>>>>> conflict 1 of 1 ends",
			],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].sides?.map(section => section.lines)).toEqual([["left body"], ["right body"]]);
		expect(blocks[0].bases?.map(section => section.lines)).toEqual([["base body"]]);
	});

	it("accepts short marker sizes only when explicitly requested", () => {
		const lines = ["<<< HEAD", "ours", "===", "theirs", ">>> branch"];
		expect(scanConflictLines(lines, 1)).toEqual([]);
		const [block] = scanConflictLines(lines, 1, 1);
		expect(block.markerLength).toBe(3);
		expect(block.sides?.map(section => section.lines)).toEqual([["ours"], ["theirs"]]);
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

	it("parses Git named and Jujutsu indexed scopes", () => {
		expect(parseConflictUri("conflict://1/ours")).toEqual({ id: 1, scope: { role: "side", index: 1 } });
		expect(parseConflictUri("conflict://2/theirs")).toEqual({ id: 2, scope: { role: "side", index: 2 } });
		expect(parseConflictUri("conflict://3/base")).toEqual({ id: 3, scope: { role: "base", index: 1 } });
		expect(parseConflictUri("conflict://1/side/1")).toEqual({ id: 1, scope: { role: "side", index: 1 } });
		expect(parseConflictUri("conflict://2/side/3")).toEqual({ id: 2, scope: { role: "side", index: 3 } });
		expect(parseConflictUri("conflict://3/base/2")).toEqual({ id: 3, scope: { role: "base", index: 2 } });
	});

	it("rejects malformed scope tokens", () => {
		expect(() => parseConflictUri("conflict://1/side/0")).toThrow(/scope/);
		expect(() => parseConflictUri("conflict://1/mine")).toThrow(/scope/);
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
		expect(parseConflictUri("a.ts:conflict://2/side/2")).toEqual({
			id: 2,
			scope: { role: "side", index: 2 },
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

	it("preserves a selected jj term's ending EOL at an unterminated conflict EOF", () => {
		const file = [
			"<<<<<<< conflict 1 of 1",
			"+++++++ side A (no terminating newline)",
			"grapefruit",
			"%%%%%%% diff from: base (no terminating newline)",
			`${"\\".repeat(7)}        to: side B`,
			" grape",
			"+",
			">>>>>>> conflict 1 of 1 ends",
		].join("\n");
		const [block] = scanConflictLines(file.split("\n"), 1);
		const entry: ConflictEntry = {
			...block,
			id: 1,
			absolutePath: "/abs/file",
			displayPath: "file",
		};
		const withEol = expandContentTokens("@side/2", entry);
		expect(withEol).toBe("grape\n");
		expect(spliceConflict(file, entry, withEol).text).toBe("grape\n");
		expect(spliceConflict(file, entry, expandContentTokens("@side/1", entry)).text).toBe("grapefruit");

		const snapshotWithEol = [
			"<<<<<<< conflict 1 of 1",
			"%%%%%%% diff from: base (no terminating newline)",
			`${"\\".repeat(7)}        to: side A (no terminating newline)`,
			"-grape",
			"+grapefruit",
			"+++++++ side B",
			"GRAPE",
			"",
			">>>>>>> conflict 1 of 1 ends",
		].join("\n");
		const [snapshotBlock] = scanConflictLines(snapshotWithEol.split("\n"), 1);
		const snapshotEntry: ConflictEntry = {
			...snapshotBlock,
			id: 2,
			absolutePath: "/abs/file",
			displayPath: "file",
		};
		const snapshotSide = expandContentTokens("@side/2", snapshotEntry);
		expect(snapshotSide).toBe("GRAPE\n");
		expect(spliceConflict(snapshotWithEol, snapshotEntry, snapshotSide).text).toBe("GRAPE\n");
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

	it("returns normalized terms and rejects out-of-range terms", () => {
		const second = renderConflictRegion(twoWay, { role: "side", index: 2 });
		expect(second.startLine).toBe(14);
		expect(second.lines).toEqual(["theirs-1"]);
		expect(() => renderConflictRegion(twoWay, { role: "base", index: 1 })).toThrow(/0 bases/);
		expect(() => renderConflictRegion(twoWay, { role: "side", index: 3 })).toThrow(/2 sides/);
	});
});

describe("formatConflictWarning", () => {
	it("emits empty string when no entries", () => {
		expect(formatConflictWarning([])).toBe("");
	});

	it("preserves Git ours/theirs/base terminology and resolution tokens", () => {
		const entry = makeEntry({
			id: 7,
			startLine: 12,
			separatorLine: 14,
			endLine: 16,
			oursLabel: "HEAD",
			theirsLabel: "feature/x",
			oursLines: ["a", "b"],
			theirsLines: ["c"],
			baseLines: ["ancestor"],
			baseLabel: "merge base",
		});
		const text = formatConflictWarning([entry]);
		expect(text).toContain("⚠ 1 unresolved conflict detected");
		expect(text).toContain("──── #7  L12-16  git ────");
		expect(text).toContain("<<< ours  HEAD");
		expect(text).toContain(">>> theirs  feature/x");
		expect(text).toContain("=== base  merge base");
		expect(text).toContain("@ours");
		expect(text).toContain("@both");
		expect(text).not.toContain("@side/<M>");
	});

	it("renders every side of a multi-sided Jujutsu conflict", () => {
		const [block] = scanConflictLines(
			[
				"<<<<<<< conflict 1 of 1",
				"+++++++ one",
				"a",
				"------- old",
				"b",
				"+++++++ two",
				"c",
				"------- older",
				"d",
				"+++++++ three",
				"e",
				">>>>>>> conflict 1 of 1 ends",
			],

			1,
		);
		const text = formatConflictWarning([{ ...block, id: 2, absolutePath: "/tmp/f", displayPath: "f" }]);
		expect(text).toContain("+++ side/3  three");
		expect(text).toContain("--- base/2  older");
	});
	it("uses indexed terms for Jujutsu authority with Git-style markers", () => {
		const entry = makeEntry({ authority: "jj", style: "git" });
		const text = formatConflictWarning([entry]);
		expect(text).toContain("+++ side/1");
		expect(text).toContain("@side/<M>");
		expect(text).not.toContain("@ours");
	});

	it("caps each term preview at six lines", () => {
		const lines = Array.from({ length: 20 }, (_value, index) => `line-${index}`);
		const text = formatConflictWarning([makeEntry({ oursLines: lines })]);
		expect(text).toContain("line-5");
		expect(text).toContain("… (14 more lines)");
		expect(text).not.toContain("\nline-6\n");
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

	it("expands Git named sides and base", () => {
		const withBase = makeEntry({ baseLines: ["b1"], oursLines: ["o1", "o2"], theirsLines: ["t1"] });
		expect(expandContentTokens("@ours", withBase)).toBe("o1\no2");
		expect(expandContentTokens("@theirs", withBase)).toBe("t1");
		expect(expandContentTokens("@base", withBase)).toBe("b1");
		expect(expandContentTokens("@both", withBase)).toBe("o1\no2\nt1");
	});

	it("mixes Git named tokens with literal lines", () => {
		expect(expandContentTokens("// merged\n@ours\n@theirs", entry)).toBe("// merged\no1\no2\nt1");
	});

	it("rejects an unavailable Git base", () => {
		expect(() => expandContentTokens("@base", entry)).toThrow(ToolError);
	});

	it("uses indexed terms and lossless Git aliases for Jujutsu conflicts", () => {
		const jj = makeEntry({ style: "jj-snapshot", baseLines: ["b1"], oursLines: ["o1", "o2"], theirsLines: ["t1"] });
		expect(expandContentTokens("@side/1", jj)).toBe("o1\no2");
		expect(expandContentTokens("@side/2", jj)).toBe("t1");
		expect(expandContentTokens("@base/1", jj)).toBe("b1");
		expect(expandContentTokens("@ours", jj)).toBe("o1\no2");
		expect(expandContentTokens("@theirs", jj)).toBe("t1");
		expect(expandContentTokens("@base", jj)).toBe("b1");
		expect(() => expandContentTokens("@both", jj)).toThrow(/combine indexed terms explicitly/);
	});

	it("leaves token-like text inside code untouched", () => {
		expect(expandContentTokens("const x = '@ours';", entry)).toBe("const x = '@ours';");
	});

	it("handles CRLF token lines", () => {
		expect(expandContentTokens("@ours\r\n@theirs", entry)).toBe("o1\no2\nt1");
	});
});
