import { describe, expect, it } from "bun:test";
import {
	type BlockResolution,
	type BlockResolver,
	type BlockSpan,
	computeFileHash,
	type Edit,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
	parsePatch,
	resolveBlockEdits,
} from "@oh-my-pi/hashline";

const PATH = "x.ts";

// Deterministic stub: the block beginning on line N spans [N, N+1]. The exact
// shape does not matter — the unit tests only need a resolver that is not the
// real tree-sitter native (that is exercised by the coding-agent integration
// test).
const stubResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });

/** Strip parser/transform bookkeeping that `applyEdits` re-derives anyway. */
function normalizeEdits(edits: readonly Edit[]): unknown[] {
	return edits.map(edit => {
		if (edit.kind === "insert") return { kind: edit.kind, cursor: edit.cursor, text: edit.text, mode: edit.mode };
		if (edit.kind === "delete") return { kind: edit.kind, anchor: edit.anchor };
		return edit;
	});
}

describe("PUT N*: parsing", () => {
	it("parses `PUT N*: N:` into a single deferred block edit", () => {
		const { edits } = parsePatch("PUT 2*:\n+A\n+B");

		expect(edits).toHaveLength(1);
		const edit = edits[0];
		expect(edit?.kind).toBe("block");
		if (edit?.kind !== "block") throw new Error("expected a block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual(["A", "B"]);
	});

	it("still parses a literal `SWAP N.=M:` range (distinct from `PUT N*:`)", () => {
		const { edits } = parsePatch("PUT 2-3:\n+A");
		expect(edits.some(edit => edit.kind === "block")).toBe(false);
		expect(edits.some(edit => edit.kind === "delete")).toBe(true);
	});

	it("treats a `PUT N*:` hunk with no body row as a delete-only block edit", () => {
		const result = parsePatch("PUT 2*:");
		expect(result.edits).toEqual([{ kind: "block", anchor: { line: 2 }, payloads: [], lineNum: 1, index: 0 }]);
		expect(result.warnings.some(w => /empty `PUT` body as deletion/.test(w))).toBe(true);
	});
});

describe("resolveBlockEdits", () => {
	it("expands a block edit exactly like the equivalent `SWAP start.=end:`", () => {
		const blockEdits = parsePatch("PUT 2*:\n+A\n+B").edits;
		const resolved = resolveBlockEdits(blockEdits, "ignored", PATH, stubResolver);
		const replaceEdits = parsePatch("PUT 2-3:\n+A\n+B").edits;

		expect(resolved.some(edit => edit.kind === "block")).toBe(false);
		expect(normalizeEdits(resolved)).toEqual(normalizeEdits(replaceEdits));
	});

	it("returns the input untouched when there are no block edits (fast path)", () => {
		const edits = parsePatch("PUT 1-1:\n+X").edits;
		expect(resolveBlockEdits(edits, "ignored", PATH, stubResolver)).toBe(edits);
	});

	it("throws (default) when no resolver is wired", () => {
		const edits = parsePatch("PUT 2*:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "ignored", PATH, undefined)).toThrow("not available here");
	});

	it("drops an unresolvable block edit in `drop` mode", () => {
		const edits = parsePatch("PUT 2*:\n+X").edits;
		const resolved = resolveBlockEdits(edits, "ignored", PATH, () => null, { onUnresolved: "drop" });
		expect(resolved).toHaveLength(0);
	});

	it("throws a block-unresolved error in `throw` mode when the resolver returns null", () => {
		const edits = parsePatch("PUT 7*:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "ignored", PATH, () => null)).toThrow(
			"could not resolve a syntactic block beginning on line 7",
		);
	});

	it("includes a nearby-context preview in the block-unresolved error", () => {
		const edits = parsePatch("PUT 3*:\n+X").edits;
		const text = "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot";
		let error: Error | undefined;
		try {
			resolveBlockEdits(edits, text, PATH, () => null);
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("could not resolve a syntactic block beginning on line 3");
		// ±2 lines of context around the anchor, anchor `*`-marked.
		expect(error?.message).toContain(" 1:alpha");
		expect(error?.message).toContain("*3:charlie");
		expect(error?.message).toContain(" 5:echo");
		expect(error?.message).not.toContain("foxtrot");
	});

	it("suggests the next multi-line opener for a blank anchor without applying it", () => {
		const text = "alpha\n\nfunction x() {\n  return 1;\n}";
		const resolver: BlockResolver = ({ line }) => (line === 3 ? { start: 3, end: 5 } : null);
		const edits = parsePatch("PUT 2*:\n+function y() {}").edits;

		expect(() => resolveBlockEdits(edits, text, PATH, resolver)).toThrow(
			"Line 2 is blank; no syntactic block can begin there. The next multi-line block begins at line 3 and ends at line 5. Retry `PUT 3*:`.",
		);
	});

	it("suggests both the exact statement range and nearest enclosing block", () => {
		const text = "function x() {\n  run();\n}";
		const resolver: BlockResolver = ({ line }) => {
			if (line === 2) return { start: 2, end: 2 };
			if (line === 1) return { start: 1, end: 3 };
			return null;
		};
		const edits = parsePatch("PUT 2*:\n+  stop();").edits;

		expect(() => resolveBlockEdits(edits, text, PATH, resolver)).toThrow(
			"For only this statement use `PUT 2:`. The nearest enclosing multi-line block begins at line 1 and ends at line 3; use `PUT 1*:` to target it.",
		);
	});

	it("omits the context preview when the anchor line is out of range", () => {
		const edits = parsePatch("PUT 9*:\n+X").edits;
		let error: Error | undefined;
		try {
			resolveBlockEdits(edits, "only\ntwo", PATH, () => null);
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message).toContain("could not resolve a syntactic block beginning on line 9");
		expect(error?.message).not.toContain("\n\n");
	});

	it("fires onResolved with the resolved span for replace and cut blocks", () => {
		const seen: BlockResolution[] = [];
		// stubResolver maps line N → span [N, N+1].
		resolveBlockEdits(parsePatch("PUT 2*:\n+A\n+B").edits, "ignored", PATH, stubResolver, {
			onResolved: resolution => seen.push(resolution),
		});
		resolveBlockEdits(parsePatch("CUT 5*").edits, "ignored", PATH, stubResolver, {
			onResolved: resolution => seen.push(resolution),
		});

		expect(seen).toEqual([
			{ anchorLine: 2, start: 2, end: 3, op: "replace" },
			{ anchorLine: 5, start: 5, end: 6, op: "cut" },
		]);
	});

	it("does not fire onResolved for a dropped unresolvable block", () => {
		const seen: BlockResolution[] = [];
		resolveBlockEdits(parsePatch("PUT 2*:\n+X").edits, "ignored", PATH, () => null, {
			onUnresolved: "drop",
			onResolved: resolution => seen.push(resolution),
		});
		expect(seen).toHaveLength(0);
	});

	// A single-line resolution means the anchor was a bare statement, not a
	// multi-line construct opener (the att#1 `insert_after_block 678` shape,
	// where line 678 was `options.mode = "check";`). Reject and point at the
	// plain form rather than silently landing a body in the wrong scope.
	const singleLineResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line });

	it("rejects a `PUT N*:` that resolves to a single line", () => {
		const edits = parsePatch("PUT 2*:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver)).toThrow(
			"For only this statement use `PUT 2:`.",
		);
	});

	it("rejects an `PUT >N*:` that resolves to a single line", () => {
		const edits = parsePatch("PUT >2*:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver)).toThrow(/single-line block/);
	});

	it("drops a single-line block resolution on the lenient preview path", () => {
		const edits = parsePatch("PUT 2*:\n+X").edits;
		const resolved = resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver, { onUnresolved: "drop" });
		expect(resolved).toHaveLength(0);
	});
});

describe("PatchSection.applyTo / applyPartialTo with block edits", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applyTo resolves a block edit and matches the equivalent `replace`", () => {
		const blockSection = Patch.parseSingle(`[${PATH}#1A2B]\nPUT 2*:\n+  if (y || z) {\n+  }`);
		const replaceSection = Patch.parseSingle(`[${PATH}#1A2B]\nPUT 2-3:\n+  if (y || z) {\n+  }`);

		const blockResult = blockSection.applyTo(text, stubResolver);
		const replaceResult = replaceSection.applyTo(text);

		expect(blockResult.text).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
		expect(blockResult.text).toBe(replaceResult.text);
	});

	it("applyTo throws when a block edit has no resolver", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT 2*:\n+X`);
		expect(() => section.applyTo(text)).toThrow("no block resolver configured");
	});

	it("applyPartialTo drops an unresolvable block edit instead of throwing", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT 2*:\n+X`);
		// No resolver → drop. The lone block edit vanishes, so the text is unchanged.
		const result = section.applyPartialTo(text);
		expect(result.text).toBe(text);
	});
});

