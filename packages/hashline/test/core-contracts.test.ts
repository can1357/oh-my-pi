import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	detectLineEnding,
	type Edit,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	type PatchSection,
	parsePatch,
	Recovery,
	type SplitOptions,
} from "@oh-my-pi/hashline";

const repl = (text: string): string => `+${text}`;

function tag(line: number): string {
	return `${line}`;
}

function sameLineRange(anchor: string): string {
	return `PUT ${anchor}:`;
}

function applyDiff(content: string, diff: string): string {
	return applyEdits(content, parsePatch(diff).edits).text;
}

interface SectionView {
	path: string;
	fileHash?: string;
	diff: string;
}

function toSectionView(section: PatchSection): SectionView {
	return section.fileHash !== undefined
		? { path: section.path, fileHash: section.fileHash, diff: section.diff }
		: { path: section.path, diff: section.diff };
}

function splitHashlineInput(input: string, options: SplitOptions = {}): SectionView {
	return toSectionView(Patch.parseSingle(input, options));
}

function splitHashlineInputs(input: string, options: SplitOptions = {}): SectionView[] {
	return Patch.parse(input, options).sections.map(toSectionView);
}

function tryRecoverHashline(args: {
	cache: InMemorySnapshotStore;
	path: string;
	currentText: string;
	tag: string;
	edits: readonly Edit[];
}): { text: string; firstChangedLine: number | undefined; warnings: string[] } | null {
	return new Recovery(args.cache).tryRecover({
		path: args.path,
		currentText: args.currentText,
		fileHash: args.tag,
		edits: args.edits,
	});
}

class BlockingFilesystem extends InMemoryFilesystem {
	#blocked = new Set<string>();

	constructor(initial: Iterable<readonly [string, string]>, blocked: Iterable<string>) {
		super(initial);
		for (const filePath of blocked) this.#blocked.add(filePath);
	}

	override async preflightWrite(filePath: string): Promise<void> {
		if (this.#blocked.has(filePath)) throw new Error(`blocked write: ${filePath}`);
	}
}

describe("hashline normalization", () => {
	it("preserves the first newline style when restoring mixed-ending files", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
	});
});

