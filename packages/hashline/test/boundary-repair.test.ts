import { describe, expect, it } from "bun:test";
import { applyEdits, InMemorySnapshotStore, parsePatch, Recovery } from "@oh-my-pi/hashline";

/**
 * Applies with a code path, so the tree-sitter probe can judge whether an
 * authored range boundary broke the file — the shape every production call
 * site (patcher, recovery, section apply, preview) supplies.
 */
function apply(text: string, diff: string): { text: string; warnings: string[] } {
	const result = applyEdits(text, parsePatch(diff).edits, { path: "fixture.ts" });
	return { text: result.text, warnings: result.warnings ?? [] };
}

/** Applies JSX/TSX fixtures with the parser production `.tsx` files use. */
function applyTsx(text: string, diff: string): { text: string; warnings: string[] } {
	const result = applyEdits(text, parsePatch(diff).edits, { path: "fixture.tsx" });
	return { text: result.text, warnings: result.warnings ?? [] };
}

/** Applies with a Rust path, for Rust-shaped fixtures. */
function applyRust(text: string, diff: string): { text: string; warnings: string[] } {
	const result = applyEdits(text, parsePatch(diff).edits, { path: "fixture.rs" });
	return { text: result.text, warnings: result.warnings ?? [] };
}

/** Applies with a Markdown path: braces there are prose, not syntax. */
function applyProse(text: string, diff: string): { text: string; warnings: string[] } {
	const result = applyEdits(text, parsePatch(diff).edits, { path: "fixture.md" });
	return { text: result.text, warnings: result.warnings ?? [] };
}

function boundaryRepairWarnings(warnings: readonly string[]): string[] {
	return warnings.filter(warning => /Auto-repaired (?:a )?replacement boundar/.test(warning));
}