describe("Patcher with a block resolver", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applies a block edit on the hash-match path", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2*:\n+  if (y || z) {\n+  }`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
	});

	it("surfaces the resolved span on the section result (hash-match path)", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2*:\n+  if (y || z) {\n+  }`));

		expect(result.sections[0]?.blockResolutions).toEqual([{ anchorLine: 2, start: 2, end: 3, op: "replace" }]);
	});

	it("enriches reversed absolute ranges with the resolved block endpoint without writing", async () => {
		const source = Array.from({ length: 255 }, (_, index) => `line ${index + 1}`).join("\n");
		const fs = new InMemoryFilesystem([[PATH, source]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, source);
		const resolver: BlockResolver = ({ line }) => (line === 195 ? { start: 195, end: 255 } : null);
		const patcher = new Patcher({ fs, snapshots, blockResolver: resolver });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 195-61:\n+replacement`))).rejects.toThrow(
			"Invalid absolute range: start 195, end 61. The value after `.=` is an absolute source line, not a line count or replacement length. For one line use `PUT 195:`. For 61 lines starting at 195, use `PUT 195.=255:`. The syntactic block beginning at 195 ends at 255, so `PUT 195*:` is also valid.",
		);
		expect(fs.get(PATH)).toBe(source);
	});

	it("resolves against the tagged snapshot and recovers onto drifted content", async () => {
		const snapshotText = "line0\nline1\nline2\nline3\nline4\n";
		// The live file gained a trailing line after the read minted the tag.
		const liveText = "line0\nline1\nline2\nline3\nline4\nline5\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, snapshotText);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		// `block 2` resolves against the SNAPSHOT → span [2,3] → replace
		// "line1","line2"; recovery maps that unchanged span onto the live file.
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2*:\n+NEW`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("line0\nNEW\nline3\nline4\nline5\n");
		expect(result.sections[0]?.warnings.some(w => /Recovered/.test(w))).toBe(true);
		// Drift routed the resolution through recovery, where line numbers shift,
		// so the (now-misleading) span is intentionally not surfaced.
		expect(result.sections[0]?.blockResolutions).toBeUndefined();
	});

	it("rejects a block edit whose tag was never recorded for this path", async () => {
		const liveText = "line0\nline1\nline2\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const live = computeFileHash(liveText);
		const bogus = live === "FFFF" ? "0000" : "FFFF";
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${bogus}]\nPUT 2*:\n+NEW`))).rejects.toBeInstanceOf(
			MismatchError,
		);
		expect(fs.get(PATH)).toBe(liveText);
	});

	it("throws a block-unresolved error when the resolver returns null", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: () => null });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2*:\n+X`))).rejects.toThrow(
			"could not resolve a syntactic block",
		);
		expect(fs.get(PATH)).toBe(text);
	});
});

describe("CUT N*", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("parses `CUT N* N` into a cut block edit", () => {
		const { edits } = parsePatch("CUT 2*");

		expect(edits).toHaveLength(1);
		const edit = edits[0];
		expect(edit?.kind).toBe("block");
		if (edit?.kind !== "block") throw new Error("expected a block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual([]);
		expect(edit.mode).toBe("cut");
	});

	it("rejects body rows under `CUT N* N`", () => {
		expect(() => parsePatch("CUT 2*\n+X")).toThrow("`CUT` deletes (and captures) the named lines");
	});

	it("resolveBlockEdits expands a cut block into capture and deletes", () => {
		const resolved = resolveBlockEdits(parsePatch("CUT 2*").edits, "ignored", PATH, stubResolver);

		expect(resolved.map(edit => edit.kind)).toEqual(["cut", "delete", "delete"]);
		expect(resolved.flatMap(edit => (edit.kind === "delete" ? [edit.anchor.line] : []))).toEqual([2, 3]);
	});

	it("applyTo deletes the resolved block span", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 2*`);
		// stub span [2,3] → drop "  if (y) {" and "  }".
		expect(section.applyTo(text, stubResolver).text).toBe("function x() {\n}\n");
	});

	it("applyPartialTo drops an unresolvable cut-block edit", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nCUT 2*`);
		expect(section.applyPartialTo(text).text).toBe(text);
	});

	it("Patcher applies a cut-block edit on the hash-match path", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nCUT 2*`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n}\n");
	});
});