describe("hashline parser — range-anchor contracts", () => {
	const content = "aaa\nbbb\nccc";

	it("keeps parsed sections reusable across target snapshots", () => {
		const section = Patch.parseSingle(["[a.ts]", `PUT >${tag(2)}:`, repl("tail")].join("\n"));

		expect(section.applyTo("aaa\nbbb").text).toBe("aaa\nbbb\ntail");
		expect(section.applyTo("aaa\nbbb\nccc").text).toBe("aaa\nbbb\ntail\nccc");
	});

	it("applies canonical PUT/CUT operations against concrete anchors", () => {
		const diff = [
			`PUT <${tag(2)}:`,
			repl("before b"),
			`PUT >${tag(2)}:`,
			repl("after b"),
			"PUT <1:",
			repl("top"),
			"PUT >$:",
			repl("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
		expect(applyDiff(content, `CUT ${tag(2)}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `CUT ${tag(2)}-${tag(3)}`)).toBe("aaa");
		expect(applyDiff(content, `${sameLineRange(tag(2))}\n${repl("BBB")}`)).toBe("aaa\nBBB\nccc");
	});

	it("inserts after the final line without falling off the file", () => {
		expect(applyDiff(content, `PUT >${tag(3)}:\n${repl("tail")}`)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("preserves whitespace-bearing and sigil-leading payload exactly", () => {
		const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
		expect(applyDiff(content, `PUT >${tag(2)}:\n${repl(payload)}`)).toBe(`aaa\nbbb\n${payload}\nccc`);
		expect(
			applyDiff(content, `${sameLineRange(tag(2))}\n${repl("|literal")}\n${repl("^literal")}\n${repl("↓literal")}`),
		).toBe("aaa\n|literal\n^literal\n↓literal\nccc");
	});

	it("strips copied read-output prefixes only inside pasted bare body rows", () => {
		const diff = `PUT ${tag(2)}-${tag(4)}:\n${repl("line one")}\n${tag(3)}:line two`;
		const { edits, warnings } = parsePatch(diff);
		expect(applyEdits("aaa\nbbb\nccc\nddd\neee", edits).text).toBe("aaa\nline one\nline two\neee");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("rejects overlapping replacement ranges", () => {
		const diff = `PUT ${tag(2)}-${tag(4)}:\n${repl("NEW1")}\nPUT ${tag(3)}-${tag(5)}:\n${repl("NEW2")}`;
		expect(() => parsePatch(diff).edits).toThrow(/anchor line 3 is already targeted by another hunk on line 1/);
	});

	it("rejects obsolete line-hash anchors and applies line-number anchors without per-anchor hashes", () => {
		expect(() => parsePatch(`2ab:\n${repl("BBB")}`).edits).toThrow(/payload line has no preceding/);
		expect(applyDiff(content, `${sameLineRange(tag(2))}\n${repl("BBB")}`)).toBe("aaa\nBBB\nccc");
	});
});

describe("hashline input splitter", () => {
	it("extracts path, snapshot tag, and diff body from bracket headers", () => {
		const input = [`[src/foo.ts#1A2B]`, `${sameLineRange(tag(2))}`, repl("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({
			path: "src/foo.ts",
			fileHash: "1A2B",
			diff: `${sameLineRange(tag(2))}\n${repl("BBB")}`,
		});
	});

	it("normalizes leading blanks, cwd-relative paths, and explicit fallback paths", () => {
		expect(splitHashlineInput(`\n[foo.ts]\nPUT <1:\n${repl("x")}`)).toEqual({
			path: "foo.ts",
			diff: `PUT <1:\n${repl("x")}`,
		});

		const cwd = process.cwd();
		const absolute = `${cwd}/src/foo.ts`;
		expect(splitHashlineInput(`[${absolute}]\nPUT <1:\n${repl("x")}`, { cwd }).path).toBe("src/foo.ts");
		expect(splitHashlineInput(`PUT <1:\n${repl("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `PUT <1:\n${repl("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple sections and drops a trailing header without operations", () => {
		const input = ["[a.ts]", "PUT <1:", repl("a"), "[b.ts]", "PUT >$:", repl("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `PUT <1:\n${repl("a")}` },
			{ path: "b.ts", diff: `PUT >$:\n${repl("b")}` },
		]);
		expect(splitHashlineInputs(["[a.ts]", "PUT <1:", repl("a"), "[b.ts]"].join("\n"))).toEqual([
			{ path: "a.ts", diff: `PUT <1:\n${repl("a")}` },
		]);
	});

	it("rejects unified-diff hunk headers on the first line", () => {
		const input = ["@@ -1,3 +1,3 @@", "PUT <1:", repl("x")].join("\n");
		expect(() => splitHashlineInputs(input)).toThrow(/unified-diff hunk header/);
	});
});

describe("Patcher preflight", () => {
	it("preflights write policy for every section before committing a batch", async () => {
		const fixture = new BlockingFilesystem(
			[
				["a.ts", "aaa\n"],
				["b.ts", "bbb\n"],
			],
			["b.ts"],
		);
		const snapshots = new InMemorySnapshotStore();
		const aTag = snapshots.record("a.ts", "aaa\n");
		const bTag = snapshots.record("b.ts", "bbb\n");
		const input = [
			formatHashlineHeader("a.ts", aTag),
			`${sameLineRange(tag(1))}`,
			repl("AAA"),
			formatHashlineHeader("b.ts", bTag),
			`${sameLineRange(tag(1))}`,
			repl("BBB"),
		].join("\n");

		try {
			await new Patcher({ fs: fixture, snapshots }).apply(Patch.parse(input));
			throw new Error("expected blocked write");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/blocked write: b\.ts/);
		}
		expect(fixture.get("a.ts")).toBe("aaa\n");
		expect(fixture.get("b.ts")).toBe("bbb\n");
	});
});

describe("Recovery", () => {
	it("returns null when neither patch recovery nor replay can land", () => {
		const cache = new InMemorySnapshotStore();
		const filePath = "/tmp/__hashline-recovery-applypatch__.ts";
		const snapshotText = "alpha\nbeta\ngamma\ndelta\nepsilon";
		const snapshotTag = cache.record(filePath, snapshotText);

		const recovered = tryRecoverHashline({
			cache,
			path: filePath,
			currentText: "totally\nunrelated\ncontent\nhere\nnow\n",
			tag: snapshotTag,
			edits: parsePatch(`${sameLineRange(tag(2))}\n${repl("BETA-MODEL")}`).edits,
		});
		expect(recovered).toBeNull();
	});

	it("recovers from an older in-session snapshot after the current file advanced", () => {
		const cache = new InMemorySnapshotStore();
		const filePath = "/tmp/__hashline-cache-ring-recovery__.ts";
		const v0Text = "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
		const v1Text = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
		const currentText = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nTRAILER\n";

		const v0Tag = cache.record(filePath, v0Text);
		cache.record(filePath, v1Text);
		const recovered = tryRecoverHashline({
			cache,
			path: filePath,
			currentText,
			tag: v0Tag,
			edits: parsePatch(`PUT 10-10:\n${repl("L10-EDITED")}`).edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toContain("L10-EDITED");
	});
});

describe("hashline abort sentinel", () => {
	const sentinel = "*** Abort";

	it("terminates parsing without surfacing a warning", () => {
		const diff = [`PUT >${tag(1)}:`, repl("HELLO"), sentinel, `PUT >${tag(99)}:`, repl("never")].join("\n");
		const { edits, warnings } = parsePatch(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "insert", text: "HELLO" });
		expect(warnings).toEqual([]);
	});

	it("stops the input splitter before later sections", () => {
		const input = [
			"[a.ts]",
			`PUT >${tag(1)}:`,
			repl("a-payload"),
			sentinel,
			"[b.ts]",
			`PUT >${tag(1)}:`,
			repl("never"),
		].join("\n");
		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].path).toBe("a.ts");
		expect(sections[0].diff.includes("never")).toBe(false);
	});
});

describe("hashline parser — cut and blank payload semantics", () => {
	it("applies inline cut operations", () => {
		expect(applyDiff("line1\nline2\nline3\n", splitHashlineInput("[a.ts]\nCUT 2\n").diff)).toBe("line1\nline3\n");
		expect(applyDiff("line1\nline2\nline3\nline4\n", splitHashlineInput("[a.ts]\nCUT 2-3\n").diff)).toBe(
			"line1\nline4\n",
		);
	});

	it("treats old inline replacement syntax as orphan body", () => {
		const { diff } = splitHashlineInput("[a.ts]\n2.=2=replacement\n");
		expect(() => parsePatch(diff)).toThrow(/payload line has no preceding hunk header/);
	});

	it("preserves explicit blank replacement rows", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `[a.ts]\nPUT 2-2:\n${repl("")}\n${repl("")}\nPUT 4-4:\n${repl("D")}\n`;
		expect(applyDiff(text, splitHashlineInput(ops).diff)).toBe("a\n\n\nc\nD\ne\n");

		const embedded = `[a.ts]\nPUT 2-2:\n${repl("first")}\n${repl("")}\n${repl("second")}\n`;
		expect(applyDiff("a\nb\nc\n", splitHashlineInput(embedded).diff)).toBe("a\nfirst\n\nsecond\nc\n");
	});
});
