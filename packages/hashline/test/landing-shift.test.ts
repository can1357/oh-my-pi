import { describe, expect, it } from "bun:test";
import { applyEdits, type BlockResolver, type BlockSpan, Patch, parsePatch } from "@oh-my-pi/hashline";

/**
 * After-insert landing correction: an `insert after N:` body indented
 * shallower than line N slides past the structural closer lines below the
 * anchor until depth returns to the body's level. Contract under test: the
 * shift fires only on a comparable, strictly-shallower depth claim, crosses
 * closers only, respects other hunks' targets, and always reports a warning.
 */

const FILE = [
	"function f() {", // 1
	"    if (x) {", // 2
	"        a();", // 3
	"    }", // 4
	"    b();", // 5
	"}", // 6
	"",
].join("\n");

function apply(text: string, patch: string): { text: string; warnings: string[] } {
	const { edits } = parsePatch(patch);
	const result = applyEdits(text, edits);
	return { text: result.text, warnings: result.warnings ?? [] };
}

describe("after-insert landing shift", () => {
	it("slides a shallower body past the closing line and warns", () => {
		const { text, warnings } = apply(FILE, "PUT >3:\n+    c();");

		expect(text).toBe(
			["function f() {", "    if (x) {", "        a();", "    }", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/PUT >3: .*moved past 1 closing line to after line 4/);
	});

	it("crosses multiple closer levels and stops when depth returns to the body's", () => {
		const nested = [
			"function f() {", // 1
			"    if (x) {", // 2
			"        for (y) {", // 3
			"            a();", // 4
			"        }", // 5
			"    }", // 6
			"    b();", // 7
			"}", // 8
			"",
		].join("\n");

		// Body at depth 4 escapes both the `for` and the `if`.
		const outer = apply(nested, "PUT >4:\n+    c();");
		expect(outer.text.split("\n")[6]).toBe("    c();");
		expect(outer.warnings[0]).toMatch(/moved past 2 closing lines to after line 6/);

		// Body at depth 8 escapes only the `for`, staying inside the `if`.
		const inner = apply(nested, "PUT >4:\n+        c();");
		expect(inner.text.split("\n")[5]).toBe("        c();");
		expect(inner.warnings[0]).toMatch(/moved past 1 closing line to after line 5/);
	});

	it("does not shift when the body matches the anchor's depth", () => {
		const { text } = apply(FILE, "PUT >3:\n+        c();");
		expect(text.split("\n")[3]).toBe("        c();");
	});

	it("never crosses content lines (indentation-only languages stay put)", () => {
		const py = ["def f():", "    if x:", "        a()", "    b()", ""].join("\n");
		const { text, warnings } = apply(py, "PUT >3:\n+    c()");
		expect(text).toBe(["def f():", "    if x:", "        a()", "    c()", "    b()", ""].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	it("treats a body of pure closers as depth-neutral", () => {
		const { text, warnings } = apply(FILE, "PUT >3:\n+    }");
		expect(text.split("\n")[3]).toBe("    }");
		expect(warnings).toHaveLength(0);
	});

	it("skips incomparable indentation styles (tabs file, spaces body)", () => {
		const tabs = ["function f() {", "\tif (x) {", "\t\ta();", "\t}", "\tb();", "}", ""].join("\n");
		const { text } = apply(tabs, "PUT >3:\n+    c();");
		expect(text.split("\n")[3]).toBe("    c();");
	});

	it("refuses to cross a line targeted by another hunk", () => {
		const { text, warnings } = apply(FILE, "PUT >3:\n+    c();\nCUT 4");
		// The closer on line 4 is owned by the cut; the insert stays put.
		expect(text).toBe(["function f() {", "    if (x) {", "        a();", "    c();", "    b();", "}", ""].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	it("looks past blank lines between the anchor and the closer", () => {
		const gapped = ["function f() {", "    if (x) {", "        a();", "", "    }", "    b();", "}", ""].join("\n");
		const { text, warnings } = apply(gapped, "PUT >3:\n+    c();");
		expect(text).toBe(
			["function f() {", "    if (x) {", "        a();", "", "    }", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(warnings[0]).toMatch(/after line 5/);
	});

	it("leaves `PUT < N:` untouched", () => {
		const { text, warnings } = apply(FILE, "PUT <4:\n+    c();");
		expect(text.split("\n")[3]).toBe("    c();");
		expect(warnings).toHaveLength(0);
	});

	it("composes with `PUT >N*: N:` to escape enclosing closers", () => {
		// stub: block beginning on N spans [N, N+1] → `block 2` ends on line 3.
		const stubResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });
		const text = ["function f() {", "    const t = mk({", "    });", "}", "x();", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT >2*:\n+ref = t;");

		const result = section.applyTo(text, stubResolver);

		// after_anchor lands on span.end (line 3); the depth-0 body then slides
		// past the function's closing `}` on line 4.
		expect(result.text).toBe(
			["function f() {", "    const t = mk({", "    });", "}", "ref = t;", "x();", ""].join("\n"),
		);
		expect(result.warnings?.some(w => /moved past 1 closing line to after line 4/.test(w))).toBe(true);
	});
});

/**
 * Inward landing correction for `insert_after_block N:` — a body indented
 * deeper than the block's closing line claims a depth INSIDE the block (the
 * "append at the end of the block's body" misreading), so the landing slides
 * back across the block's trailing closers. Contract under test: fires only
 * for block-lowered inserts with a strictly-deeper body, lands after the last
 * content line at the claimed depth, respects other hunks' targets, and
 * warns; sibling-depth bodies and plain `insert after M:` stay literal.
 */
describe("insert-after-block inward landing shift", () => {
	const BLOCK_FILE = [
		"function f() {", // 1
		"    afterEach(() => {", // 2
		"        destroy();", // 3
		"    });", // 4
		"}", // 5
		"",
	].join("\n");

	it("pulls a deeper body inside the block, after its last content line", () => {
		const resolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 2 });
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT >2*:\n+        setup();");
		const result = section.applyTo(BLOCK_FILE, resolver);

		expect(result.text).toBe(
			["function f() {", "    afterEach(() => {", "        destroy();", "        setup();", "    });", "}", ""].join(
				"\n",
			),
		);
		expect(result.warnings?.some(w => /PUT >2\*: .*placed inside the block, after line 3/.test(w))).toBe(true);
	});

	it("lands right after the opener of an empty block", () => {
		const resolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });
		const text = ["function f() {", "    afterEach(() => {", "    });", "}", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT >2*:\n+        setup();");

		const result = section.applyTo(text, resolver);

		expect(result.text).toBe(
			["function f() {", "    afterEach(() => {", "        setup();", "    });", "}", ""].join("\n"),
		);
		expect(result.warnings?.some(w => /placed inside the block, after line 2/.test(w))).toBe(true);
	});

	it("crosses nested trailing closers and stops at the body's claimed depth", () => {
		const resolver: BlockResolver = (): BlockSpan => ({ start: 1, end: 5 });
		const text = ["foo(() => {", "    bar(() => {", "        x();", "    });", "});", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT >1*:\n+    baz();");

		const result = section.applyTo(text, resolver);

		// depth-4 body = sibling of `bar(...)` inside `foo`: crosses the outer
		// `});` only, stopping at the inner closer that sits at its depth.
		expect(result.text).toBe(
			["foo(() => {", "    bar(() => {", "        x();", "    });", "    baz();", "});", ""].join("\n"),
		);
		expect(result.warnings?.some(w => /placed inside the block, after line 4/.test(w))).toBe(true);
	});

	it("leaves a sibling-depth body after the block (the literal contract)", () => {
		const resolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 2 });
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT >2*:\n+    cleanup();");

		const result = section.applyTo(BLOCK_FILE, resolver);

		expect(result.text).toBe(
			["function f() {", "    afterEach(() => {", "        destroy();", "    });", "    cleanup();", "}", ""].join(
				"\n",
			),
		);
		expect(result.warnings ?? []).toHaveLength(0);
	});

	it("never shifts a plain `insert after M:` anchored on a closer", () => {
		const { text, warnings } = apply(BLOCK_FILE, "PUT >4:\n+        leak();");

		expect(text.split("\n")[4]).toBe("        leak();");
		expect(warnings).toHaveLength(0);
	});

	it("refuses to cross a closer targeted by another hunk", () => {
		const resolver: BlockResolver = (): BlockSpan => ({ start: 1, end: 5 });
		const text = ["foo(() => {", "    bar(() => {", "        x();", "    });", "});", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#1A2B]\nPUT 4-4:\n+    }); // bar\nPUT >1*:\n+        y();");

		const result = section.applyTo(text, resolver);

		expect(result.text).toBe(
			["foo(() => {", "    bar(() => {", "        x();", "    }); // bar", "});", "        y();", ""].join("\n"),
		);
		expect(result.warnings?.some(w => /placed inside the block/.test(w)) ?? false).toBe(false);
	});
});

/**
 * Opener-escape landing correction — the stdout_policy incident: a plain
 * `PUT >N:` anchored on the OPENING line of `fn clone_box` inserted a whole
 * tab-indented test `mod` between the opener and its body. The result parsed
 * (items are legal inside Rust fn bodies), so no probe warning fired and the
 * corruption landed silently. Contract under test: a balanced construct body
 * claiming a column depth strictly above the opener is landed after the first
 * closer returning to that depth, verified by the syntax probe; statements,
 * equal-depth bodies, unverifiable languages, and unparseable relocations
 * stay literal.
 */
describe("opener-anchored after-insert escape (the stdout_policy incident)", () => {
	// Mirrors crates/pi-builtins/src/host.rs: 3-space file, tab-indented body.
	const RUST_FILE = [
		"mod testing {", // 1
		"   struct MemStream;", // 2
		"", // 3
		"   impl Stream for MemStream {", // 4
		"      fn clone_box(&self) -> u32 {", // 5
		"         1", // 6
		"      }", // 7
		"", // 8
		"      fn try_borrow(&self) -> u32 {", // 9
		"         7", // 10
		"      }", // 11
		"   }", // 12
		"}", // 13
		"",
	].join("\n");
	const MOD_BODY = [
		"PUT >5:",
		"+",
		"+\tmod stdout_policy {",
		"+\t\tuse super::MemStream;",
		"+",
		"+\t\t#[test]",
		"+\t\tfn line_policy() {",
		"+\t\t\tassert!(true);",
		"+\t\t}",
		"+\t}",
	].join("\n");

	function applyRust(text: string, patch: string): { text: string; warnings: string[] } {
		const result = applyEdits(text, parsePatch(patch).edits, { path: "fixture.rs" });
		return { text: result.text, warnings: result.warnings ?? [] };
	}

	it("lands a tab-indented construct body after the block, not inside the opener", () => {
		const { text, warnings } = applyRust(RUST_FILE, MOD_BODY);
		const lines = text.split("\n");
		// The fn body stays contiguous with its opener.
		expect(lines[4]).toBe("      fn clone_box(&self) -> u32 {");
		expect(lines[5]).toBe("         1");
		// The mod landed after the impl closer (line 12), inside `mod testing`.
		expect(lines[11]).toBe("   }");
		expect(lines[13]).toBe("\tmod stdout_policy {");
		expect(warnings.some(w => /PUT >5: line 5 opens a block/.test(w))).toBe(true);
	});

	it("keeps a bare shallower statement literal (first-statement inserts survive)", () => {
		const { text, warnings } = applyRust(RUST_FILE, "PUT >5:\n+   let x = 1;");
		expect(text.split("\n")[5]).toBe("   let x = 1;");
		expect(warnings.some(w => /opens a block/.test(w))).toBe(false);
	});

	it("keeps an equal-depth body literal (matches the outward shift's contract)", () => {
		const body = ["PUT >5:", "+      fn extra(&self) -> u32 {", "+         2", "+      }"].join("\n");
		const { text, warnings } = applyRust(RUST_FILE, body);
		expect(text.split("\n")[5]).toBe("      fn extra(&self) -> u32 {");
		expect(warnings.some(w => /opens a block/.test(w))).toBe(false);
	});

	it("abandons the escape when the relocated result does not parse", () => {
		// Balanced `{`-construct that is not a legal item: relocating it to
		// `mod testing` scope would break the parse, so it stays literal.
		const body = ["PUT >5:", "+   Some(1) => {", "+   }"].join("\n");
		const { text, warnings } = applyRust(RUST_FILE, body);
		expect(text.split("\n")[5]).toBe("   Some(1) => {");
		expect(warnings.some(w => /opens a block/.test(w))).toBe(false);
	});

	it("stays literal without a parseable path (no probe, no relocation)", () => {
		const { edits } = parsePatch(MOD_BODY);
		const result = applyEdits(RUST_FILE, edits);
		expect(result.text.split("\n")[6]).toBe("\tmod stdout_policy {");
		expect((result.warnings ?? []).some(w => /opens a block/.test(w))).toBe(false);
	});

	it("escapes a shallower function body past a class in TypeScript", () => {
		const file = ["class A {", "   method() {", "      return 1;", "   }", "}", ""].join("\n");
		const body = ["PUT >2:", "+function helper() {", "+   return 2;", "+}"].join("\n");
		const result = applyEdits(file, parsePatch(body).edits, { path: "fixture.ts" });
		expect(result.text).toBe(
			[
				"class A {",
				"   method() {",
				"      return 1;",
				"   }",
				"}",
				"function helper() {",
				"   return 2;",
				"}",
				"",
			].join("\n"),
		);
		expect((result.warnings ?? []).some(w => /PUT >2: line 2 opens a block/.test(w))).toBe(true);
	});
});