describe("PUT >N*:", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("parses `PUT >N*: N:` into a deferred block edit with insert mode", () => {
		const { edits } = parsePatch("PUT >2*:\n+A\n+B");

		expect(edits).toHaveLength(1);
		const edit = edits[0];
		expect(edit?.kind).toBe("block");
		if (edit?.kind !== "block") throw new Error("expected a block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual(["A", "B"]);
		expect(edit.mode).toBe("insert_after");
	});

	it("still parses a literal `PUT > N:` anchor (distinct from `PUT >N*:`)", () => {
		const { edits } = parsePatch("PUT >2:\n+A");
		expect(edits.some(edit => edit.kind === "block")).toBe(false);
	});

	it("rejects an `PUT >N*: N:` hunk with no body row", () => {
		expect(() => parsePatch("PUT >2*:")).toThrow("promises body rows");
	});

	it("resolveBlockEdits expands to the equivalent `insert after end:` lowering", () => {
		const blockEdits = parsePatch("PUT >2*:\n+A\n+B").edits;
		// stub span [2,3] → after_anchor inserts at line 3.
		const resolved = resolveBlockEdits(blockEdits, "ignored", PATH, stubResolver);
		const insertEdits = parsePatch("PUT >3:\n+A\n+B").edits;

		expect(resolved.some(edit => edit.kind === "block")).toBe(false);
		expect(normalizeEdits(resolved)).toEqual(normalizeEdits(insertEdits));
	});

	it("fires onResolved with op insert_after", () => {
		const seen: BlockResolution[] = [];
		resolveBlockEdits(parsePatch("PUT >2*:\n+A").edits, "ignored", PATH, stubResolver, {
			onResolved: resolution => seen.push(resolution),
		});
		expect(seen).toEqual([{ anchorLine: 2, start: 2, end: 3, op: "insert_after" }]);
	});

	it("lowers an unresolvable anchor to plain `PUT > N:` with a warning", () => {
		const edits = parsePatch("PUT >7*:\n+X").edits;
		const warnings: string[] = [];

		const resolved = resolveBlockEdits(edits, "ignored", PATH, () => null, {
			onWarning: warning => warnings.push(warning),
		});

		expect(normalizeEdits(resolved)).toEqual(normalizeEdits(parsePatch("PUT >7:\n+X").edits));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("applied as plain `PUT >7:`");
	});

	it("lowers `PUT >N*:` even when no resolver is wired", () => {
		const edits = parsePatch("PUT >2*:\n+X").edits;
		const warnings: string[] = [];

		const resolved = resolveBlockEdits(edits, "ignored", PATH, undefined, {
			onWarning: warning => warnings.push(warning),
		});

		expect(normalizeEdits(resolved)).toEqual(normalizeEdits(parsePatch("PUT >2:\n+X").edits));
		expect(warnings).toHaveLength(1);
	});

	it("lowers a closing-delimiter anchor to plain `PUT > N:` with a warning", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT >3*:\n+  done();`);
		const resolver: BlockResolver = ({ line }) => (line === 2 ? { start: 2, end: 3 } : null);

		const result = section.applyTo(text, resolver);

		// line 3 is `  }` — no block begins there, but it ends one; the body
		// lands after it, exactly where `insert_after_block` would have put it.
		expect(result.text).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expect(result.warnings?.some(w => /applied as plain `PUT >3:`/.test(w))).toBe(true);
	});

	it("lowers an unresolvable blank-line anchor to plain `PUT > N:` instead of failing", () => {
		const blankAnchored = Patch.parseSingle(`[notes.md#1A2B]\nPUT >2*:\n+- new entry`);

		const result = blankAnchored.applyTo("### Changed\n\n- old entry\n", () => null);

		expect(result.text).toBe("### Changed\n\n- new entry\n- old entry\n");
		expect(
			result.warnings?.some(w => /could not resolve a syntactic block.*applied as plain `PUT >2:`/.test(w)),
		).toBe(true);
	});

	it("Patcher surfaces the closer-anchor lowering warning", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const resolver: BlockResolver = ({ line }) => (line === 2 ? { start: 2, end: 3 } : null);
		const patcher = new Patcher({ fs, snapshots, blockResolver: resolver });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT >3*:\n+  done();`));

		expect(fs.get(PATH)).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expect(result.sections[0]?.warnings.some(w => /applied as plain `PUT >3:`/.test(w))).toBe(true);
	});

	it("applyTo inserts the body after the resolved block's last line", () => {
		const section = Patch.parseSingle(`[${PATH}#1A2B]\nPUT >2*:\n+  done();`);
		// stub span [2,3] → body lands after "  }" (line 3), before the final "}".
		expect(section.applyTo(text, stubResolver).text).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
	});

	it("Patcher applies an insert-after-block edit and surfaces the resolution", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT >2*:\n+  done();`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n  if (y) {\n  }\n  done();\n}\n");
		expect(result.sections[0]?.blockResolutions).toEqual([{ anchorLine: 2, start: 2, end: 3, op: "insert_after" }]);
	});
});