describe("boundary-balance repair", () => {
	it("restores a uniformly omitted base indent from unchanged structural rows", () => {
		const file = [
			"    if (value > 90) {",
			"      result = error;",
			"    } else if (value > 70) {",
			"      result = plain;",
			"    } else {",
			"      result = warning;",
			"    }",
		].join("\n");
		const diff = [
			"PUT 2.=6:",
			"+  result = error;",
			"+} else if (value > 70) {",
			"+  result = warning;",
			"+} else {",
			"+  result = plain;",
		].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			[
				"    if (value > 90) {",
				"      result = error;",
				"    } else if (value > 70) {",
				"      result = warning;",
				"    } else {",
				"      result = plain;",
				"    }",
			].join("\n"),
		);
		expect(warnings.some(w => /Auto-indented a replacement body/.test(w))).toBe(true);
	});
	it("preserves intentional indentation-only replacements", () => {
		const file = ["    first();", "    second();"].join("\n");
		const { text, warnings } = apply(file, "PUT 1.=2:\n+first();\n+second();");
		expect(text).toBe("first();\nsecond();");
		expect(warnings.some(w => /Auto-indented a replacement body/.test(w))).toBe(false);
	});

	it("retains a swallowed opening comment fence when syntax and indentation prove the boundary", () => {
		const file = ["class C {", "\t/**", "\t * Old summary.", "\t */", "\tmethod() {}", "}"].join("\n");
		const diff = ["PUT 2-4:", "+\t * New summary.", "+\t */"].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["class C {", "\t/**", "\t * New summary.", "\t */", "\tmethod() {}", "}"].join("\n"));
		expect(warnings).toEqual([expect.stringContaining("Auto-repaired replacement boundaries")]);
	});

	// The canonical incident: a range-replace whose payload restates the
	// fragment + paren close that still live just below the range, doubling
	// `</>` and `);`. `replace 11.=31:` covers `const …` through the second `/>`.
	it("drops a duplicated multi-line closing block (the Root.tsx incident)", () => {
		const file = [
			'import type React from "react";',
			'import { Composition } from "remotion";',
			'import { Sizzle, type SizzleProps } from "./compositions/Sizzle";',
			'import { FPS, totalDurationInFrames } from "./lib/scenes";',
			"",
			"export const RemotionRoot: React.FC = () => {",
			"\tconst durationInFrames = totalDurationInFrames();",
			"\treturn (",
			"\t\t<>",
			"\t\t\t<Composition",
			'\t\t\t\tid="Sizzle"',
			"\t\t\t\tcomponent={Sizzle}",
			"\t\t\t\tdurationInFrames={durationInFrames}",
			"\t\t\t\twidth={1920}",
			'\t\t\t\tdefaultProps={{ layout: "landscape" }}',
			"\t\t\t/>",
			"\t\t</>",
			"\t);",
			"};",
		].join("\n");
		// Range 7..16 = `const …` through the first `/>`; payload restates the
		// `</>` + `);` that survive at lines 17-18.
		const diff = [
			"PUT 7-16:",
			"+\treturn (",
			"+\t\t<>",
			"+\t\t\t<Composition",
			'+\t\t\t\tid="Sizzle"',
			"+\t\t\t\tcomponent={Sizzle}",
			"+\t\t\t\tdurationInFrames={durationInFrames}",
			"+\t\t\t\twidth={1920}",
			'+\t\t\t\tdefaultProps={{ layout: "landscape" } satisfies SizzleProps}',
			"+\t\t\t/>",
			"+\t\t</>",
			"+\t);",
		].join("\n");
		const { text, warnings } = applyTsx(file, diff);
		// Exactly one `</>` and one `);` survive — no doubling.
		expect(text.split("\n").filter(l => l.trim() === "</>")).toHaveLength(1);
		expect(text.split("\n").filter(l => l.trim() === ");")).toHaveLength(1);
		expect(text.endsWith("\t\t</>\n\t);\n};")).toBe(true);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Single structural-closer duplication: the range ends one line short and
	// the payload restates the `});` that survives just below it.
	it("drops a single duplicated structural closer (`});`)", () => {
		const file = ["it('a', () => {", "\tsetup();", "\trun();", "});", "after();"].join("\n");
		// `replace 2.=3:` replaces the two body lines but the payload also restates the
		// `});` at line 4, which survives — a duplicate close.
		const diff = ["PUT 2-3:", "+\tsetup2();", "+\trun2();", "+});"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["it('a', () => {", "\tsetup2();", "\trun2();", "});", "after();"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Single structural-opener duplication: the range starts one line late and
	// the payload restates the method-signature opener that survives just above
	// it (the tui.ts `#planRender(` incident).
	it("drops a single duplicated structural opener (`planRender(`)", () => {
		const file = [
			"class Foo {",
			"\t/** doc */",
			"\tplanRender(",
			"\t\ta: string[],",
			"\t\tb: boolean,",
			"\t): Intent {",
			"\t\treturn x;",
			"\t}",
			"}",
		].join("\n");
		// `replace 4.=6:` covers the params + return-type line, but the payload also
		// restates the `planRender(` at line 3, which survives — a duplicate open.
		const diff = [
			"PUT 4-6:",
			"+\tplanRender(",
			"+\t\ta: string[],",
			"+\t\tb: boolean,",
			"+\t\tc: number,",
			"+\t): Intent {",
		].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			[
				"class Foo {",
				"\t/** doc */",
				"\tplanRender(",
				"\t\ta: string[],",
				"\t\tb: boolean,",
				"\t\tc: number,",
				"\t): Intent {",
				"\t\treturn x;",
				"\t}",
				"}",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line === "\tplanRender(")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// A duplicated opener whose imbalance does NOT explain the delta is left alone.
	it("preserves a duplicated opener when it does not account for the imbalance", () => {
		const file = ["if (a) {", "\tfoo();", "}", "bar();"].join("\n");
		// Payload duplicates `if (a) {` but is net +2 braces; dropping the one
		// opener cannot zero the delta, so nothing is repaired — the result is
		// applied as written and the breakage is reported, not rewritten.
		const diff = ["PUT 2-2:", "+if (a) {", "+\tif (b) {", "+\t\tfoo();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["if (a) {", "if (a) {", "\tif (b) {", "\t\tfoo();", "}", "bar();"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
		expect(warnings).toEqual([expect.stringContaining("introduced a syntax error")]);
	});

	// Genuine missing-closer: payload omits the trailing `});`.
	it("spares the deleted closing line when the payload omits it", () => {
		const file = ["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "};"].join("\n");
		// `replace 5.=5:` is the final `};`. Model inserts a new method but forgets to
		// restate `};`; sparing it keeps the object literal balanced.
		const diff = ["PUT 5-5:", "+\tb() {", "+\t\treturn 2;", "+\t},"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "\tb() {", "\t\treturn 2;", "\t},", "};"].join(
				"\n",
			),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// If the selected range is already imbalanced internally, a payload that
	// restates the range's final closer must not trigger "missing closer" repair;
	// keeping the deleted suffix would duplicate the closer outside the payload.
	it("does not spare a deleted closing line that the payload already restates", () => {
		const file = ["class Foo {", "\tok();", "\t}", "}"].join("\n");
		const diff = ["PUT 1-4:", "+class Foo {", "+\tok();", "+}"].join("\n");
		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["class Foo {", "\tok();", "}"].join("\n"));
		expect(text.split("\n").filter(line => line === "}")).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});

	it("drops duplicated leading and trailing boundary lines around a range replacement", () => {
		const file = [
			"func _cmd_travel_homeworld():",
			"\tvar destination = get_homeworld()",
			"\ttravel_to(destination)",
			"\tprint_status()",
		].join("\n");
		const diff = [
			"PUT 2-3:",
			"+func _cmd_travel_homeworld():",
			"+\tvar destination = find_homeworld()",
			"+\ttravel_to(destination)",
			"+\tprint_status()",
		].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(
			[
				"func _cmd_travel_homeworld():",
				"\tvar destination = find_homeworld()",
				"\ttravel_to(destination)",
				"\tprint_status()",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line === "func _cmd_travel_homeworld():")).toHaveLength(1);
		expect(text.split("\n").filter(line => line === "\tprint_status()")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("preserves payloads where multi-line boundary echoes cover every line", () => {
		const file = ["A", "B", "old", "C", "D"].join("\n");
		const diff = ["PUT 3-3:", "+A", "+B", "+C", "+D"].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["A", "B", "A", "B", "C", "D", "C", "D"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	it("preserves payloads made only of lines matching both replacement neighbors", () => {
		const file = ["a", "old", "c"].join("\n");
		const diff = ["PUT 2-2:", "+a", "+c"].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["a", "a", "c", "c"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// An echo whose dropped edges shift delimiter balance without explaining a
	// payload/range delta is intentional structural content, not a boundary
	// mistake: stripping the edges would corrupt the brace structure.
	it("preserves balance-shifting boundary echoes that do not explain the delta", () => {
		const file = ["}", "old();", "}"].join("\n");
		// Payload deliberately opens with the same bare `}` that sits above the
		// range and closes with the same `}` that sits below it; the payload is
		// internally balanced (delta 0) while the dropped edges sum to -2 braces.
		const diff = ["PUT 2-2:", "+}", "+if (a) {", "+if (b) {", "+x();", "+}"].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["}", "}", "if (a) {", "if (b) {", "x();", "}", "}"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// The common wrapper-echo mistake stays repaired: balance-neutral edges
	// (opener + closer) that duplicate the surviving neighbors are dropped.
	it("still drops a balance-neutral wrapper echo", () => {
		const file = ["function f() {", "old();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+function f() {", "+fresh();", "+}"].join("\n");

		const { text, warnings } = apply(file, diff);

		expect(text).toBe(["function f() {", "fresh();", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Balance-preserving edits are never touched, even when the payload's last
	// line coincidentally equals the line just below the range.
	it("leaves a balance-preserving replacement alone (no false positive)", () => {
		const file = ["foo();", "bar();", "bar();", "baz();"].join("\n");
		// Replace line 2 with two balanced statements; the tail `bar();` equals
		// the surviving line 3 but the payload is balanced — must NOT be dropped.
		const diff = ["PUT 2-2:", "+qux();", "+bar();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["foo();", "qux();", "bar();", "bar();", "baz();"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// A duplicated full statement (balance-neutral) is left intact: dropping it
	// could discard intended content, and it does not break syntax.
	it("does not drop a balance-neutral duplicated statement", () => {
		const file = ["a = 1;", "b = 2;", "c = 3;"].join("\n");
		const diff = ["PUT 1-1:", "+a = 1;", "+b = 2;"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["a = 1;", "b = 2;", "b = 2;", "c = 3;"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// Brackets inside strings must not trigger a spurious balance mismatch.
	it("ignores brackets inside string literals", () => {
		const file = ['const a = "}";', 'const b = "x";', 'const c = "y";'].join("\n");
		const diff = ["PUT 2-2:", '+const b = "}}}";'].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(['const a = "}";', 'const b = "}}}";', 'const c = "y";'].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// A MULTI-line construct rewrite whose payload restates the keeper that
	// survives just below the range — the att#1 `replace 639.=644` shape where
	// the range was one line short of the `const changedFiles` it retyped.
	it("drops a one-sided trailing keeper echo in a multi-line rewrite", () => {
		const file = ["function f() {", "  a();", "  b();", "  const out = [];", "  return out;", "}"].join("\n");
		const diff = ["PUT 2-3:", "+  a2();", "+  b2();", "+  const out = [];"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["function f() {", "  a2();", "  b2();", "  const out = [];", "  return out;", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("drops a one-sided JSX closer echo in a single-line expansion", () => {
		const file = ["const view = (", "  <section>", "    <Old />", "  </section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+    <New />", "+  </section>"].join("\n");
		const { text, warnings } = applyTsx(file, diff);

		expect(text).toBe(["const view = (", "  <section>", "    <New />", "  </section>", ");"].join("\n"));
		expect(text.split("\n").filter(line => line === "  </section>")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("drops a JSX closer echo after a self-closing tag with a greater-than prop expression", () => {
		const file = ["const view = (", "<Foo>", "old text", "</Foo>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<Foo value={a > b} />", "+</Foo>"].join("\n");
		const { text, warnings } = applyTsx(file, diff);

		expect(text).toBe(["const view = (", "<Foo>", "<Foo value={a > b} />", "</Foo>", ");"].join("\n"));
		expect(text.split("\n").filter(line => line === "</Foo>")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("preserves a nested JSX closer that matches the surviving parent closer", () => {
		const file = ["const view = (", '<section className="outer">', "old text", "</section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<section>", "+new text", "+</section>"].join("\n");
		const { text, warnings } = applyTsx(file, diff);

		expect(text).toBe(
			[
				"const view = (",
				'<section className="outer">',
				"<section>",
				"new text",
				"</section>",
				"</section>",
				");",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line.trim() === "</section>")).toHaveLength(2);
		expect(warnings).toHaveLength(0);
	});

	it("preserves a nested JSX closer when the opener spans payload lines", () => {
		const file = ["const view = (", '<section className="outer">', "old text", "</section>", ");"].join("\n");
		const diff = ["PUT 3-3:", "+<section", '+  className="inner"', "+>", "+new text", "+</section>"].join("\n");
		const { text, warnings } = applyTsx(file, diff);

		expect(text).toBe(
			[
				"const view = (",
				'<section className="outer">',
				"<section",
				'  className="inner"',
				">",
				"new text",
				"</section>",
				"</section>",
				");",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line.trim() === "</section>")).toHaveLength(2);
		expect(warnings).toHaveLength(0);
	});

	// Mirror direction: the payload restates the keeper that survives just above
	// the multi-line range (range one line low instead of one short).
	it("drops a one-sided leading keeper echo in a multi-line rewrite", () => {
		const file = ["setup();", "a();", "b();", "c();"].join("\n");
		const diff = ["PUT 3-4:", "+a();", "+B();", "+C();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["setup();", "a();", "B();", "C();"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});
	// A one-sided echo whose payload cannot fill the widened range is rejected,
	// not repaired: dropping the echo would silently delete the range's far
	// boundary line (here the `return threadError(...)`), leaving a dangling
	// `if`. The PyThreadRuntime incident: SWAP 654.=655 restating line 653.
	it("rejects a leading keeper echo when the payload cannot fill the widened range", () => {
		const file = [
			"{",
			"    auto* handle = payloadFor<PyThreadHandle>(self);",
			"    if (!handle)",
			'        return threadError(globalObject, "thread not started");',
			"    handle.setDone();",
			"}",
		].join("\n");
		const diff = [
			"PUT 3-4:",
			"+    auto* handle = payloadFor<PyThreadHandle>(self);",
			"+    if (!handle || !handle.isStarted())",
		].join("\n");
		expect(() => apply(file, diff)).toThrow(/rejected: the body opens by restating/);
	});

	// Mirror direction: trailing echo, payload one line short of the widened
	// range — repairing would delete `c();` even though the payload never
	// mentions it.
	it("rejects a trailing keeper echo when the payload cannot fill the widened range", () => {
		const file = ["a();", "b();", "c();", "keep();"].join("\n");
		const diff = ["PUT 2-3:", "+B();", "+keep();"].join("\n");
		expect(() => apply(file, diff)).toThrow(/rejected: the body ends by restating/);
	});

	// A statement swapped onto a lone closer at the closer's own depth claims
	// no position inside the block: sparing the closer would land the payload
	// after `return;` as dead code. The PyThreadRuntime setIdent incident:
	// SWAP 718.=718 on the `}` of an early-return block.
	it("rejects sparing a deleted closer when the payload claims no position inside the block", () => {
		const file = [
			"        if (!global) {",
			"            handle.setDone();",
			"            return;",
			"        }",
			"        handle.setIdent(currentIdent());",
		].join("\n");
		const diff = ["PUT 4-4:", "+        after();"].join("\n");
		expect(() => apply(file, diff)).toThrow(/selected boundary row is required/);
	});

	// Contrast with the rejection above: a payload indented deeper than the
	// spared closer claims the inside of the block, so the spare still fires.
	it("still spares a closer when the payload indentation claims the block interior", () => {
		const file = ["if (!global) {", "    setDone();", "    return;", "}", "after();"].join("\n");
		const diff = ["PUT 4-4:", "+    setIdent();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			["if (!global) {", "    setDone();", "    return;", "    setIdent();", "}", "after();"].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});
	// #3142: the range's deleted `}` is matched by an opener another hunk deletes
	// (`CUT 1`). The patch nets to balanced, so the closer must stay deleted —
	// the per-group repair wrongly kept it, leaving a stray `}`.
	it("does not keep a deleted closer when another hunk removes its opener (#3142)", () => {
		const file = ["if enabled {", '\tText("Old")', "}", '\tText("Tail")'].join("\n");
		const diff = ["CUT 1", "PUT 2-3:", '+Text("New")'].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(['Text("New")', '\tText("Tail")'].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
	});

	// A wrapper removal and a genuine missing closer in the same patch: the
	// residual must be spent on the genuine hunk, not the wrapper-removed one.
	it("spends the missing-closer residual on the genuine hunk, not an earlier wrapper removal", () => {
		const file = ["if enabled {", '\tText("Old")', "}", "const config = {", "\ta: 1,", "};"].join("\n");
		const diff = ["CUT 1", "PUT 2-3:", '+Text("New")', "PUT 6-6:", "+\tb: 2,"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(['Text("New")', "const config = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// A replaced opener (not removed) leaves a genuine missing closer downstream:
	// the net deleted-prefix balance is zero, so the closer is correctly kept.
	it("keeps the closer when the matching opener is replaced rather than removed", () => {
		const file = ["if (a) {", "\told();", "}"].join("\n");
		const diff = ["PUT 1-1:", "+if (b) {", "PUT 2-3:", "+\tfresh();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["if (b) {", "\tfresh();", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("does not keep deleted closer suffixes whose tail the payload already restates", () => {
		const file = [
			"const REASONING_LABEL_PATTERN = /think/i;",
			"const NO_REASONING_LABEL_PATTERN = /no/i;",
			"",
			"\treturn config.supportsThinking === true;",
			"}",
			"}",
		].join("\n");
		const diff = [
			"PUT 3-6:",
			"+function supportsDevinThinking(config: ClientModelConfig): boolean {",
			"+\tif (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;",
			"+\treturn config.supportsThinking === true;",
			"+}",
		].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			[
				"const REASONING_LABEL_PATTERN = /think/i;",
				"const NO_REASONING_LABEL_PATTERN = /no/i;",
				"function supportsDevinThinking(config: ClientModelConfig): boolean {",
				"\tif (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;",
				"\treturn config.supportsThinking === true;",
				"}",
			].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
	});

	it("keeps only the non-restated outer closer for a nested deleted suffix", () => {
		const file = ["class C {", "\told();", "\t}", "}"].join("\n");
		const diff = ["PUT 2-4:", "+\tnewMethod() {", "+\t\treturn 1;", "+\t}"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["class C {", "\tnewMethod() {", "\t\treturn 1;", "\t}", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("ignores non-contiguously deleted openers when choosing which closer to keep", () => {
		const file = ["if (a) {", "\told();", "\tmore();", "}", "const obj = {", "\ta: 1,", "};"].join("\n");
		const diff = ["CUT 1", "PUT 3-4:", "+\tfresh();", "PUT 7-7:", "+\tb: 2,"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["\told();", "\tfresh();", "const obj = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("counts earlier kept closers in later projected prefixes", () => {
		const file = [
			"if (a) {",
			"\told();",
			"}",
			"const NO_REASONING_LABEL_PATTERN = /no/i;",
			"\treturn config.supportsThinking === true;",
			"\t}",
		].join("\n");
		const diff = [
			"PUT 2-3:",
			"+\tfresh();",
			"PUT 4-6:",
			"+function supportsDevinThinking(config: ClientModelConfig): boolean {",
			"+\treturn config.supportsThinking === true;",
			"+}",
		].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			[
				"if (a) {",
				"\tfresh();",
				"}",
				"function supportsDevinThinking(config: ClientModelConfig): boolean {",
				"\treturn config.supportsThinking === true;",
				"}",
			].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("does not let an earlier kept closer cover a later orphan closer", () => {
		const file = ["if (a) {", "\told();", "}", "}"].join("\n");
		const diff = ["PUT 2-3:", "+\tfresh();", "PUT 4-4:", "+after();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["if (a) {", "\tfresh();", "}", "after();"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("does not keep a deleted outer closer when one survives below the range", () => {
		const file = ["class C {", "\tmethod() {", "\t\told();", "\t}", "}", "}"].join("\n");
		const diff = ["PUT 2-5:", "+\tmethod() {", "+\t\tfresh();", "+\t}"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["class C {", "\tmethod() {", "\t\tfresh();", "\t}", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
	});

	it("keeps an omitted inner closer when the outer closer survives below", () => {
		const file = ["class C {", "\tmethod() {", "\t\told();", "\t}", "}", "}"].join("\n");
		const diff = ["PUT 2-5:", "+\tmethod() {", "+\t\tfresh();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["class C {", "\tmethod() {", "\t\tfresh();", "\t}", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("counts head insertions before replacement payloads in original coordinates", () => {
		const file = ["\told();", "}"].join("\n");
		const diff = ["PUT <1:", "+if (a) {", "PUT 1-2:", "+\tfresh();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["if (a) {", "\tfresh();", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("counts a separately inserted closer immediately below the range", () => {
		const file = ["class C {", "\told();", "}", "after();", "const obj = {", "\ta: 1,", "};"].join("\n");
		const diff = ["PUT 2-3:", "+\tfresh();", "PUT <4:", "+}", "PUT 7-7:", "+\tb: 2,"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			["class C {", "\tfresh();", "}", "after();", "const obj = {", "\ta: 1,", "\tb: 2,", "};"].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("keeps an omitted outer closer even when the payload restates an inner closer", () => {
		const file = ["if (a) {", "\tif (b) {", "\t\told();", "\t}", "}", "after();"].join("\n");
		const diff = ["PUT 1-5:", "+if (a) {", "+\tif (c) {", "+\t\tfresh();", "+\t}"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["if (a) {", "\tif (c) {", "\t\tfresh();", "\t}", "}", "after();"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// A dupSuffix repair in hunk A zeroes its contribution; the residual must be
	// recomputed post-repair so hunk B's genuine missing closer still fires.
	it("still keeps a missing closer when another hunk's dupSuffix repair masks the raw delta", () => {
		const file = [
			'addEventListener("click", () => {',
			"\tfoo();",
			"\tbar();",
			"});",
			"",
			"const config = {",
			"\ta: 1,",
			"};",
		].join("\n");
		const diff = ["PUT 2-3:", "+\tsetup();", "+\tfoo();", "+\tbar();", "+});", "PUT 8-8:", "+\tb: 2,"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			[
				'addEventListener("click", () => {',
				"\tsetup();",
				"\tfoo();",
				"\tbar();",
				"});",
				"",
				"const config = {",
				"\ta: 1,",
				"\tb: 2,",
				"};",
			].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(2);
	});

	// Per-slot residual: an unterminated backtick template in one hunk must not
	// bleed across into another hunk's delimiter count and mask its missing closer.
	it("does not let an unterminated template in one hunk mask a missing closer in another", () => {
		const file = ["const log = makeLog(`", "prefix", "`);", "const obj = {", "\ta: 1", "};"].join("\n");
		const diff = ["PUT 1-1:", "+const log = createLog(`", "PUT 5-6:", "+\ta: 2"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["const log = createLog(`", "prefix", "`);", "const obj = {", "\ta: 2", "};"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});
	// The neon.rs incident: the range starts one line early, on the lone `}`
	// closing the `if` above, and the payload (sibling-depth statements) never
	// restates it. The closer is spared and the payload lands after it.
	it("spares a leading closer the range swallowed when the payload claims sibling depth", () => {
		const file = [
			"fn f() {",
			"\tif a {",
			"\t\treturn;",
			"\t}",
			"\tlet lead = old1();",
			"\tlet t4 = old2();",
			"\tlet done = old3();",
			"}",
		].join("\n");
		const diff = ["PUT 4-6:", "+\tlet mask = new1();", "+\tlet lead = new2();", "+\tlet t4 = new3();"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(
			[
				"fn f() {",
				"\tif a {",
				"\t\treturn;",
				"\t}",
				"\tlet mask = new1();",
				"\tlet lead = new2();",
				"\tlet t4 = new3();",
				"\tlet done = old3();",
				"}",
			].join("\n"),
		);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// A payload indented deeper than the swallowed closer claims the inside of
	// the block the closer just terminated — before vs after is a coin flip,
	// so the edit is rejected instead of guessed.
	it("rejects a swallowed leading closer when the payload claims the block interior", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\t\tcompute();", "+\t\tstore();"].join("\n");
		expect(() => applyRust(file, diff)).toThrow(/selected boundary row is required/);
	});

	// Deliberate two-hunk unwrap: another hunk deletes the matching `if` opener,
	// so the whole-patch residual is clean and the leading closer stays deleted.
	it("does not spare a leading closer whose opener another hunk removes", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tguard();", "PUT 4-5:", "+\tlet lead = new1();"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(["fn f() {", "\tguard();", "\t\treturn;", "\tlet lead = new1();", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
	});

	// The "complete new function over a head-only range" incident: the payload
	// is a fully balanced construct but the range ends mid-block, which would
	// orphan the old body's closers below. The edit applies as authored (text
	// shape cannot prove a syntactic block) but warns with the block-op remedy.
	it("warns when a balanced payload's range ends mid-block", () => {
		const file = [
			"fn old(a: u32) -> bool {",
			"\tlet x = a + 1;",
			"\tlet y = x * 2;",
			"\tlet z = y - 3;",
			"\tz > 0",
			"}",
		].join("\n");
		const diff = ["PUT 1-3:", "+fn new(a: u32) -> bool {", "+\tlet x = a + 2;", "+\tx > 0", "+}"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(
			["fn new(a: u32) -> bool {", "\tlet x = a + 2;", "\tx > 0", "}", "\tlet z = y - 3;", "\tz > 0", "}"].join(
				"\n",
			),
		);
		expect(warnings).toEqual([expect.stringContaining("introduced a syntax error")]);
	});

	// The applier is language-agnostic: in Markdown these braces are literal
	// prose, so the edit must apply verbatim — never be rejected. The advisory
	// warning still fires (shape witnesses pass); the author ignores it.
	it("applies a prose edit that deletes a literal opening brace in Markdown", () => {
		const file = ["Intro {", "body", "}"].join("\n");
		const diff = ["PUT 1-2:", "+Revised"].join("\n");
		const { text } = apply(file, diff);
		expect(text).toBe(["Revised", "}"].join("\n"));
	});

	// Repairing an already-broken file by appending closers is deliberate
	// net-closing content — never a mid-block mistake.
	it("does not warn for a net-closing payload that repairs a broken file", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\tdone();", "}"].join("\n");
		const diff = ["PUT 3-3:", "+\t\treturn;", "+\t}"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tdone();", "}"].join("\n"));
		expect(warnings.filter(warning => /mid-block/.test(warning))).toHaveLength(0);
	});
	// Symmetric invalid→valid repair: the file already carries a surplus
	// opener, so replacing that opener line with a plain statement rebalances
	// the file — the surviving `}` below pairs with `fn f() {`, not with the
	// deleted `if a {`. Must apply without a mid-block warning.
	it("does not warn when deleting a surplus opener from an already-broken file", () => {
		const file = ["fn f() {", "\tif a {", "\t\twork();", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tprepare();"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(["fn f() {", "\tprepare();", "\t\twork();", "}"].join("\n"));
		expect(warnings.filter(warning => /mid-block/.test(warning))).toHaveLength(0);
	});
	// The balance scanner counts regex-literal braces naively; that miscount
	// may only ever suppress, never trigger the mid-block warning. Replacing
	// the `/{/` line is valid JS before and after — no deleted line ends with
	// a raw `{` and no lone closer line survives below.
	it("does not warn when replacing a regex literal whose braces fooled the balance scanner", () => {
		const file = ["const open = /{/;", "const close = /}/;"].join("\n");
		const diff = ["PUT 1-1:", "+const open = /x/;"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["const open = /x/;", "const close = /}/;"].join("\n"));
		expect(warnings.filter(warning => /mid-block/.test(warning))).toHaveLength(0);
	});

	// Same regex pair embedded in a real function: the enclosing `}` below is
	// a genuine lone closer, so the closer witness alone is satisfied — the
	// opener-shape witness (`const open = /{/;` ends with `;`, not `{`) must
	// still suppress the warning.
	it("does not warn for a regex-literal replacement inside a real block", () => {
		const file = ["function setup() {", "\tconst open = /{/;", "\tconst close = /}/;", "}"].join("\n");
		const diff = ["PUT 2-2:", "+\tconst open = /x/;"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["function setup() {", "\tconst open = /x/;", "\tconst close = /}/;", "}"].join("\n"));
		expect(warnings.filter(warning => /mid-block/.test(warning))).toHaveLength(0);
	});
	// The parser's veto in prose: Markdown parses with or without the literal
	// `}`, so the leading-closer spare must not fire and — since nothing is
	// wrong — must not even warn. (The advisory counterexample: the authored
	// intent is `Intro {` + `Revised`, not a resurrected brace.)
	it("applies a prose edit verbatim when the range deletes a literal leading brace", () => {
		const file = ["Intro {", "}", "old"].join("\n");
		const diff = ["PUT 2-3:", "+Revised"].join("\n");
		const { text, warnings } = applyProse(file, diff);
		expect(text).toBe(["Intro {", "Revised"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// Mirror for the trailing edge: the long-shipped suffix spare is vetoed by
	// the same parse.
	it("applies a prose edit verbatim when the range deletes a literal trailing brace", () => {
		const file = ["old", "}", "Outro"].join("\n");
		const diff = ["PUT 1-2:", "+Revised"].join("\n");
		const { text, warnings } = applyProse(file, diff);
		expect(text).toBe(["Revised", "Outro"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// Same leading-closer shape in real code: no veto is available (the authored
	// result does not parse), so the spare fires and the file stays valid.
	it("spares the swallowed leading closer when the authored edit does not parse", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const diff = ["PUT 4-5:", "+\tlet lead = new1();"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = new1();", "}"].join("\n"));
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});
	// No proof, no mutation. Without a path the probe cannot judge anything, so
	// the closer-spare must not fire: the edit lands exactly as authored, even
	// though the delimiter heuristics alone would have "repaired" it.
	it("applies as authored when no path is supplied, since no repair can be proven", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const { text } = applyEdits(file, parsePatch(["PUT 4-5:", "+\tlet lead = fresh1();"].join("\n")).edits);
		expect(text).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\tlet lead = fresh1();", "}"].join("\n"));
	});

	// Same for a language tree-sitter does not know: nothing can be proven, so
	// nothing is rewritten and no advisory is invented.
	it("applies as authored for a language the parser does not know", () => {
		const file = ["fn f() {", "\tif a {", "\t\treturn;", "\t}", "\tlet lead = old1();", "}"].join("\n");
		const result = applyEdits(file, parsePatch(["PUT 4-5:", "+\tlet lead = fresh1();"].join("\n")).edits, {
			path: "fixture.unknownlang",
		});
		expect(result.text).toBe(["fn f() {", "\tif a {", "\t\treturn;", "\tlet lead = fresh1();", "}"].join("\n"));
		expect(result.warnings ?? []).toHaveLength(0);
	});
	// The one-sided boundary echo is proven by exact line equality, not by
	// delimiter semantics, so the parser has no say over it. It must reject even
	// on a language the probe cannot read — otherwise suppressing the
	// closer-spare verdict would also let this unsafe edit through, deleting
	// range lines the body never restates.
	it("still rejects a too-short one-sided echo on a language the parser cannot read", () => {
		const file = ["alpha", "beta", "gamma", "delta", "eps"].join("\n");
		const diff = ["PUT 2-4:", "+alpha", "+fresh1"].join("\n");
		for (const path of [undefined, "fixture.unknownlang", "fixture.ts"]) {
			expect(() => applyEdits(file, parsePatch(diff).edits, path === undefined ? {} : { path })).toThrow(
				/too short to be the full final content/,
			);
		}
	});
});

describe("boundary-balance repair through stale-snapshot recovery", () => {
	const PATH = "/tmp/__hashline-boundary-recovery__.ts";

	// Recovery composes `applyEdits` to compute the intended change, so the
	// boundary repair runs there too. The snapshot (what the model read)
	// carries the structure; the live file has drifted far from the edit
	// region, so anchor recovery succeeds and the repaired (de-duplicated)
	// hunk lands without doubling the closer.
	it("de-duplicates a closer while recovering from a drifted file", () => {
		const snapshotLines = [
			'import { x } from "y";',
			"",
			"it('a', () => {",
			"\tsetup();",
			"\trun();",
			"});",
			"",
			"function filler1() { return 1; }",
			"function filler2() { return 2; }",
			"function filler3() { return 3; }",
			"function filler4() { return 4; }",
			"function filler5() { return 5; }",
			"const tail = 0;",
			"export { tail };",
		];
		const snapshotText = `${snapshotLines.join("\n")}\n`;
		// Live file drifted only at the tail (line 13) — far outside the edit
		// region (lines 4-6), so unchanged-anchor recovery succeeds.
		const currentText = snapshotText.replace("const tail = 0;", "const tail = 99;");

		const store = new InMemorySnapshotStore();
		const fileHash = store.record(PATH, snapshotText);

		// `replace 4.=5:` replaces the body lines but the payload also restates the `});`
		// that survives at line 6 — the duplicate-closer mistake.
		const { edits } = parsePatch(["PUT 4-5:", "+\tsetup2();", "+\trun2();", "+});"].join("\n"));
		const recovered = new Recovery(store).tryRecover({ path: PATH, currentText, fileHash, edits });

		expect(recovered).not.toBeNull();
		// Exactly one `});` — the duplicate was absorbed during recovery.
		expect(recovered?.text.split("\n").filter(l => l === "});")).toHaveLength(1);
		expect(recovered?.text).toContain("setup2();");
		expect(recovered?.text).toContain("run2();");
		// The unrelated drift on the live file survives the merge.
		expect(recovered?.text).toContain("const tail = 99;");
		// The repair warning propagates out through the recovery result.
		expect(boundaryRepairWarnings(recovered?.warnings ?? [])).toHaveLength(1);
	});
});

// Regressions from a live omp-ar refactor session: two hashline edits broke a
// Rust file with zero feedback. Both must now surface a warning in the same
// response, and correctly authored edits on the same shapes must stay silent.
describe("rust lifetime delimiter counting (the extension() incident)", () => {
	// `pub const fn extension(self) -> &'static str {` — the `'` of the
	// lifetime used to enter string state and swallow the trailing `{`, so a
	// range covering signature + match block looked balance-neutral and the
	// missing-signature result applied silently.
	const file = [
		"/// Archive container format.",
		"#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
		"pub enum Format {",
		"   Zip,",
		"   Tar,",
		"   TarGz,",
		"}",
		"",
		"impl Format {",
		"   /// Returns the canonical filename extension for this format.",
		"   pub const fn extension(self) -> &'static str {",
		"      match self {",
		'         Self::Zip => "zip",',
		'         Self::Tar => "tar",',
		'         Self::TarGz => "tar.gz",',
		"      }",
		"   }",
		"}",
	].join("\n");

	it("flags a range that swallows a lifetime-carrying signature line", () => {
		// Range 11-16 deletes the signature's `{` (hidden behind `'static`
		// before the fix) and the match block; payload is only the new body.
		const { text, warnings } = applyRust(file, "PUT 11.=16:\n+\t\tself.into()");
		// Applied as authored — advisory, not repair.
		expect(text).toContain("\t\tself.into()");
		expect(text).not.toContain("pub const fn extension");
		expect(warnings.some(w => /introduced a syntax error/.test(w))).toBe(true);
	});

	it("does not resurrect a swallowed signature when body indentation matches", () => {
		const { text, warnings } = applyRust(file, "PUT 11.=16:\n+      self.into()");

		expect(text).toContain("      self.into()");
		expect(text).not.toContain("pub const fn extension");
		expect(boundaryRepairWarnings(warnings)).toHaveLength(0);
		expect(warnings).toEqual([expect.stringContaining("introduced a syntax error")]);
	});

	it("stays silent for the correct whole-construct replacement", () => {
		const diff = [
			"PUT 11.=17:",
			"+   pub const fn extension(self) -> &'static str {",
			"+      self.into()",
			"+   }",
		].join("\n");
		const { warnings } = applyRust(file, diff);
		expect(warnings).toHaveLength(0);
	});

	it("stays silent editing below a multi-lifetime signature", () => {
		// `<'a>(left: &'a str, right: &'a str)` — pairing apostrophes across
		// lifetimes would swallow the `(` and fabricate a paren delta.
		const multi = [
			"fn join<'a>(left: &'a str, right: &'a str) -> String {",
			'   let out = format!("{left}{right}");',
			"   out",
			"}",
		].join("\n");
		const { warnings } = applyRust(multi, 'PUT 2.=2:\n+   let out = format!("{left}-{right}");');
		expect(warnings).toHaveLength(0);
	});

	it("still lexes rust char literals as literals", () => {
		// `'{'` / `'}'` in match arms are content, not delimiters.
		const arms = [
			"fn depth(c: char, mut n: i32) -> i32 {",
			"   match c {",
			"      '{' => n += 1,",
			"      '}' => n -= 1,",
			"      _ => {},",
			"   }",
			"   n",
			"}",
		].join("\n");
		const { warnings } = applyRust(arms, "PUT 7.=7:\n+   n + 1");
		expect(warnings).toHaveLength(0);
	});
});

describe("post-apply parse advisory (the resolve_alias_path incident)", () => {
	// A balance-neutral single-line replacement landed on the wrong line — a
	// `return` swapped onto a method-chain step — leaving no delimiter anomaly
	// for the repair heuristics. The parse probe is the only witness.
	const file = [
		"impl A {",
		"   fn write_all(&self) -> Result<()> {",
		"      let paths: Vec<_> = self",
		"         .entries",
		"         .iter()",
		"         .filter(|entry| !entry.is_directory())",
		"         .map(|entry| entry.path.clone())",
		"         .collect();",
		"      Ok(())",
		"   }",
		"",
		"   fn resolve_path(&self, path: Str) -> Result<Str> {",
		"      if matches!(self.format, Format::Tar | Format::TarGz) {",
		"         return tar::resolve_alias_path(&self.entries, path);",
		"      }",
		"      Ok(path)",
		"   }",
		"}",
	].join("\n");
	const misplaced = "PUT 7.=7:\n+\t\t\treturn tar::resolve_alias_path(&self.entries, path, self.limits);";

	it("warns when a balance-neutral edit stops the file parsing", () => {
		const { text, warnings } = applyRust(file, misplaced);
		// Applied as authored; the warning names the landing line.
		expect(text).toContain("return tar::resolve_alias_path(&self.entries, path, self.limits);");
		expect(warnings).toEqual([expect.stringContaining("introduced a syntax error near line 7")]);
	});

	it("stays silent when the same statement lands on the intended line", () => {
		const { warnings } = applyRust(
			file,
			"PUT 14.=14:\n+         return tar::resolve_alias_path(&self.entries, path, self.limits);",
		);
		expect(warnings).toHaveLength(0);
	});

	it("casts no advisory when the baseline was already broken", () => {
		// Mid-refactor file that never parsed: the edit did not cause the
		// damage, so reporting it would be noise.
		const broken = ["impl A {", "   fn half(", "   let x = 1;"].join("\n");
		const { warnings } = applyRust(broken, "PUT 3.=3:\n+   let x = 2;");
		expect(warnings).toHaveLength(0);
	});

	it("casts no advisory for languages the probe cannot parse", () => {
		// Markdown braces are prose; `parsesCleanly` never vouches for the
		// baseline, so breakage cannot be attributed to the edit.
		const prose = ["# Title", "", "Uses { braces } freely.", "Done."].join("\n");
		const { warnings } = applyProse(prose, "PUT 4.=4:\n+Still { unbalanced");
		expect(warnings).toHaveLength(0);
	});
});

// The doc-restoration incident: `cargo fmt` shifted line numbers under the
// model, so a `PUT N.=N` meant to prepend doc lines above `#[napi]` landed one
// line high. Each body ended by restating the `#[napi]` that survives just
// below the range, duplicating the attribute. The result PARSES (attributes
// may repeat syntactically), so the probe-judged variant search never runs —
// only exact-text normalization with annotation-row evidence can catch it.
describe("single-line annotation echoes (the #[napi] doc-restoration incident)", () => {
	it("drops a trailing attribute echo in a single-line replacement", () => {
		const file = [
			"/// Unified-diff hunks with jsdiff",
			"/// `structuredPatch(_, _, oldText, newText, _, _, { context }).hunks`",
			"#[napi]",
			"pub fn structured_patch_hunks() {}",
		].join("\n");
		const diff = ["PUT 2.=2:", "+/// semantics. `context` defaults to 4 like jsdiff.", "+#[napi]"].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(
			[
				"/// Unified-diff hunks with jsdiff",
				"/// semantics. `context` defaults to 4 like jsdiff.",
				"#[napi]",
				"pub fn structured_patch_hunks() {}",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line === "#[napi]")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	it("drops the echo when the body carries several new doc rows", () => {
		const file = [
			"/// Wrap text to a visible width, preserving ANSI escape codes across line",
			"/// breaks.",
			"#[napi]",
			"pub fn wrap_text_with_ansi() {}",
		].join("\n");
		const diff = [
			"PUT 2.=2:",
			"+///",
			"+/// Returns UTF-16 lines with active SGR codes carried across line boundaries.",
			"+#[napi]",
		].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(
			[
				"/// Wrap text to a visible width, preserving ANSI escape codes across line",
				"///",
				"/// Returns UTF-16 lines with active SGR codes carried across line boundaries.",
				"#[napi]",
				"pub fn wrap_text_with_ansi() {}",
			].join("\n"),
		);
		expect(text.split("\n").filter(line => line === "#[napi]")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Mirror direction: the range landed one line low and the body opens by
	// restating the attribute that survives just above it.
	it("drops a leading attribute echo in a single-line replacement", () => {
		const file = ["#[napi]", "/// Old summary.", "pub fn f() {}"].join("\n");
		const diff = ["PUT 2.=2:", "+#[napi]", "+/// New summary."].join("\n");
		const { text, warnings } = applyRust(file, diff);
		expect(text).toBe(["#[napi]", "/// New summary.", "pub fn f() {}"].join("\n"));
		expect(text.split("\n").filter(line => line === "#[napi]")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Under-filled: the body is nothing but the echo. Dropping it would turn
	// the replace into a bare delete of the range line; applying it would
	// duplicate the attribute. Reject rather than guess.
	it("rejects a single-line annotation echo whose body cannot fill the range", () => {
		const file = ["/// Old doc.", "#[napi]", "pub fn f() {}"].join("\n");
		expect(() => applyRust(file, "PUT 1.=1:\n+#[napi]")).toThrow(/ends by restating/);
	});

	// Same shape in TypeScript: duplicate adjacent decorators parse, so the
	// annotation-row evidence is what fires, not the syntax probe.
	it("drops a trailing decorator echo in a single-line replacement", () => {
		const file = ["/** Old summary. */", "@Injectable()", "class Service {}"].join("\n");
		const diff = ["PUT 1.=1:", "+/** Creates request-scoped services. */", "+@Injectable()"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["/** Creates request-scoped services. */", "@Injectable()", "class Service {}"].join("\n"));
		expect(text.split("\n").filter(line => line === "@Injectable()")).toHaveLength(1);
		expect(boundaryRepairWarnings(warnings)).toHaveLength(1);
	});

	// Statement echoes on single-line ranges stay literal (pinned above by the
	// balance-preserving tests): the annotation gate must not widen to them.
	it("keeps a trailing statement echo literal on a single-line range", () => {
		const file = ["foo();", "old();", "bar();"].join("\n");
		const { text, warnings } = apply(file, "PUT 2.=2:\n+fresh();\n+bar();");
		expect(text).toBe(["foo();", "fresh();", "bar();", "bar();"].join("\n"));
		expect(warnings).toHaveLength(0);
	});
});
