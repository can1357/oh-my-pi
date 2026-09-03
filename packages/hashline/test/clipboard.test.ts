import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	type BlockResolver,
	type BlockSpan,
	type Clipboard,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	parsePatch,
	parsePatchStreaming,
	resolveBlockEdits,
} from "@oh-my-pi/hashline";

const PATH = "x.ts";

// Deterministic stub: the block beginning on line N spans [N, N+1].
const stubResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });

function taggedPatcher(files: Array<[string, string]>): {
	fs: InMemoryFilesystem;
	snapshots: InMemorySnapshotStore;
	patcher: Patcher;
	tags: Map<string, string>;
} {
	const fs = new InMemoryFilesystem(files);
	const snapshots = new InMemorySnapshotStore();
	const tags = new Map<string, string>();
	for (const [path, text] of files) tags.set(path, snapshots.record(path, text));
	return { fs, snapshots, patcher: new Patcher({ fs, snapshots }), tags };
}

describe("clipboard parsing", () => {
	it("lowers `CUT N-M` to a capture plus per-line deletes", () => {
		const cut = parsePatch("CUT 2-3").edits;
		expect(cut.map(edit => edit.kind)).toEqual(["cut", "delete", "delete"]);
		expect(cut[0]).toMatchObject({ kind: "cut", range: { start: { line: 2 }, end: { line: 3 } } });
	});

	it("parses every PUT paste locator, rejecting colons on register PUTs", () => {
		const cursors = parsePatch("CUT 1\nPUT <2\nPUT >3\nPUT <1\nPUT >$").edits.flatMap(edit =>
			edit.kind === "paste" && edit.at.kind === "gap" ? [edit.at.cursor] : [],
		);
		expect(cursors).toEqual([
			{ kind: "before_anchor", anchor: { line: 2 } },
			{ kind: "after_anchor", anchor: { line: 3 } },
			{ kind: "bof" },
			{ kind: "eof" },
		]);
	});

	it("rejects colon on register PUT", () => {
		expect(() => parsePatch("PUT >2 @name:")).toThrow(/never takes `:`/);
	});

	it("rejects body rows under CUT", () => {
		expect(() => parsePatch("CUT 1-2\n+x")).toThrow(/`CUT` deletes/);
	});

	it("rejects a CUT range overlapping another hunk's range", () => {
		expect(() => parsePatch("CUT 2-4\nPUT 3:\n+x")).toThrow(/already targeted by another hunk/);
	});

	it("reports inverted CUT ranges with op-specific retry forms", () => {
		expect(() => parsePatch("CUT 5-2")).toThrow(/`CUT 5`.*`CUT 5\.=6`/);
	});

	it("flushes a trailing bodyless clipboard op in streaming mode", () => {
		const { edits } = parsePatchStreaming("CUT 1\nPUT >$");
		expect(edits.map(edit => edit.kind)).toEqual(["cut", "delete", "paste"]);
	});
});

describe("clipboard apply semantics", () => {
	it("moves a range within a file (CUT + PUT)", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 2-3\nPUT >5`);
		expect(section.applyTo("l1\nl2\nl3\nl4\nl5\n").text).toBe("l1\nl4\nl5\nl2\nl3\n");
	});

	it("repeats CUT content without consuming the clipboard", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 2\nPUT <1\nPUT >$`);
		expect(section.applyTo("l1\nl2\nl3\n").text).toBe("l2\nl1\nl3\nl2\n");
	});

	it("swaps two regions with named registers", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 1-2 @a\nCUT 3-4 @b\nPUT <1 @b\nPUT >$ @a`);
		expect(section.applyTo("a1\na2\nb1\nb2").text).toBe("b1\nb2\na1\na2");
	});

	it("rejects PUT with an empty register", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT >1`);
		expect(() => section.applyTo("l1\nl2\n")).toThrow(/Nothing to paste/);
	});

	// Pasting a never-captured register over a span would delete the range and
	// write nothing back — a mistyped register name must not silently destroy
	// content. (Gap pastes stay a warned no-op; see the next test.)
	it("rejects a span paste from an empty named register instead of deleting the range", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT 2-3 @gone`);
		expect(() => section.applyTo("l1\nl2\nl3\nl4\n")).toThrow(/`@gone` is empty.*would delete those lines/s);
	});

	it("pastes nothing at a gap from an empty named register, with a warning", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 1 @kept\nPUT >2 @gone`);
		const result = section.applyTo("l1\nl2\n");
		expect(result.text).toBe("l2\n");
		expect(result.warnings?.join("\n")).toMatch(/`@gone` was empty.*Available registers: `@kept`/);
	});

	it("drops an empty-register PUT on the streaming-tolerant path", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT >1`);
		expect(section.applyPartialTo("l1\nl2\n").text).toBe("l1\nl2\n");
	});

	it("allows a CUT without a following PUT", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 2`);
		expect(section.applyTo("l1\nl2\nl3\n").text).toBe("l1\nl3\n");
	});

	it("rejects multiple unlabeled CUTs before an unlabeled paste", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 1\nCUT 3\nPUT >$`);
		expect(() => section.applyTo("l1\nl2\nl3\n")).toThrow(/unlabeled `CUT`s are pending/);
	});

	it("allows consecutive CUTs into named registers", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 1 @first\nCUT 3 @second\nPUT >$ @second`);
		expect(section.applyTo("l1\nl2\nl3\n").text).toBe("l2\nl3\n");
	});

	it("rejects an out-of-range capture", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 8-9\nPUT <1`);
		expect(() => section.applyTo("l1\nl2\n")).toThrow(/out of range/);
	});

	it("threads host-owned named registers across applyEdits calls", () => {
		const clipboard: Clipboard = {};
		const cut = parsePatch("CUT 1 @r").edits;
		const paste = parsePatch("PUT >$ @r").edits;
		expect(applyEdits("a\nb", cut, { clipboard }).text).toBe("b");
		expect(applyEdits("x\ny", paste, { clipboard }).text).toBe("x\ny\na");
	});
});

describe("clipboard block ops", () => {
	it("expands CUT N* to a span capture plus per-line deletes", () => {
		const edits = parsePatch("CUT 2*\nPUT >$").edits;
		const resolved = resolveBlockEdits(edits, "l1\nl2\nl3\nl4", PATH, stubResolver);
		expect(resolved.map(edit => edit.kind)).toEqual(["cut", "delete", "delete", "paste"]);
		expect(resolved[0]).toMatchObject({ kind: "cut", range: { start: { line: 2 }, end: { line: 3 } } });
	});

	it("moves a block after another block via PUT >N*", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 1*\nPUT >3*`);
		// stub blocks: [1,2] and [3,4].
		expect(section.applyTo("a1\na2\nb1\nb2\nrest", stubResolver).text).toBe("b1\nb2\na1\na2\nrest");
	});

	it("echoes clipboard block resolutions with their op", () => {
		const seen: string[] = [];
		resolveBlockEdits(parsePatch("CUT 2*\nPUT >$").edits, "l1\nl2\nl3", PATH, stubResolver, {
			onResolved: resolution => seen.push(resolution.op),
		});
		expect(seen).toEqual(["cut"]);
	});

	it("rejects a single-line CUT N* resolution with the plain-op retry", () => {
		const single: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line });
		const edits = parsePatch("CUT 2*\nPUT >$").edits;
		expect(() => resolveBlockEdits(edits, "a\nb\nc", PATH, single)).toThrow(/use `CUT 2`/);
	});

	it("lowers an unresolvable PUT >N* to a plain paste with a warning", () => {
		const warnings: string[] = [];
		const resolved = resolveBlockEdits(parsePatch("CUT 1\nPUT >2*").edits, "a\nb\nc", PATH, () => null, {
			onWarning: warning => warnings.push(warning),
		});
		expect(resolved.map(edit => edit.kind)).toEqual(["cut", "delete", "paste"]);
		expect(warnings.some(warning => warning.includes("`PUT >2*`"))).toBe(true);
	});
});

describe("clipboard across sections and batches", () => {
	it("moves lines between files within one patch", async () => {
		const a = "keep\nmove1\nmove2\n";
		const b = "b1\n";
		const { fs, patcher, tags } = taggedPatcher([
			["a.ts", a],
			["b.ts", b],
		]);

		const input = [`[a.ts#${tags.get("a.ts")}]`, "CUT 2-3", `[b.ts#${tags.get("b.ts")}]`, "PUT >$"].join("\n");

		const patch = Patch.parse(input);
		await patcher.apply(patch);

		expect(await fs.readText("a.ts")).toBe("keep\n");
		expect(await fs.readText("b.ts")).toBe("b1\nmove1\nmove2\n");
	});
});
