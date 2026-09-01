import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	applySloppy,
	computeSloppySectionDiff,
	executeSloppy,
	SLOPPY_MARKERS,
	splitSloppySections,
	sloppyVariant as variant,
} from "./sloppy";

const context = { path: "src/example.ts" };
const M = SLOPPY_MARKERS;
const esc = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function operation(pattern: string, rewrite: string): string {
	return `${M.open}\n${pattern}\n${M.put}\n${rewrite}`;
}

function inlineOperation(pattern: string, all = false): string {
	return `${M.open}${all ? "*" : ""}\n${pattern}`;
}

describe("sloppy v8", () => {
	test("replaces only the selected token and preserves outside gaps", () => {
		const content = "const timeout = readConfig().timeout ?? 1000;\nrun(timeout);\n";
		const input = operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000");

		expect(variant.apply(content, input, context)).toBe(
			"const timeout = readConfig().timeout ?? 5000;\nrun(timeout);\n",
		);
	});

	test("applies inline replacements to each named selection", () => {
		const content = "const timeout = 1000;\nconst retries = 3;\n";
		const input = inlineOperation("const timeout = ⟪1000│5000⟫;\nconst retries = ⟪3│5⟫;");

		expect(variant.apply(content, input, context)).toBe("const timeout = 5000;\nconst retries = 5;\n");
	});

	test("re-emits selected gaps from an inline replacement", () => {
		const content = "const value = oldCall(options);\nreport(value);\n";
		const input = inlineOperation("const value = ⟪oldCall(…)│newCall(…) ?? fallback⟫;\nreport(value)");

		expect(variant.apply(content, input, context)).toBe(
			"const value = newCall(options) ?? fallback;\nreport(value);\n",
		);
	});

	test("splits a selection containing literal dividers at the middle divider", () => {
		const content = 'row("│ a │", x);\n';
		const notes: string[] = [];
		const input = inlineOperation('row(⟪"│ a │", x│"│ b │", y⟫);');

		expect(variant.apply(content, input, { path: "box.ts", notes })).toBe('row("│ b │", y);\n');
		expect(notes.join("\n")).toMatch(/middle one was read as the divider/);
	});

	test("reads a trailing divider as deletion when the selection contains literal dividers", () => {
		const content = 'a();\ndraw("│");\nb();\n';
		const notes: string[] = [];
		const input = inlineOperation('⟪draw("│");\n│⟫');

		expect(variant.apply(content, input, { path: "box.ts", notes })).toBe("a();\nb();\n");
		expect(notes.join("\n")).toMatch(/read as a deletion of the selected text with the inner/);
	});

	test("reads an even divider count without a trailing divider as deletion of the selection", () => {
		const content = 't("x│y│z");\nkeep();\n';
		const notes: string[] = [];
		const input = inlineOperation('t("⟪x│y│z⟫");');

		expect(variant.apply(content, input, { path: "box.ts", notes })).toBe('t("");\nkeep();\n');
		expect(notes.join("\n")).toMatch(/no unambiguous divider/);
	});

	test("anchors an add run above a gap to its preceding line", () => {
		const content = "use std::{\n\tfs,\n\titer,\n};\n\nfn main() {\n\trun();\n}\n";
		const input = inlineOperation("\tfs,\n＋\tio,\n…\nfn main() {");

		expect(variant.apply(content, input, context)).toBe(
			"use std::{\n\tfs,\n\tio,\n\titer,\n};\n\nfn main() {\n\trun();\n}\n",
		);
	});

	test("replaces the whole line when a bare selection's REWRITE restates it", () => {
		const content = "  screen = [y -> Blank],  \\* viewport\nnext();\n";
		const notes: string[] = [];
		const input = operation(
			"  screen = [y -> ⟪Blank⟫],  \\* viewport",
			"  screen = [y -> IF y = 1 THEN SRow ELSE Blank],  \\* row 1 is shell",
		);

		expect(variant.apply(content, input, { path: "spec.tla", notes })).toBe(
			"  screen = [y -> IF y = 1 THEN SRow ELSE Blank],  \\* row 1 is shell\nnext();\n",
		);
		expect(notes.join("\n")).toMatch(/restated the whole selection-bearing line/);
	});

	test("keeps a mid-line ellipsis in REWRITE literal when the capture is multi-line", () => {
		const content = "function f() {\n  a();\n  b();\n}\n";
		// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
		const input = operation("function f() {\n…\n}", "function f() {\n  return `${x}[… ]${y}`;\n}");

		// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
		expect(variant.apply(content, input, context)).toBe("function f() {\n  return `${x}[… ]${y}`;\n}\n");
	});

	test("applies add lines containing literal selection markers verbatim", () => {
		const content = "run();\ndone();\n";
		const input = inlineOperation("run();\n＋const sel = '⟪a│b⟫';");

		expect(variant.apply(content, input, context)).toBe("run();\nconst sel = '⟪a│b⟫';\ndone();\n");
	});

	test("inserts an add line after its anchor", () => {
		const content = "anyhow = { workspace = true }\nitertools = { workspace = true }\ntokio = { workspace = true }\n";
		const input = inlineOperation("itertools = { workspace = true }\n＋jiff = { workspace = true }");

		expect(variant.apply(content, input, context)).toBe(
			"anyhow = { workspace = true }\nitertools = { workspace = true }\njiff = { workspace = true }\ntokio = { workspace = true }\n",
		);
	});

	test("keeps a run of add lines in authored order", () => {
		const content = "first();\nlast();\n";
		const input = inlineOperation("first();\n＋second();\n＋third();\nlast();");

		expect(variant.apply(content, input, context)).toBe("first();\nsecond();\nthird();\nlast();\n");
	});

	test("keeps an add line's indentation from either marker style", () => {
		const content = "fn main() {\n    setup();\n}\n";
		const indentedMarker = inlineOperation("    setup();\n    ＋run();");
		const columnZeroMarker = inlineOperation("    setup();\n＋    run();");

		expect(variant.apply(content, indentedMarker, context)).toBe("fn main() {\n    setup();\n    run();\n}\n");
		expect(variant.apply(content, columnZeroMarker, context)).toBe("fn main() {\n    setup();\n    run();\n}\n");
	});

	test("keeps typed depth for an indented add-line run before a following anchor", () => {
		// Regression: the matcher anchored the insert after the following line's
		// indent, so the typed indent doubled and the anchor line lost its own.
		const content = "export interface RetryPolicy {\n\tlimit: number;\n\tjitter: boolean;\n}\n";
		const input = inlineOperation(
			"\tlimit: number;\n＋\t/** Delay between attempts in ms */\n＋\tdelayMs: number;\n\tjitter: boolean;",
		);

		expect(variant.apply(content, input, context)).toBe(
			"export interface RetryPolicy {\n\tlimit: number;\n\t/** Delay between attempts in ms */\n\tdelayMs: number;\n\tjitter: boolean;\n}\n",
		);
	});

	test("normalizes whitespace-only MATCH rows around add lines", () => {
		const content = "function run() {\n  start();\n\n  end();\n}\n";
		const input = inlineOperation("  start();\n\n＋  inserted();\n \n  end();");

		expect(variant.apply(content, input, context)).toBe(
			"function run() {\n  start();\n  inserted();\n\n  end();\n}\n",
		);
	});

	test("mixes add lines with inline replacements in one operation", () => {
		const content = "const retries = 3;\nrun();\n";
		const input = inlineOperation("const retries = ⟪3│5⟫;\n＋const backoff = 250;");

		expect(variant.apply(content, input, context)).toBe("const retries = 5;\nconst backoff = 250;\nrun();\n");
	});

	test("replaces a contained region through one multi-line selection", () => {
		const content =
			"function displayName(user) {\n  if (!user) {\n    return fallback;\n  }\n  return user.name;\n}\n";
		const input = inlineOperation(
			"  ⟪if (!user) {\n    return fallback;\n  }\n  return user.name;│return user?.name ?? fallback;⟫\n}",
		);

		expect(variant.apply(content, input, context)).toBe(
			"function displayName(user) {\n  return user?.name ?? fallback;\n}\n",
		);
	});

	test("strips a diff-habit add marker from REWRITE lines", () => {
		// Regression: ＋-prefixed REWRITE lines were written verbatim, leaving
		// literal ＋ markers in the file.
		const content = "start();\nmiddle();\nend();\n";
		const input = operation("middle();", "＋replacement();\n＋more();");

		expect(variant.apply(content, input, context)).toBe("start();\nreplacement();\nmore();\nend();\n");
	});
	test("deletes a run of －-marked lines silently", () => {
		const content = "first();\nold();\nolder();\nlast();\n";
		const notes: string[] = [];
		const input = inlineOperation("first();\n－old();\n－older();\nlast();");

		expect(variant.apply(content, input, { path: context.path, notes })).toBe("first();\nlast();\n");
		expect(notes).toEqual([]);
	});

	test("replaces a － run with the ＋ run directly below it", () => {
		const content = "start();\nold();\nend();\n";
		const input = inlineOperation("start();\n－old();\n＋fresh();\nend();");

		expect(variant.apply(content, input, context)).toBe("start();\nfresh();\nend();\n");
	});

	test("deletes an indented －-marked line byte-for-byte", () => {
		const content = "fn main() {\n\tsetup();\n\trun();\n}\n";
		const input = inlineOperation("\tsetup();\n－\trun();");

		expect(variant.apply(content, input, context)).toBe("fn main() {\n\tsetup();\n}\n");
	});

	test("drops －-marked old lines from a REWRITE paired with ＋ lines", () => {
		const content = "alpha();\nbeta();\n";
		const input = operation("beta();", "－beta();\n＋gamma();");

		expect(variant.apply(content, input, context)).toBe("alpha();\ngamma();\n");
	});

	test("drops apply-patch end-of-edit sentinels from the payload", () => {
		const content = "start();\nmiddle();\nend();\n";
		const input = `${operation("middle();", "replacement();")}\n*** End of edit`;

		expect(variant.apply(content, input, context)).toBe("start();\nreplacement();\nend();\n");
	});

	test("applies a REWRITE written as a selection directive list inside the MATCH", () => {
		// Real gpt-oss shape: MATCH retypes the block, REWRITE lists ⟪old│new⟫
		// pairs; longest old wins overlapping targets, each hits every occurrence.
		const content = "const entries = avlue\n  ? avlue.models\n  : avlue;\n";
		const input = [
			M.open,
			"const entries = avlue",
			"  ? avlue.models",
			"  : avlue;",
			M.put,
			`⟪avlue│value⟫`,
			`⟪avlue.models│value.models⟫`,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const entries = value\n  ? value.models\n  : value;\n");
	});

	test("merges a pure deletion with a contained sibling rewrite into a union replace", () => {
		// Recurring swap shape: op1 deletes the whole region, op2 restates it
		// reordered; sequential application and union-replace are byte-identical.
		const content = "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n";
		const input = [
			M.open,
			"function alpha() {",
			"  return 1;",
			"}",
			"",
			"function beta() {",
			"  return 2;",
			"}",
			M.put,
			M.open,
			"function beta() {",
			"  return 2;",
			"}",
			M.put,
			"function beta() {",
			"  return 2;",
			"}",
			"",
			"function alpha() {",
			"  return 1;",
			"}",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			"function beta() {\n  return 2;\n}\n\nfunction alpha() {\n  return 1;\n}\n",
		);
	});

	test("defers an ambiguous op and resolves it against sibling claims", () => {
		// `? avlue` matches two sites; a sibling op explicitly claims the
		// `.models` site, so the deferred retry resolves to the free one.
		const content = "    ? avlue\n      ? avlue.models\n";
		const input = [M.open, `    ? ⟪avlue│value⟫`, M.open, `      ? ⟪avlue│value⟫.models`].join("\n");

		expect(variant.apply(content, input, context)).toBe("    ? value\n      ? value.models\n");
	});

	test("moves a block via delete plus add lines with blank-separated seams", () => {
		// Move idiom without registers: elided closing brace, blank context, and
		// EOF deletion must all land byte-exact.
		const content =
			"function make() {\n  return 1;\n}\n\nexport function target() {\n  return 2;\n}\n\nexport function moved() {\n  return 3;\n}\n";
		const input = [
			M.open,
			"export function moved() {",
			"  return 3;",
			"}",
			M.put,
			M.open,
			"  return 1;",
			"}",
			"＋",
			"＋export function moved() {",
			"＋  return 3;",
			"＋}",
			"export function target() {",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			"function make() {\n  return 1;\n}\n\nexport function moved() {\n  return 3;\n}\n\nexport function target() {\n  return 2;\n}\n",
		);
	});

	test("recovers guillemets used as brackets around old and new blocks", () => {
		// Real gpt-oss shape: « old » « new » — both blocks wrapped instead of
		// MATCH » REWRITE; literally it reads as two deletions.
		const content = "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n";
		const input = [
			M.open,
			"function alpha() {",
			"  return 1;",
			"}",
			M.put,
			M.open,
			"function alpha() {",
			"  return 42;",
			"}",
			M.put,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			"function alpha() {\n  return 42;\n}\nfunction beta() {\n  return 2;\n}\n",
		);
	});

	test("ignores a stray close-bracket separator after the final rewrite", () => {
		const content = "const value = 1;\n";
		const input = [M.open, "const value = 1;", M.put, "const value = 2;", M.put].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = 2;\n");
	});

	test("drops decoding noise between a split End sentinel and a Begin retry", () => {
		// Real degeneracy: `***` and ` End Patch` split across lines, spam text,
		// then a clean self-retry of the same edit in one payload.
		const content = "  if (globalThis.crypto.getRandomValues) {\n    use();\n  }\n";
		const payload = [
			"*** Begin Patch",
			"[uuid.ts]",
			M.open,
			`  if (globalThis.crypto.⟪getRandomValues│randomValues⟫) {`,
			"***",
			" End Patch",
			" stray commentary the model appended",
			"*** Begin Patch",
			"[uuid.ts]",
			M.open,
			`  if (globalThis.crypto.⟪getRandomValues│randomValues⟫) {`,
			"*** End Patch",
		].join("\n");
		const sections = splitSloppySections(payload);

		expect(sections.map(section => section.path)).toEqual(["uuid.ts"]);
		expect(variant.apply(content, sections[0].body, context)).toBe(
			"  if (globalThis.crypto.randomValues) {\n    use();\n  }\n",
		);
	});

	test("reads a bare selection in a rewrite-less op as the desired text", () => {
		// Models state only the replacement inside the markers (`i⟪--⟫`); with
		// no REWRITE the current span is captured as a gap and replaced.
		const content = "for (let i = 0; i < 100; i++) {\n  run(a, b);\n}\n";
		const input = [M.open, `for (let i = 0; i < 100; i⟪--⟫) {`, M.open, `  run(⟪b, a⟫);`].join("\n");

		expect(variant.apply(content, input, context)).toBe("for (let i = 0; i < 100; i--) {\n  run(b, a);\n}\n");
	});

	test("reads an added near-variant line as a replacement of its anchor", () => {
		// diff -/+ habit re-skinned with the add marker: same tokens, mutated
		// operators/order → replace; different tokens → genuine insert.
		const content = "    if (leafId !== null || !(await this.getEntry(leafId))) {\n";
		const input = inlineOperation(
			"    if (leafId !== null || !(await this.getEntry(leafId))) {\n＋    if (leafId !== null && !(await this.getEntry(leafId))) {",
		);

		expect(variant.apply(content, input, context)).toBe(
			"    if (leafId !== null && !(await this.getEntry(leafId))) {\n",
		);
	});

	test("keeps an added sibling line with different tokens as an insert", () => {
		const content = "anyhow = { workspace = true }\nitertools = { workspace = true }\n";
		const input = inlineOperation("itertools = { workspace = true }\n＋jiff = { workspace = true }");

		expect(variant.apply(content, input, context)).toBe(
			"anyhow = { workspace = true }\nitertools = { workspace = true }\njiff = { workspace = true }\n",
		);
	});

	test("returns the complete atomic payload when a marker-less operation needs a rewrite", () => {
		const content = "const a = 1;\nkeep();\n";
		const input = "§\nconst a = ⟪1│2⟫;\n§\nkeep();";
		let message = "";

		try {
			applySloppy(content, input, { path: "i.ts", notes: [] });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("Operation 2 needs ».");
		expect(message.match(/Copy-ready corrected payload/g)).toHaveLength(1);
		expect(message).toContain(
			"Copy-ready corrected payload (fill in the new text):\n§i.ts\nconst a = ⟪1│2⟫;\n§\nkeep();\n»\n<new text>",
		);
	});

	test("collapses back-to-back duplicates when desired text matches both copies", () => {
		// Ambiguity between two adjacent identical copies means dedup intent.
		const content = "fn() {\n  run(a);\n\n  run(a);\n}\n";
		const notes: string[] = [];

		expect(applySloppy(content, "§\n  run(a);", { path: "d.ts", notes })).toBe("fn() {\n  run(a);\n}\n");
		expect(notes.join("\n")).toMatch(/duplicate copy was collapsed/);
	});

	test("never rewrites part of a longer punctuation run", () => {
		// Regression: a tolerant match once produced `i+-` by replacing half of
		// `++`; partial-run candidates are invalid and the garble either resolves
		// fully or fails closed.
		const content = "for (i = 0; i < 9; i++) {\n";
		const out = applySloppy(content, "§\nfor (i = 0; i < 9; i⟪+│-⟫) {", { path: "x.ts", notes: [] });

		expect(out).toBe("for (i = 0; i < 9; i--) {\n");
	});

	test("treats candidates with whitespace-equivalent outcomes as unambiguous", () => {
		// Deleting either of two identical blank-separated copies yields the same
		// file; that is dedup, not ambiguity.
		const content = "open() {\n  work(unit);\n\n  work(unit);\n}\n";

		expect(applySloppy(content, "§\n⟪  work(unit);\n│⟫", { path: "d.ts", notes: [] })).toBe(
			"open() {\n  work(unit);\n}\n",
		);
	});

	test("applies marker-less desired text over its closest near-match block", () => {
		const content = "    if (!entryRow)\n      throw invalid();\n";
		const notes: string[] = [];

		expect(applySloppy(content, "§\n    if (entryRow)\n      throw invalid();", { path: "i.ts", notes })).toBe(
			"    if (entryRow)\n      throw invalid();\n",
		);
		expect(notes.join("\n")).toMatch(/closest matching block was replaced/);
	});

	test("applies a marker-less desired import line over its near-match", () => {
		// Regression: a stated desired line (one token added) bounced with a
		// fill-in "needs »" payload instead of replacing the existing line.
		const content = [
			'import { parseMCPToolName } from "../mcp";',
			'import type { ToolRenderer } from "./renderers";',
			"",
			"run();",
			"",
		].join("\n");
		const notes: string[] = [];
		const input = '§\nimport type { ToolActivitySummary, ToolRenderer } from "./renderers";';

		expect(applySloppy(content, input, { path: "xdev.ts", notes })).toBe(
			[
				'import { parseMCPToolName } from "../mcp";',
				'import type { ToolActivitySummary, ToolRenderer } from "./renderers";',
				"",
				"run();",
				"",
			].join("\n"),
		);
		expect(notes.join("\n")).toMatch(/closest matching block was replaced/);
	});

	test("keeps the fail-closed error when no block resembles the stated text", () => {
		const content = "const a = 1;\nkeep();\n";

		expect(() => applySloppy(content, "§\nawait fetchRemoteConfig(session);", { path: "i.ts", notes: [] })).toThrow(
			/needs »/,
		);
	});

	test("collapses a duplicated block stated once as mono desired text", () => {
		const content = "run(alpha);\nrun(alpha);\ndone();\n";

		expect(applySloppy(content, "§\nrun(alpha);\ndone();", { path: "m.ts" })).toBe("run(alpha);\ndone();\n");
	});

	test("recovers a unified-diff-shaped rewrite-less op as inline changes", () => {
		// Models under pressure emit their pretrained diff schema; -/+ runs become
		// selections, lone + runs bind to the context line above, @@ becomes a gap.
		const content = 'function greet(name) {\n  console.log("hi " + name);\n  return name;\n}\n';
		const input = [
			M.open,
			" function greet(name) {",
			'-  console.log("hi " + name);',
			'+  console.log("hello " + name);',
			"+  audit(name);",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			'function greet(name) {\n  console.log("hello " + name);\n  audit(name);\n  return name;\n}\n',
		);
	});

	test("binds a diff added-run to its context line and hunk markers to gaps", () => {
		const content = "alpha();\nbeta();\ngamma();\n";
		const input = [M.open, " alpha();", "+inserted();", "@@", "-gamma();", "+delta();"].join("\n");

		expect(variant.apply(content, input, context)).toBe("alpha();\ninserted();\nbeta();\ndelta();\n");
	});
	test("keeps a diff-shaped body away from missing-separator recovery", () => {
		// Regression: a uniquely matching context prefix let missing-» recovery
		// adopt the collapsed remainder as a rewrite — deleting the prefix,
		// writing the diff context gap `…` into the file literally, and leaving
		// the original block in place as a duplicate.
		const content = [
			"fn load() {",
			"\tlet mut items = Vec::new();",
			"\tfor entry in dir {",
			"\t\tlet parsed = entry.parse();",
			"\t\titems.push(parsed);",
			"\t}",
			"\titems.sort();",
			"\tOk(items)",
			"}",
			"",
		].join("\n");
		const input = [
			M.open,
			"fn load() {",
			"-\tlet mut items = Vec::new();",
			"+\tlet mut items = Vec::new();",
			"\tfor entry in dir {",
			M.gap,
			"-\t\titems.push(parsed);",
			"+\t\titems.push((entry.name(), parsed));",
			"\t}",
			"-\titems.sort();",
			"-\tOk(items)",
			"+\titems.sort_by_key(|(name, _)| name.clone());",
			"+\tOk(items.into_iter().map(|(_, item)| item).collect())",
			"}",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"fn load() {",
				"\tlet mut items = Vec::new();",
				"\tfor entry in dir {",
				"\t\tlet parsed = entry.parse();",
				"\t\titems.push((entry.name(), parsed));",
				"\t}",
				"\titems.sort_by_key(|(name, _)| name.clone());",
				"\tOk(items.into_iter().map(|(_, item)| item).collect())",
				"}",
				"",
			].join("\n"),
		);
	});

	test("clamps a bare desired selection at line end to its own line", () => {
		// Regression: the captured gap ran past the newline and spliced two lines
		// together while reporting success.
		const content = "    ? avlue\n    : typeof value === 'object' &&\n";
		const input = inlineOperation("    ? ⟪avlue⟫\n    : typeof value === 'object' &&");

		expect(() => variant.apply(content, input, context)).toThrow(/makes no change/);
	});

	test("notes an insert that duplicates adjacent lines", () => {
		const content = "import { a } from './a';\nimport { b } from './b';\nrun();\n";
		const input = inlineOperation(
			"import { a } from './a';\nimport { b } from './b';\n＋import { b } from './b';\n＋import { a } from './a';",
		);
		const notes: string[] = [];

		variant.apply(content, input, { path: "i.ts", notes });
		expect(notes.join("\n")).toMatch(/duplicate adjacent code/);
	});

	test("reads § section openers natively, bare § continuing in the same file", () => {
		const payload = [
			"§src/config.ts",
			`const timeout = ⟪1000│5000⟫;`,
			"§",
			`const retries = ⟪3│5⟫;`,
			"§*src/catalog.ts",
			`logger.⟪debug│trace⟫(`,
		].join("\n");
		const sections = splitSloppySections(payload);

		expect(sections.map(section => section.path)).toEqual(["src/config.ts", "src/catalog.ts"]);
		expect(sections[0].body).toContain(`${M.open}\nconst timeout`);
		expect(sections[0].body).toContain(`${M.open}\nconst retries`);
		expect(sections[1].body.startsWith(`${M.open}*`)).toBe(true);
	});

	test("voices sloppy errors with § openers and keeps the rewrite separator", () => {
		let message = "";
		try {
			applySloppy("const x = 1;\n", "§\nconst y = 2;\nconst y = 3;", context);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("§");
		expect(message).not.toContain(M.open);
		expect(message).toContain(M.put);
	});

	test("splits sections from a payload wrapped in a patch envelope", () => {
		// Constrained decoding emits *** Begin/End Patch sentinels; the splitter
		// must strip them before the first-line header check.
		const payload = [
			"*** Begin Patch",
			"[src/a.ts]",
			M.open,
			"const x = 1;",
			M.put,
			"const x = 2;",
			"*** End Patch",
		].join("\n");

		expect(splitSloppySections(payload).map(section => section.path)).toEqual(["src/a.ts"]);
	});

	test("trims whitespace inside a section header path", () => {
		const sections = splitSloppySections("[ index.ts ]\n{M.open}".replace("{M.open}", M.open));
		expect(sections.map(section => section.path)).toEqual(["index.ts"]);
	});

	test("recovers selections trailing their own retyped line with elided lines between", () => {
		// Real gpt-oss payload shape: each edited line retyped whole with the fix
		// annotated as a trailing selection, unchanged lines elided without gaps.
		const content =
			"while (true) {\n  const newlineIndex = buffer.indexOf(x);\n  if (enwlineIndex === -1) {\n    return;\n  }\n  buffer = buffer.slice(enwlineIndex + 1);\n}\n";
		const input = inlineOperation(
			"  const newlineIndex = buffer.indexOf(x);\n  if (enwlineIndex === -1) {⟪enwlineIndex│newlineIndex⟫\n  }\n  buffer = buffer.slice(enwlineIndex + 1);⟪enwlineIndex│newlineIndex⟫",
		);

		expect(variant.apply(content, input, context)).toBe(
			"while (true) {\n  const newlineIndex = buffer.indexOf(x);\n  if (newlineIndex === -1) {\n    return;\n  }\n  buffer = buffer.slice(newlineIndex + 1);\n}\n",
		);
	});

	test("lands a trailing insert-only selection line on its own line", () => {
		// Regression: `⟪│new⟫` alone after the last anchor glued into it
		// (`itertools = { workspace = true }jiff = { workspace = true }`).
		const content = "im = { workspace = true }\nitertools = { workspace = true }\nnext = { workspace = true }\n";
		const input = inlineOperation("itertools = { workspace = true }\n⟪│jiff = { workspace = true }⟫");

		expect(variant.apply(content, input, context)).toBe(
			"im = { workspace = true }\nitertools = { workspace = true }\njiff = { workspace = true }\nnext = { workspace = true }\n",
		);
	});

	test("lands a multi-line insert selection before a blank line on its own line", () => {
		// Regression: a selection whose desired text carried its own newline
		// glued into the anchor and doubled the following blank line.
		const content = "Copyright (c) 2025 First Author\nCopyright (c) 2026 Second Author\n\nPermission is granted\n";
		const input = inlineOperation("Copyright (c) 2026 Second Author\n⟪│Copyright (c) 2026 Third Author\n⟫");

		expect(variant.apply(content, input, context)).toBe(
			"Copyright (c) 2025 First Author\nCopyright (c) 2026 Second Author\nCopyright (c) 2026 Third Author\n\nPermission is granted\n",
		);
	});

	test("opens a new line for an insert after the last line of a file without a trailing newline", () => {
		const content = "alpha = 1\nomega = 2";
		const input = inlineOperation("omega = 2\n⟪│zeta = 3⟫");

		expect(variant.apply(content, input, context)).toBe("alpha = 1\nomega = 2\nzeta = 3");
	});

	test("applies inline insertion and deletion as independent operations", () => {
		const content = "const timeout = 5000;\nconst debug = true;\nrun();\n";
		const input = [
			inlineOperation("const timeout = 5000;\n⟪│\nconst retries = 3;⟫"),
			inlineOperation("⟪const debug = true;│⟫"),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const timeout = 5000;\nconst retries = 3;\nrun();\n");
	});

	test("applies an inline all-match replacement", () => {
		const content = "logger.debug(first);\nlogger.debug(second);\n";

		expect(variant.apply(content, inlineOperation("logger.⟪debug│trace⟫(", true), context)).toBe(
			"logger.trace(first);\nlogger.trace(second);\n",
		);
	});

	test("reuses an inline deletion register in a later inline insertion", () => {
		const content = "const moved = createMoved();\nbefore();\nafter();\n";
		const input = [
			inlineOperation("⟪const moved = createMoved();│⟫"),
			inlineOperation("before();\n⟪│\n»1\n⟫\nafter();"),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("before();\nconst moved = createMoved();\nafter();\n");
	});

	test("ignores a stray glued open+separator terminator after an explicit empty rewrite", () => {
		const content = ["const keep = 1;", "function helper() {", "  return 2;", "}", ""].join("\n");
		const input = ["function helper() {", "  return 2;", "}"].join("\n");

		expect(variant.apply(content, `${M.open}\n${input}\n${M.put}\n${M.open}${M.put}`, context)).toBe(
			"const keep = 1;\n",
		);
	});

	test("treats a glued open+separator after MATCH as the mistyped rewrite separator", () => {
		const content = "const value = oldValue;\n";
		const input = [M.open, "const value = oldValue;", `${M.open}${M.put}`, "const value = nextValue;"].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = nextValue;\n");
	});

	test("ignores a stray ⟫ terminator after the mistyped ⟫ separator", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const input = [
			M.open,
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"⟫",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"⟫",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("treats a lone balanced ⟫ line as the mistyped rewrite separator", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const input = [
			M.open,
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"⟫",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"    }",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("drops an echoed literal before an inline selection", () => {
		const content = [
			"const newlineIndex = stdinBuffer.indexOf('n');",
			"if (enwlineIndex === -1) return;",
			"const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"",
		].join("\n");

		expect(variant.apply(content, inlineOperation("enwlineIndex⟪enwlineIndex│newlineIndex⟫", true), context)).toBe(
			content.replaceAll("enwlineIndex", "newlineIndex"),
		);
	});

	test("drops an echoed anchor line before a deletion selection", () => {
		const content = ["function parse(value: unknown) {", "// exact replacement", "  return value;", "}", ""].join(
			"\n",
		);
		const input = inlineOperation("// exact replacement\n⟪// exact replacement\n│⟫");

		expect(variant.apply(content, input, context)).toBe(
			["function parse(value: unknown) {", "  return value;", "}", ""].join("\n"),
		);
	});

	test("still deletes one of two adjacent duplicate lines without echo dedup", () => {
		const content = ["reportStatus();", "reportStatus();", "finish();", ""].join("\n");
		const input = inlineOperation("reportStatus();\n⟪reportStatus();\n│⟫");

		expect(variant.apply(content, input, context)).toBe(["reportStatus();", "finish();", ""].join("\n"));
	});

	test("hands back a fill-in skeleton for a truncated »N rewrite without echoing the broken payload", () => {
		const content = "const first = enwlineIndex;\n";
		let message = "";

		try {
			variant.apply(content, `${M.open}*\nenwlineIndex\n${M.put}1`, context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toMatch(
			/reads as the » separator, leaving REWRITE empty[\s\S]*«\*\nenwlineIndex\n»\n<final text>/,
		);
		expect(message).not.toContain(`enwlineIndex\n${M.put}1`);
	});

	test("treats every lone »N separator as » across a multi-op payload", () => {
		const content = ["const first = avlue;", "report(avlue.models);", "check(typeof avlue);", ""].join("\n");
		const input = [
			`${M.open}\nconst first = avlue;\n${M.put}1\nconst first = value;`,
			`${M.open}\nreport(avlue.models);\n${M.put}1\nreport(value.models);`,
			`${M.open}\ncheck(typeof avlue);\n${M.put}1\ncheck(typeof value);`,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("avlue", "value"));
	});

	test("treats a lone self-referencing »N after MATCH as the rewrite separator", () => {
		const content = "const first = avlue;\nconst second = avlue;\n";
		const input = `${M.open}*\navlue\n${M.put}1\nvalue`;

		expect(variant.apply(content, input, context)).toBe("const first = value;\nconst second = value;\n");
	});

	test("ignores a trailing self-referencing »N after an inline operation", () => {
		const content = "  switch (reason) {\n    case 'pause_turn':\n      return 'stop';\n  }\n";
		const input = `${M.open}\n  switch (reason) {\n    ⟪case 'pause_turn':│case 'end_turn':\n    case 'pause_turn':⟫\n${M.put}1`;

		expect(variant.apply(content, input, context)).toBe(
			"  switch (reason) {\n    case 'end_turn':\n    case 'pause_turn':\n      return 'stop';\n  }\n",
		);
	});

	test("strips a bare // annotation line from the top of a REWRITE", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const rewrite = [
			"//",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"    }",
		].join("\n");
		const pattern = content.trimEnd();

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("keeps a worded comment line at the top of a REWRITE", () => {
		const content = "return cached;\n";

		expect(variant.apply(content, operation("return cached;", "// Fast path\nreturn cached;"), context)).toBe(
			"// Fast path\nreturn cached;\n",
		);
	});

	test("relocates an anchored selection line even when it would fuzzy-match elsewhere", () => {
		const content = [
			"function fillRandomBytes(bytes) {",
			"  if (globalThis.crypto.getRandomValues) {",
			"    globalThis.crypto?.getRandomValues(bytes);",
			"  }",
			"}",
			"",
		].join("\n");
		const input = [
			inlineOperation(
				"  if (globalThis.crypto.getRandomValues) {\n⟪globalThis.crypto.getRandomValues│globalThis.crypto?.getRandomValues⟫",
			),
			inlineOperation(
				"    globalThis.crypto?.getRandomValues(bytes);\n⟪globalThis.crypto?.getRandomValues│globalThis.crypto.getRandomValues⟫",
			),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function fillRandomBytes(bytes) {",
				"  if (globalThis.crypto?.getRandomValues) {",
				"    globalThis.crypto.getRandomValues(bytes);",
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});

	test("relocates a selection-only line into its echoed anchor line", () => {
		const content = "      .run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));\n";
		const input = inlineOperation(
			"      .run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));\n      ⟪materializedStateValues(createEmptyMaterializedState(), options.sessionId)│materializedStateValues(options.sessionId, createEmptyMaterializedState())⟫",
		);

		expect(variant.apply(content, input, context)).toBe(
			"      .run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));\n",
		);
	});

	test("drops an echoed anchor line above an embedded selection", () => {
		const content = "    if (entryRow)\n      throw invalidSession(entryId);\n";
		const input = inlineOperation("    if (entryRow)\n    if (⟪entryRow│!entryRow⟫)");

		expect(variant.apply(content, input, context)).toBe("    if (!entryRow)\n      throw invalidSession(entryId);\n");
	});

	test("trims a boundary character double-typed between literal and selection", () => {
		const content = "  if (globalThis.crypto.? .getRandomValues) {\n    globalThis.crypto.getRandomValues(bytes);\n";
		const input = inlineOperation("  if (globalThis.crypto.⟪.? .get│?.get⟫RandomValues) {");

		expect(variant.apply(content, input, context)).toBe(
			"  if (globalThis.crypto.?.getRandomValues) {\n    globalThis.crypto.getRandomValues(bytes);\n",
		);
	});

	test("treats a sole trailing empty inline selection as whole-match deletion", () => {
		const content = [
			"  prepare();",
			"",
			"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
			"    const match = ansi.match(/x/);",
			"    return match ? [1, 2, 3] : null;",
			"  };",
			"",
			"  run();",
			"",
		].join("\n");
		const input = inlineOperation(
			[
				"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
				"    const match = ansi.match(/x/);",
				"    return match ? [1, 2, 3] : null;",
				"  };",
				"⟪│⟫",
			].join("\n"),
		);

		expect(variant.apply(content, input, context)).toBe(["  prepare();", "", "  run();", ""].join("\n"));
	});

	test("keeps a genuine empty inline insertion anchored to a neighbor line as a no-op error", () => {
		const content = "before();\nafter();\n";

		expect(() => variant.apply(content, inlineOperation("⟪│⟫before();"), context)).toThrow(/makes no change/);
	});

	test("collapses a duplicated block when the rewrite equals the match", () => {
		const block = "  await db.exec(`\nCREATE TABLE IF NOT EXISTS migrations (\n\tid TEXT PRIMARY KEY\n);\n`);";
		const content = `async function ensureMigrationsTable() {\n${block}\n\n${block}\n}\n`;
		const input = operation(`${block}\n}`, `${block}\n}`);

		expect(variant.apply(content, input, context)).toBe(`async function ensureMigrationsTable() {\n${block}\n}\n`);
	});

	test("applies a pattern-only block as the delete half of a move", () => {
		const block = [
			"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
			"    return null;",
			"  };",
		].join("\n");
		const content = `  const first = 0;\n\n${block}\n\n  const other = 1;\n\n  const getContrast = () => 2;\n`;
		const input = [
			`${M.open}\n${block}`,
			`${M.open}\n  const getContrast = () => 2;\n${M.put}\n${block}\n\n  const getContrast = () => 2;`,
		].join("\n");
		const notes: string[] = [];

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			`  const first = 0;\n\n  const other = 1;\n\n${block}\n\n  const getContrast = () => 2;\n`,
		);
		expect(notes.join("\n")).toContain("move deletion");
	});

	test("never adopts a gap-only remainder as rewrite text", () => {
		const content = [
			"  const getContrastVsBlack = (colorName: string): string => {",
			"    const ansi = theme.getFgAnsi(colorName);",
			"    return ansi;",
			"  };",
			"",
		].join("\n");
		const input = `${M.open}\n  const getContrastVsBlack = (colorName: string): string => {\n…`;

		expect(() => variant.apply(content, input, context)).toThrow(/needs »/);
	});

	test("still rejects a pattern-only block no other operation re-emits", () => {
		const content = "  const kept = 1;\n  const alpha = compute();\n  const beta = alpha + 1;\n";
		const input = `${M.open}\n  const alpha = compute();\n  const beta = alpha + 1;`;

		expect(() => variant.apply(content, input, context)).toThrow(/needs »/);
	});

	test("reports deletions in apply notes", () => {
		const content = "keep();\ndebugLog(request);\nfinish();\n";
		const notes: string[] = [];

		expect(variant.apply(content, operation("debugLog(request);", ""), { path: context.path, notes })).toBe(
			"keep();\nfinish();\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 deleted 1 line/i);
	});

	test("gap-joins listed-only lines that are not consecutive", () => {
		const content = [
			"      if (enwlineIndex === -1) {",
			"        return;",
			"      }",
			"      const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"      stdinBuffer = stdinBuffer.slice(enwlineIndex + 1);",
			"",
		].join("\n");
		const input = inlineOperation(
			[
				"      if (⟪enwlineIndex│newlineIndex⟫ === -1) {",
				"      const line = stdinBuffer.slice(0, ⟪enwlineIndex│newlineIndex⟫).trim();",
				"      stdinBuffer = stdinBuffer.slice(⟪enwlineIndex│newlineIndex⟫ + 1);",
			].join("\n"),
			true,
		);

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("enwlineIndex", "newlineIndex"));
	});

	test("names identical inline sides in the no-op error", () => {
		const content = "const flag = a || b;\n";

		expect(() => variant.apply(content, inlineOperation("const flag = ⟪a || b│a || b⟫;"), context)).toThrow(
			/identical ⟪current│desired⟫ sides never change the file[\s\S]*do not drop the operation/,
		);
	});

	test("drops a » rewrite that restates an inline replacement's result", () => {
		const content = "const value = oldValue;\nconst other = keep;\n";
		const notes: string[] = [];
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}\nconst value = newValue;`;

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			"const value = newValue;\nconst other = keep;\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 combined [\s\S]* REWRITE only restated the inline result/);
	});

	test("drops a » rewrite that only echoes the desired sides", () => {
		const content = "url = https://a.example/repo.git\n";
		const input = `${inlineOperation("url = ⟪https://a.example/repo.git│https://b.example/repo.git⟫")}\n${M.put}\nhttps://b.example/repo.git`;

		expect(variant.apply(content, input, context)).toBe("url = https://b.example/repo.git\n");
	});

	test("drops an empty » rewrite trailing an inline replacement", () => {
		const content = "const value = oldValue;\n";
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("applies a diverging » rewrite as final text over the inline current sides", () => {
		const content = "const value = oldValue;\nconst other = keep;\n";
		const notes: string[] = [];
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}\nconst value = newValue; // updated\nconst added = 1;`;

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			"const value = newValue; // updated\nconst added = 1;\nconst other = keep;\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 combined [\s\S]* applied as the final text/);
	});

	test("applies a bare selection beside inline pairs as desired text", () => {
		// In a rewrite-less op a bare ⟪X⟫ states the desired text; the current
		// span is captured as a gap and replaced.
		const content = "const value = oldValue;\nconst other = oldOther;\n";
		const input = inlineOperation("const value = ⟪oldValue│newValue⟫;\nconst other = ⟪newOther⟫;");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\nconst other = newOther;\n");
	});

	test("substitutes multiple selections positionally when REWRITE has one line per selection", () => {
		const content = [
			"while (true) {",
			"  const newlineIndex = stdinBuffer.indexOf('\\n');",
			"  if (enwlineIndex === -1) {",
			"    return;",
			"  }",
			"  const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"  stdinBuffer = stdinBuffer.slice(enwlineIndex + 1);",
			"  if (!line) continue;",
			"}",
			"",
		].join("\n");
		const input = operation(
			[
				"  if (⟪enwlineIndex⟫ === -1) {",
				"    return;",
				"  }",
				"  const line = stdinBuffer.slice(0, ⟪enwlineIndex⟫).trim();",
				"  stdinBuffer = stdinBuffer.slice(⟪enwlineIndex⟫ + 1);",
			].join("\n"),
			"newlineIndex\nnewlineIndex\nnewlineIndex",
		);

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("enwlineIndex", "newlineIndex"));
	});

	test("uses whole-line ellipses as positional separators when the pattern has no gaps", () => {
		const content = ["if (avlue === first) use(avlue);", "const second = avlue;", ""].join("\n");
		const pattern = ["if (⟪avlue⟫ === first) use(⟪avlue⟫);", "const second = ⟪avlue⟫;"].join("\n");

		expect(variant.apply(content, operation(pattern, "value\n…\nvalue\n…\nvalue"), context)).toBe(
			content.replaceAll("avlue", "value"),
		);
	});

	test("supports multi-line positional groups separated by whole-line ellipses", () => {
		const content = "const first = oldA;\nconst second = oldB;\n";
		const pattern = "const first = ⟪oldA⟫;\nconst second = ⟪oldB⟫;";
		const rewrite = "computeA(\n  input,\n)\n…\ncomputeB(\n  input,\n)";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"const first = computeA(\n  input,\n);\nconst second = computeB(\n  input,\n);\n",
		);
	});

	test("fails closed on whole-line rewrite ellipses when a multi-selection pattern has gaps", () => {
		const content = "first oldA extra\nsecond oldB\nthird oldC\n";
		const pattern = "first ⟪oldA⟫…\nsecond ⟪oldB⟫\nthird ⟪oldC⟫";
		const input = operation(pattern, "newA\n…\nnewC");

		expect(() => variant.apply(content, input, context)).toThrow(
			/has 3 selections, but REWRITE proves neither positional substitution nor whole-span replacement/,
		);
	});

	test("allows proven whole-span replacement for multiple selections", () => {
		const content = "if (oldA) {\n  keep();\n  return oldB;\n}\n";
		const pattern = "if (⟪oldA⟫) {\n  keep();\n  return ⟪oldB⟫;";
		const rewrite = "if (newA) {\n  keep();\n  return newB;";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"if (newA) {\n  keep();\n  return newB;\n}\n",
		);
	});

	test("fails closed on a whole-line rewrite gap when the pattern captured none", () => {
		// Regression: an explicit » rewrite with `…` context elision against a
		// gapless MATCH wrote literal `…` lines into the file and duplicated the
		// blocks the gaps had elided.
		const content = "use std::time::Duration;\n\nfn combined() {}\n";
		const input = operation("use std::time::Duration;", "use std::{sync::Arc, time::Duration};\n…\nfn combined() {}");

		expect(() => variant.apply(content, input, context)).toThrow(/whole-line … with no MATCH gap to re-emit/);
	});

	test("fails closed when a multi-selection rewrite proves neither interpretation", () => {
		const content = "const pair = oldA + oldB;\n";
		const input = operation("const pair = ⟪oldA⟫ + ⟪oldB⟫;", "newValue");

		expect(() => variant.apply(content, input, context)).toThrow(
			/Copy-ready per-selection interpretation:[\s\S]*Copy-ready whole-span interpretation:[\s\S]*No operations were applied — ops apply atomically/,
		);
	});

	test("re-emits selected gaps positionally without retyping their spans", () => {
		const content = [
			"function loadUser(id: string) {",
			"  const cached = cache.get(id);",
			"  if (cached) return cached;",
			"  const user = legacyStore.read(id);",
			"  return user;",
			"}",
			"",
		].join("\n");
		const pattern =
			`loadUser(${M.gap}\n  ${M.selectOpen}const cached = ${M.gap}\n` +
			`  const user = legacyStore.read(${M.gap});\n  return user;${M.selectClose}\n${M.gap}}`;
		const rewrite = `const cached = ${M.gap}\n  const user = await database.users.read(${M.gap});\n  return user;`;

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			[
				"function loadUser(id: string) {",
				"  const cached = cache.get(id);",
				"  if (cached) return cached;",
				"  const user = await database.users.read(id);",
				"  return user;",
				"}",
				"",
			].join("\n"),
		);
	});
	test("allows zero rewrite gaps to replace a selection containing gaps", () => {
		const content = "function choose() {\n  if (legacy) {\n    return oldValue;\n  }\n}\n";
		const pattern = "choose() …\n⟪if (legacy) {…\nreturn oldValue;…\n}⟫\n…}";

		expect(variant.apply(content, operation(pattern, "return newValue;"), context)).toBe(
			"function choose() {\n  return newValue;\n}\n",
		);
	});

	test("preserves a large region outside a tiny selection", () => {
		const middle = Array.from({ length: 30 }, (_, index) => `  step${index}();`).join("\n");
		const content = `class ReportBuilder {\n${middle}\n  render(legacyFormatter);\n  finalize(report);\n}\n`;
		const pattern = "class ReportBuilder …\nrender(…⟪legacyFormatter⟫…\nfinalize(";

		expect(variant.apply(content, operation(pattern, "streamingFormatter"), context)).toBe(
			content.replace("legacyFormatter", "streamingFormatter"),
		);
	});

	test("inserts add lines at their authored tab depth", () => {
		const content = "function dispatch(request: Request) {\n\treturn send(request);\n}\n";
		const input = inlineOperation(
			"function dispatch(request: Request) {\n＋\tvalidate(request);\n\treturn send(request);",
		);

		expect(variant.apply(content, input, context)).toBe(
			"function dispatch(request: Request) {\n\tvalidate(request);\n\treturn send(request);\n}\n",
		);
	});
	test("keeps a same-line insertion inline", () => {
		const content = "const value = compute(input);\nreport(value);\n";
		const pattern = "const value = …⟪⟫compute(input)…\nreport(value)";

		expect(variant.apply(content, operation(pattern, "await "), context)).toBe(
			"const value = await compute(input);\nreport(value);\n",
		);
	});

	test("deletes a selected whole line including indentation and newline", () => {
		const content = "function runTask() {\n  prepare();\n  debugLog(request);\n  return result;\n}\n";
		const pattern = "runTask(…\n⟪debugLog(request);⟫…\nreturn result";

		expect(variant.apply(content, operation(pattern, ""), context)).toBe(
			"function runTask() {\n  prepare();\n  return result;\n}\n",
		);
	});

	test("applies a non-overlapping batch and accepts an EOF transport newline", () => {
		const content = "const status = oldStatus;\nreport(status);\ndebugLog(status);\nfinish(status);\n";
		const first = operation("const status …⟪oldStatus⟫…\nreport(status)", "newStatus");
		const second = operation("report(status)…\n⟪debugLog(status);⟫…\nfinish(status)", "");

		expect(variant.apply(content, `${first}\n${second}\n`, context)).toBe(
			"const status = newStatus;\nreport(status);\nfinish(status);\n",
		);
	});

	test("checks ordered-tuple uniqueness before choosing a match", () => {
		const content = [
			"function first() {",
			"  return value;",
			"  audit();",
			"}",
			"function second() {",
			"  return value;",
			"  audit();",
			"}",
			"",
		].join("\n");
		const input = operation("function …\n⟪return value;⟫…\naudit();", "return nextValue;");

		expect(() => variant.apply(content, input, context)).toThrow(
			new RegExp(
				String.raw`ambiguous: 2 ordered tuples match[\s\S]*retry every match:\n${esc(M.open)}\*[\s\S]*Add context that only the intended match has`,
			),
		);
	});

	test("ambiguity retries carry a distinguishing context line, not an ordinal", () => {
		const content = [
			"function first() {",
			"  return value;",
			"  audit();",
			"}",
			"function second() {",
			"  return value;",
			"  audit();",
			"}",
			"",
		].join("\n");
		let message = "";

		try {
			variant.apply(content, operation("⟪return value;⟫…\naudit();", "return nextValue;"), context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		// The later match gets a leading anchor; the earlier one has nothing
		// unique above it, so it gets a trailing anchor instead. Both resolve uniquely.
		expect(message).toContain("function second() {…\n⟪return value;⟫");
		expect(message).toContain("audit();\n…\nfunction second() {");
		// And the suggested payload is directly applicable.
		expect(
			variant.apply(
				content,
				operation("function second() {…\n⟪return value;⟫…\naudit();", "return nextValue;"),
				context,
			),
		).toBe(
			[
				"function first() {",
				"  return value;",
				"  audit();",
				"}",
				"function second() {",
				"  return nextValue;",
				"  audit();",
				"}",
				"",
			].join("\n"),
		);
	});

	test("rejects a numbered opener and names the two valid openers", () => {
		const content = "function first() {\n  return value;\n}\n";
		const input = `${M.open}2\nreturn value;\n${M.put}\nreturn nextValue;`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`${esc(M.open)}2 is not a valid opener`));
	});

	test("applies the all-match opener to every match with one identical rewrite", () => {
		const content = "const first = avlue;\nconst second = avlue;\nconst third = avlue;\n";
		const input = `${M.open}*\n= ⟪avlue⟫;\n${M.put}\nvalue`;

		expect(variant.apply(content, input, context)).toBe(
			"const first = value;\nconst second = value;\nconst third = value;\n",
		);
	});

	test("reports zero matches for the all-match opener without guessing", () => {
		const content = "const value = presentValue;\n";
		const input = `${M.open}*\n= ⟪missingValue⟫;\n${M.put}\nnextValue`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`${esc(M.open)}\\* found 0 matches`));
	});

	test("preserves skipped rows for corresponding non-consecutive rewrites", () => {
		const content = [
			"const entries = source",
			"  ? avlue",
			"  : typeof value === 'object' &&",
			"      Array.isArray(value.models)",
			"    ? avlue.models",
			"    : typeof avlue === 'object'",
			"",
		].join("\n");
		const input = operation(
			"  ? avlue\n    ? avlue.models\n    : typeof avlue === 'object'",
			"  ? value\n    ? value.models\n    : typeof value === 'object'",
		);

		expect(variant.apply(content, input, context)).toBe(
			[
				"const entries = source",
				"  ? value",
				"  : typeof value === 'object' &&",
				"      Array.isArray(value.models)",
				"    ? value.models",
				"    : typeof value === 'object'",
				"",
			].join("\n"),
		);
	});
	test("accepts a small fragment typo only when the fuzzy tuple is unique", () => {
		const content = "const result = calculateValue(input);\nreport(result);\n";
		const pattern = "const result = …⟪calculateVale(input)⟫…\nreport(result)";

		expect(variant.apply(content, operation(pattern, "calculateFast(input)"), context)).toBe(
			"const result = calculateFast(input);\nreport(result);\n",
		);
	});

	test("normalizes Unicode punctuation in sparse literals", () => {
		const content = 'throw new Error("not-ready");\nhandleFailure(error);\n';
		const pattern = "throw new Error(⟪“not—ready”⟫);…\nhandleFailure(";

		expect(variant.apply(content, operation(pattern, '"ready"'), context)).toBe(
			'throw new Error("ready");\nhandleFailure(error);\n',
		);
	});

	test("maps provided rewrite gaps positionally and drops omitted later gaps", () => {
		const content = "function load() {\n  const a = first();\n  const b = legacy(id);\n}\n";
		const pattern =
			`load() ${M.gap}\n  ${M.selectOpen}const a = ${M.gap}\n` +
			`  const b = legacy(${M.gap});${M.selectClose}\n${M.gap}}`;
		const rewrite = `const a = ${M.gap}\n  const b = modern(id);`;

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"function load() {\n  const a = first();\n  const b = modern(id);\n}\n",
		);
	});
	test("accepts marker-free verbatim replacement", () => {
		const content = "const timeout = 1000;\nrun(timeout);\n";
		const pattern = "const timeout = 1000;";

		expect(variant.apply(content, operation(pattern, "const timeout = 5000;"), context)).toBe(
			"const timeout = 5000;\nrun(timeout);\n",
		);
	});

	test("accepts a unique single-fragment sparse selection", () => {
		const content = "const value = oldValue;\n";

		expect(variant.apply(content, operation("⟪oldValue⟫", "nextValue"), context)).toBe("const value = nextValue;\n");
	});

	test("rejects punctuation-only patterns but accepts short identifiers", () => {
		// Punctuation-only anchors match everywhere — still rejected.
		expect(() => variant.apply("if (a) {\n}\n", operation("⟪}⟫", "};"), context)).toThrow(/too generic/);
		// A short identifier is a legitimate anchor when it resolves uniquely.
		expect(variant.apply("const id = 1;\n", operation("⟪id⟫ = 1", "key"), context)).toBe("const key = 1;\n");
	});

	test("reports unmatched literals without guessing", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const pattern = "const value = …⟪missingValue⟫…\nreport(value)";

		expect(() => variant.apply(content, operation(pattern, "nextValue"), context)).toThrow(/did not match/);
	});

	test("grounds no-match failures with closest current lines and atomic retry guidance", () => {
		const content = [
			"import { fetchCurrent } from './data';",
			"",
			"function load() {",
			"  prepare();",
			"  const result = fetchCurrent();",
			"  audit(result);",
			"  return result;",
			"}",
			"",
			"export { load };",
			"finish();",
			"",
		].join("\n");
		const input = operation(
			"function load() {…\n⟪const result = fetchLegacy();⟫…\nreturn result;\n}",
			"const result = fetchCurrent();",
		);

		expect(() => variant.apply(content, input, context)).toThrow(
			/Failed fragment: "const result = fetchLegacy\(\);" has 0 occurrences\.[\s\S]*Current file content near the closest match \(no re-read needed\):[\s\S]*5: {3}const result = fetchCurrent\(\);[\s\S]*7: {3}return result;[\s\S]*Copy-ready corrected operation:[\s\S]*No operations were applied — ops apply atomically; re-send the full corrected payload\./,
		);
	});

	test("labels a fuzzy no-match anchor as non-copyable instead of guessing a corrected operation", () => {
		const content = "single: 1;\nreal: 2;\n";
		const input = `${M.open}\nreal: ⟪2│TWO⟫;\n${M.open}\nnope: ⟪nothing│X⟫;`;

		let message = "";
		try {
			variant.apply(content, input, { path: "bt.txt" });
		} catch (error) {
			message = (error as Error).message;
		}

		// The unmatched op is named and grounded in current file content.
		expect(message).toMatch(/Operation 2 did not match bt\.txt\. Failed fragment: "nope:" has 0 occurrences\./);
		// No fabricated retry: the guess `ngle:` (a sliver of `single:`) never appears,
		// and the block is not mislabeled copy-ready when it would drop the sibling op.
		expect(message).not.toContain(`ngle:${M.selectOpen}`);
		expect(message).not.toContain("Copy-ready corrected operation:");
		expect(message).toContain("No copy-ready correction");
		expect(message).toContain(
			"No operations were applied — ops apply atomically; re-send the full corrected payload.",
		);
	});

	test("does not label a partial retry copy-ready when an atomic payload has sibling operations", () => {
		const content = [
			"real: 2;",
			"function load() {",
			"  const result = fetchCurrent();",
			"  return result;",
			"}",
			"",
		].join("\n");
		const input = `${M.open}\nreal: ⟪2│TWO⟫;\n${M.open}\nfunction load() {…\n⟪const result = fetchLegacy();│const result = fetchCurrent();⟫…\nreturn result;\n}`;

		let message = "";
		try {
			variant.apply(content, input, { path: "bt.txt" });
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).not.toContain("Copy-ready corrected operation:");
		expect(message).toContain("retrying this operation alone would drop sibling operations");
		expect(message).toContain(
			"No operations were applied — ops apply atomically; re-send the full corrected payload.",
		);
	});

	test("teaches insert intent when MATCH is text the author meant to add", () => {
		const content = ["switch (event.type) {", "  case 'message':", "    handleMessage(event);", "}", ""].join("\n");
		const input = operation("  case 'end_turn':", "  case 'end_turn':\n    finishTurn();");

		expect(() => variant.apply(content, input, context)).toThrow(
			new RegExp(
				String.raw`If you are ADDING this text: match the existing neighbor line it belongs next to, and put the new text in the REWRITE —[\s\S]*${esc(M.open)}\n⟪⟫ {2}case 'message':\n${esc(M.put)}\n {2}case 'end_turn':\n {4}finishTurn\(\);`,
			),
		);
	});

	test("rejects malformed envelopes, marker misuse, and no-op edits", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const pattern = "const value = …⟪oldValue⟫…\nreport(value)";

		expect(() => variant.apply(content, `${M.open}\nreport(value)`, context)).toThrow(
			new RegExp(`needs ${esc(M.put)}`),
		);
		expect(() => variant.apply(content, `${operation(pattern, "nextValue")}\n${M.open} end`, context)).toThrow(
			new RegExp(`Operation 2 needs ${esc(M.put)}`),
		);
		expect(() => variant.apply(content, operation(pattern, "⟪oldValue⟫"), context)).toThrow(
			/has selection markers in REWRITE/,
		);
		expect(variant.apply(content, operation(pattern, "next…Value"), context)).toBe(
			"const value = next…Value;\nreport(value);\n",
		);
		expect(() => variant.apply(content, operation(pattern, "oldValue"), context)).toThrow(/makes no change/);
	});

	test("splits a rewrite separator glued to its first content line", () => {
		const content = [
			"function mapStopReason(reason: string) {",
			"  switch (reason) {",
			"    case 'pause_turn':",
			"      return 'stop';",
			"  }",
			"}",
			"",
		].join("\n");
		const input = [M.open, "    case 'pause_turn':", `${M.put}    case 'end_turn':`, "    case 'pause_turn':"].join(
			"\n",
		);

		expect(variant.apply(content, input, context)).toBe(
			[
				"function mapStopReason(reason: string) {",
				"  switch (reason) {",
				"    case 'end_turn':",
				"    case 'pause_turn':",
				"      return 'stop';",
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});
	test("preserves authored depth after an indented glued rewrite separator", () => {
		// The separator split retains the two authored leading spaces; the
		// rewrite engine does not infer depth from the matched class member.
		const content = "class T {\n  private _kittyProtocolActive = true;\n}\n";
		const input = "§t.ts\n  private _kittyProtocolActive = true;\n  »  private _kittyProtocolActive = false;";

		expect(applySloppy(content, input, { path: "t.ts", notes: [] })).toBe(
			"class T {\n  private _kittyProtocolActive = false;\n}\n",
		);
	});

	test("splits an opener glued to its first match line", () => {
		const content = "const alpha = oldValue;\n";
		const input = `${M.open} const alpha = oldValue;\n${M.put}\nconst alpha = nextValue;`;

		expect(variant.apply(content, input, context)).toBe("const alpha = nextValue;\n");
	});

	test("does not split a register reference glued to extra content", () => {
		expect(() =>
			variant.apply("const value = oldValue;\n", `${M.open}\nconst value = oldValue;\n${M.put}2 extra`, context),
		).toThrow(new RegExp(`Invalid control line "${esc(M.put)}2 extra"`));
	});

	test("accepts the Unicode ellipsis gap", () => {
		const content = "const timeout = readConfig() ?? 1000;\nrun(timeout);\n";

		expect(variant.apply(content, operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000"), context)).toBe(
			"const timeout = readConfig() ?? 5000;\nrun(timeout);\n",
		);
		expect(variant.apply(content, operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000"), context)).toBe(
			"const timeout = readConfig() ?? 5000;\nrun(timeout);\n",
		);
	});

	test("treats rewrite ellipses beyond the capture count as literal", () => {
		const content = "const value = oldCall(options);\nreport(value);\n";
		const pattern = "const value = ⟪oldCall(…);⟫…\nreport(value)";

		expect(variant.apply(content, operation(pattern, "newCall(…) ?? […fallback]"), context)).toBe(
			"const value = newCall(options) ?? […fallback]\nreport(value);\n",
		);
	});

	test("accepts sparse whole-region replacement without selection markers", () => {
		const content = "function read() {\n  prepare();\n  return oldValue;\n}\n";
		const pattern = "function read() {…\nreturn oldValue;…\n}";
		const rewrite = "function read() {\n  return newValue;\n}";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"function read() {\n  return newValue;\n}\n",
		);
	});

	test("treats several OLD selections as one whole sparse region", () => {
		const content = "if (ready) {\n  value = first;\n} else {\n  value = second;\n}\n";
		const pattern = "if (ready) {\n  value = ⟪first⟫;\n} else {\n  value = ⟪second⟫;\n}";
		const rewrite = "if (ready) {\n  value = second;\n} else {\n  value = first;\n}";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"if (ready) {\n  value = second;\n} else {\n  value = first;\n}\n",
		);
	});

	test("keeps ambiguous verbatim regions fail-closed", () => {
		const content = "function first() {\n  return value;\n}\nfunction second() {\n  return value;\n}\n";

		expect(() => variant.apply(content, operation("return value;", "return next;"), context)).toThrow(
			/ambiguous: 2 ordered tuples match/,
		);
	});

	test("bounds same-line gaps and aligns a full-line rewrite around the selection", () => {
		const content = [
			"class Terminal {",
			"  private _kittyProtocolActive = true;",
			"  private one = 1;",
			"  private two = 2;",
			"  private three = 3;",
			"}",
			"",
		].join("\n");
		const input = operation("private _kittyProtocolActive = …⟪true⟫…;", "private _kittyProtocolActive = false;");

		expect(variant.apply(content, input, context)).toBe(
			content.replace("_kittyProtocolActive = true", "_kittyProtocolActive = false"),
		);
	});

	test("prefers an exact literal spread over ellipsis gap interpretation", () => {
		const content = [
			"insert.run(first());",
			"update.run(second());",
			"transaction.run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
			"",
		].join("\n");
		const input = operation(
			".run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
			".run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));",
		);

		expect(variant.apply(content, input, context)).toBe(
			content.replace(
				".run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
				".run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));",
			),
		);
	});

	test("treats ASCII ellipses inside a template literal as source text", () => {
		const content = [
			"    super(",
			"      'branchSummary',",
			"      ui,",
			"      (spinner) => theme.fg('accent', spinner),",
			"      (text) => theme.fg('muted', text),",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
			"      `Summarizing branch... (${keyText('app.interrupt')} to cancel)`,",
			"    );",
			"",
		].join("\n");
		const pattern = [
			"super(\u2026",
			"⟪'branchSummary'⟫,\u2026",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
			"`Summarizing branch... (${keyText('app.interrupt')} to cancel)`,",
			");",
		].join("\n");

		expect(variant.apply(content, operation(pattern, "'branchSummaryNext'"), context)).toBe(
			content.replace("'branchSummary'", "'branchSummaryNext'"),
		);
	});

	test("anchors a missing-fragment preview on the strongest occurring fragment", () => {
		const content = [
			"class MissingTailFactory {}",
			...Array.from({ length: 18 }, (_, index) => `const filler${index} = ${index};`),
			"class BranchSummaryStatusIndicator {",
			"  constructor() {",
			"    super(",
			"      'branchSummary',",
			"      ui,",
			"    );",
			"  }",
			"}",
			"",
		].join("\n");
		const input = operation("super(\n'branchSummary',…\n⟪missingTail();⟫", "nextTail();");
		let message = "";

		try {
			variant.apply(content, input, context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("It broke relative to matched anchor");
		expect(message).toMatch(/Current file content near the closest match \(no re-read needed\):[\s\S]*\d+: +super\(/);
		expect(message).not.toContain("1: class MissingTailFactory");
		expect(message).not.toContain("MissingTailFac");
	});

	test("preserves structural rows omitted between corresponding rewrite lines", () => {
		const content = [
			"function parseCatalog(value: unknown) {",
			"  const entries = Array.isArray(value)",
			"    ? avlue",
			"    : undefined;",
			"  if (!entries) throw new Error('missing');",
			"}",
			"",
		].join("\n");
		const wrongBoundary = [
			"function parseCatalog(value: unknown) {",
			"  const entries = Array.isArray(value)",
			"    ? avlue",
			"    : undefined;",
			"}",
		].join("\n");

		expect(variant.apply(content, operation(wrongBoundary, wrongBoundary.replace("avlue", "value")), context)).toBe(
			content.replace("avlue", "value"),
		);
	});

	test("strips full-statement envelope echoes around an inner selection", () => {
		const content = "if (enwlineIndex === -1) {\n  return;\n}\n";
		const input = operation("if (…⟪enwlineIndex⟫… === -1) {", "if (newlineIndex === -1) {");

		expect(variant.apply(content, input, context)).toBe("if (newlineIndex === -1) {\n  return;\n}\n");
	});

	test("applies a de-indented multiline rewrite verbatim", () => {
		const content = "function outer() {\n  if (ready) {\n    oldCall();\n    keep();\n  }\n}\n";
		const match = "  if (ready) {\n    oldCall();\n    keep();\n  }";
		const rewrite = "if (ready) {\n  newCall();\n  keep();\n}";

		expect(variant.apply(content, operation(match, rewrite), context)).toBe(
			"function outer() {\nif (ready) {\n  newCall();\n  keep();\n}\n}\n",
		);
	});
	test("applies an authored indentation-only replacement verbatim", () => {
		const content = "function run() {\n    const getContrastVsWhite = () => value;\n}\n";
		const input = operation(
			"    const getContrastVsWhite = () => value;",
			"  const getContrastVsWhite = () => value;",
		);

		expect(variant.apply(content, input, context)).toBe(
			"function run() {\n  const getContrastVsWhite = () => value;\n}\n",
		);
	});

	test("grounds no-change errors at the matched region instead of file head", () => {
		const content = [
			"const head = true;",
			"step2();",
			"step3();",
			"step4();",
			"step5();",
			"step6();",
			"step7();",
			"step8();",
			"step9();",
			"step10();",
			"step11();",
			"  const target = currentValue;",
			"step13();",
			"step14();",
		].join("\n");
		let message = "";
		try {
			variant.apply(content, operation("  const target = currentValue;", "  const target = currentValue;"), {
				path: "src/matched-noop.ts",
			});
		} catch (error) {
			if (error instanceof Error) message = error.message;
		}

		expect(message).toContain("12:   const target = currentValue;");
		expect(message).not.toContain("1: const head = true;");
		expect(message).toContain("Indentation-only changes are applied verbatim");
	});

	test("assumes an omitted leading opener for an op-shaped payload", () => {
		const content = "const value = oldValue;\n";
		const input = `const value = oldValue;\n${M.put}\nconst value = newValue;`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips markdown fences, patch envelopes, and leading blanks", () => {
		const content = "const value = oldValue;\n";
		const input = [
			"",
			"```text",
			"*** Begin Patch",
			M.open,
			"const value = oldValue;",
			M.put,
			"const value = newValue;",
			"*** End Patch",
			"```",
			"",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips uniform read line-number prefixes from both blocks", () => {
		const content = "function run() {\n    oldCall();\n}\n";
		const input = [
			M.open,
			"12:function run() {",
			"13:    oldCall();",
			"14:}",
			M.put,
			"12:function run() {",
			"13:    newCall();",
			"14:}",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("function run() {\n    newCall();\n}\n");
	});

	test("ignores copied read metadata and elision rows", () => {
		const content = "const value = oldValue;\n";
		const input = [
			M.open,
			"[Showing lines 10-12 of 40]",
			"const value = oldValue;",
			"[…2ln elided…]",
			M.put,
			"[Showing lines 10-12 of 40]",
			"const value = newValue;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("recovers unified-diff contamination in REWRITE", () => {
		const content = "const value = oldValue;\n";
		const input = [
			M.open,
			"const value = oldValue;",
			M.put,
			"-const value = oldValue;",
			"+const value = newValue;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("drops transport-only trailing blank rows at EOF", () => {
		const content = "const value = oldValue;\n";
		const input = `${operation("const value = oldValue;", "const value = newValue;")}\n\n`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips harmless leading and trailing sparse gaps", () => {
		const content = "before();\nobsolete();\nafter();\n";
		const input = operation("…\n⟪obsolete();⟫\n…", "");

		expect(variant.apply(content, input, context)).toBe("before();\nafter();\n");
	});

	test("moves code with authored add lines in one batch", () => {
		const content = [
			"function run() {",
			"  const target = () => 2;",
			"  const helper = () => {",
			"    return 1;",
			"  };",
			"  finish();",
			"}",
			"",
		].join("\n");
		const input = [
			operation("  const helper = () => {\n    return 1;\n  };", ""),
			inlineOperation(
				"function run() {\n＋  const helper = () => {\n＋    return 1;\n＋  };\n  const target = () => 2;",
			),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function run() {",
				"  const helper = () => {",
				"    return 1;",
				"  };",
				"  const target = () => 2;",
				"  finish();",
				"}",
				"",
			].join("\n"),
		);
	});
	test("trusts authored move indentation when the destination anchor has a different indent", () => {
		const content = [
			"function run() {",
			"    const target = () => 2;",
			"    finish();",
			"",
			"  const helper = () => {",
			"    return 1;",
			"  };",
			"}",
			"",
		].join("\n");
		const input = [
			operation("  const helper = () => {\n    return 1;\n  };", ""),
			operation("    const target = () => 2;", `${M.put}1\n\n  const target = () => 2;`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function run() {",
				"  const helper = () => {",
				"    return 1;",
				"  };",
				"",
				"  const target = () => 2;",
				"    finish();",
				"}",
				"",
			].join("\n"),
		);
	});

	test("treats a lone deletion register as insert-before for a distinct one-line anchor", () => {
		const content = ["const anchor = () => 1;", "const moved = () => {", "  return 2;", "};", ""].join("\n");
		const input = [
			operation("const moved = () => {\n  return 2;\n};", ""),
			operation("const anchor = () => 1;", `${M.put}1`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["const moved = () => {", "  return 2;", "};", "", "const anchor = () => 1;", ""].join("\n"),
		);
	});

	test("does not preserve a lone-register anchor already present in the moved block", () => {
		const content = [
			"// setup",
			"const anchor = true;",
			"const moved = () => {",
			"  const anchor = true;",
			"};",
			"",
		].join("\n");
		const input = [
			operation("const moved = () => {\n  const anchor = true;\n};", ""),
			operation(`// setup…\n${M.selectOpen}const anchor = true;${M.selectClose}`, `${M.put}1`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["// setup", "const moved = () => {", "  const anchor = true;", "};", ""].join("\n"),
		);
	});

	test("collapses a blank seam only when both sides of a deleted block are blank", () => {
		const surrounded = "before();\n\nconst removed = true;\n\nafter();\n";
		const oneSided = "before();\nconst removed = true;\n\nafter();\n";

		expect(variant.apply(surrounded, operation("const removed = true;", ""), context)).toBe(
			"before();\n\nafter();\n",
		);
		expect(variant.apply(oneSided, operation("const removed = true;", ""), context)).toBe("before();\n\nafter();\n");
	});

	test("rejects self, forward, MATCH, and non-deletion register references", () => {
		const content = "const first = oldFirst;\nconst second = oldSecond;\n";

		expect(() => variant.apply(content, operation("const first = oldFirst;", `${M.put}1`), context)).toThrow(
			/must reference an earlier operation/,
		);
		expect(() =>
			variant.apply(
				content,
				[operation("const first = oldFirst;", `${M.put}2`), operation("const second = oldSecond;", "")].join("\n"),
				context,
			),
		).toThrow(/must reference an earlier operation/);
		expect(() => variant.apply(content, `${M.open}\n${M.put}1\n${M.put}\nnext`, context)).toThrow(
			/valid only in REWRITE/,
		);
		expect(() =>
			variant.apply(
				content,
				[
					operation("const first = oldFirst;", "const first = newFirst;"),
					operation("⟪⟫const second = oldSecond;", `${M.put}1`),
				].join("\n"),
				context,
			),
		).toThrow(/must reference an earlier deletion operation/);
	});

	test("auto-splits a uniquely matching MATCH prefix from an omitted separator", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = `${M.open}\nconst value = oldValue;\nconst value = newValue;`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\nreport(value);\n");
	});

	test("accepts evidence-backed alternating MATCH and REWRITE blocks", () => {
		const content = "const first = oldFirst;\nconst second = oldSecond;\n";
		const input = [
			M.open,
			"const first = oldFirst;",
			M.open,
			"const first = newFirst;",
			M.open,
			"const second = oldSecond;",
			M.open,
			"const second = newSecond;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const first = newFirst;\nconst second = newSecond;\n");
	});

	test("does not infer an opener as a separator when both neighboring blocks miss", () => {
		const content = "const value = presentValue;\n";
		const input = `${M.open}\nconst value = missingOld;\n${M.open}\nconst value = missingNew;`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`needs ${esc(M.put)}`));
	});

	test("applies an omitted-separator block over its unique same-shape window", () => {
		const content = "const value = oldValue;\nconst value = oldValue;\n";
		const input = `${M.open}\nconst value = oldValue;\nconst value = newValue;`;
		const notes: string[] = [];

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			"const value = oldValue;\nconst value = newValue;\n",
		);
		expect(notes.join("\n")).toMatch(/closest matching block was replaced/);
	});

	test("treats empty double selection markers as an insertion point", () => {
		const content = "before();\nafter();\n";
		const input = operation("before();\n⟪⟫after();", "inserted();");

		expect(variant.apply(content, input, context)).toBe("before();\ninserted();\nafter();\n");
	});
	test("resolves every batch anchor against the original content", () => {
		const content = ["start();", "const removed = true;", "middle();", "const target = oldValue;", "end();", ""].join(
			"\n",
		);
		const input = [
			operation("const removed = true;", ""),
			operation("middle();", "middleChanged();"),
			operation(
				"start();…\nconst removed = true;…\n⟪const target = oldValue;⟫…\nend();",
				"const target = newValue;",
			),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["start();", "middleChanged();", "const target = newValue;", "end();", ""].join("\n"),
		);
	});

	test("rejects overlapping original target spans atomically", () => {
		const content = "const value = oldValue;\n";
		const input = [operation("const value = ⟪oldValue⟫;", "newValue"), operation("⟪oldValue⟫", "newerValue")].join(
			"\n",
		);

		expect(() => variant.apply(content, input, context)).toThrow(
			/Operations 1 and 2 target overlapping original spans/,
		);
		expect(content).toBe("const value = oldValue;\n");
	});

	test("never fuzzy-matches different operator sequences", () => {
		const content = "const shouldRun = left || right;\n";

		expect(() => variant.apply(content, operation("const shouldRun = left && ⟪right⟫;", "next"), context)).toThrow(
			/did not match/,
		);
	});

	test("a no-change match names a fuzzy-near candidate that would change", () => {
		const content = "const first = oldValue;\nconst second = oldValuf;\n";
		const input = operation("⟪oldValue⟫", "oldValue");

		expect(() => variant.apply(content, input, context)).toThrow(
			/Line 2 also matches and WOULD change — target it by adding context unique to it\./,
		);
	});

	test("treats a blank-only replacement as deletion and collapses its seam", () => {
		const content = "before();\n\nconst removed = true;\n\nafter();\n";
		const input = [M.open, "const removed = true;", M.put, "   ", M.open, "after();", M.put, "afterChanged();"].join(
			"\n",
		);

		expect(variant.apply(content, input, context)).toBe("before();\n\nafterChanged();\n");
	});

	test("uses an empty rewrite as a blank line only for an insertion operation", () => {
		const content = "before();\nafter();\n";

		expect(variant.apply(content, operation("before();\n⟪⟫after();", ""), context)).toBe("before();\n\nafter();\n");
	});

	test("allows one punctuation insertion typo for a unique changing candidate", () => {
		const content = "for (let i = 0; i < 100; i--) {\n  run();\n}\n";
		const input = operation("for (let i = 0; i < ⟪100⟫; i--;) {", "10");

		expect(variant.apply(content, input, context)).toBe("for (let i = 0; i < 10; i--) {\n  run();\n}\n");
	});

	test("does not use punctuation tolerance when more than one candidate aligns", () => {
		const content = [
			"for (let i = 0; i < 100; i--) runFirst();",
			"for (let i = 0; i < 100; i--) runSecond();",
			"",
		].join("\n");
		const input = operation("for (let i = 0; i < ⟪100⟫; i--;)", "10");

		expect(() => variant.apply(content, input, context)).toThrow(/did not match/);
	});

	test("escalates the third identical no-op with STOP guidance", () => {
		const noopContext = { path: "src/noop-loop.ts" };
		const content = "const value = currentValue;\n";
		const input = operation("const value = currentValue;", "const value = currentValue;");

		expect(() => variant.apply(content, input, noopContext)).toThrow(/makes no change/);
		expect(() => variant.apply(content, input, noopContext)).toThrow(/makes no change/);
		expect(() => variant.apply(content, input, noopContext)).toThrow(/STOP: identical no-op repeated 3 times/);
	});

	test("correctly maps source spans across multi-byte astral characters (emoji)", () => {
		const file = [
			"fn render_tree() {",
			'\tlet icon = if dir { "📁" } else { "📄" };',
			"}",
			"",
			"#[cfg(test)]",
			"mod tests {",
			"\tuse bytes::Bytes;",
			"\tuse omp_core::Str;",
			"\tuse parking_lot::Mutex;",
			"\tuse smallvec::SmallVec;",
			"\tuse url::Url;",
			"}",
			"",
		].join("\n");
		const input = operation(
			"\tuse bytes::Bytes;\n\tuse omp_core::Str;\n\tuse parking_lot::Mutex;",
			"\tuse bytes::Bytes;\n\tuse omp_core::{Str, sf};\n\tuse parking_lot::Mutex;",
		);
		const result = variant.apply(file, input, context);
		expect(result).toContain("\tuse omp_core::{Str, sf};");
		expect(result).toContain("\tuse smallvec::SmallVec;");
		expect(result).not.toContain("us\tuse");
		expect(result).not.toContain("Mutex;e smallvec");
	});
});

describe("splitSloppySections", () => {
	test("splits a payload into per-file sections", () => {
		const input = `[src/a.ts]\n${M.open}\nold\n${M.put}\nnew\n[src/b.ts]\n${M.open}\nfoo\n${M.put}\nbar`;
		const sections = splitSloppySections(input);
		expect(sections.map(section => section.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(sections[0].body).toContain("old");
		expect(sections[0].body).not.toContain("foo");
		expect(sections[1].body).toContain("bar");
	});

	test("merges repeated sections for the same file in order", () => {
		const input = `[src/a.ts]\n${M.open}\none\n${M.put}\n1\n[src/b.ts]\n${M.open}\ntwo\n${M.put}\n2\n[src/a.ts]\n${M.open}\nthree\n${M.put}\n3`;
		const sections = splitSloppySections(input);
		expect(sections.map(section => section.path)).toEqual(["src/a.ts", "src/b.ts"]);
		const first = sections[0].body;
		expect(first.indexOf("one")).toBeGreaterThanOrEqual(0);
		expect(first.indexOf("three")).toBeGreaterThan(first.indexOf("one"));
	});

	test("keeps header-looking content lines inside their operation", () => {
		// `[content]` is followed by more MATCH text, not an opener — it is code, not a header.
		const input = `[src/a.ts]\n${M.open}\nconst rows =\n[content]\n.flat();\n${M.put}\nconst rows = [content].flat();`;
		const sections = splitSloppySections(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].body).toContain("[content]");
	});

	test("returns empty for a payload without a leading header", () => {
		expect(splitSloppySections(`${M.open}\nold\n${M.put}\nnew`)).toEqual([]);
	});
});

describe("executeSloppy multi-file", () => {
	async function setup(): Promise<{ dir: TempDir; session: ToolSession }> {
		const dir = await TempDir.create("@sloppy-multifile-");
		await Bun.write(dir.join("a.ts"), "const alpha = 1;\n");
		await Bun.write(dir.join("b.ts"), "const beta = 2;\n");
		// Test seam: executeSloppy only reads `cwd` (+ optional plan/bridge hooks) from the session.
		const session = { cwd: dir.absolute() } as unknown as ToolSession;
		return { dir, session };
	}
	const writethrough = async (dst: string, content: string) => {
		await Bun.write(dst, content);
		return undefined;
	};
	const deferred = () => ({ close: () => {} }) as never;

	test("applies sections to multiple files in one call", async () => {
		const { dir, session } = await setup();
		try {
			const result = await executeSloppy({
				session,
				sections: [
					{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
					{ path: "b.ts", body: `${M.open}\nconst beta = ⟪2⟫;\n${M.put}\n20` },
				],
				writethrough,
				beginDeferredDiagnosticsForPath: deferred,
			});
			expect(await Bun.file(dir.join("a.ts")).text()).toBe("const alpha = 10;\n");
			expect(await Bun.file(dir.join("b.ts")).text()).toBe("const beta = 20;\n");
			expect(result.details?.perFileResults).toHaveLength(2);
			const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
			expect(text).toContain("[a.ts]\n1:const alpha = 10;");
			expect(text).toContain("\n\n[b.ts]\n1:const beta = 20;");
			expect(text).not.toMatch(/^\[[^\]\n]+#[0-9A-F]{4}\]/);
		} finally {
			await dir.remove();
		}
	});

	test("writes nothing when a later section fails", async () => {
		const { dir, session } = await setup();
		try {
			await expect(
				executeSloppy({
					session,
					sections: [
						{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
						{ path: "b.ts", body: `${M.open}\nthis text is nowhere\n${M.put}\nreplacement` },
					],
					writethrough,
					beginDeferredDiagnosticsForPath: deferred,
				}),
			).rejects.toThrow(/\[b\.ts\]:[\s\S]*sections apply atomically/);
			expect(await Bun.file(dir.join("a.ts")).text()).toBe("const alpha = 1;\n");
		} finally {
			await dir.remove();
		}
	});
});

describe("computeSloppySectionDiff", () => {
	test("returns a diff for an applicable section and an error for a miss", async () => {
		const dir = await TempDir.create("@sloppy-preview-");
		try {
			await Bun.write(dir.join("a.ts"), "const alpha = 1;\n");
			const good = await computeSloppySectionDiff(
				{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
				dir.absolute(),
			);
			expect("diff" in good && good.diff).toContain("const alpha = 10;");
			const bad = await computeSloppySectionDiff(
				{ path: "a.ts", body: `${M.open}\nnowhere\n${M.put}\nx` },
				dir.absolute(),
			);
			expect("error" in bad && bad.error).toContain("did not match");
		} finally {
			await dir.remove();
		}
	});
});

describe("directional selection markers", () => {
	test("throws error on unclosed opening selection marker", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = operation("const value = ⟪oldValue;\nreport(value);", "nextValue");
		expect(() => variant.apply(content, input, context)).toThrow(/unclosed selection marker ⟪; add closing ⟫/);
	});

	test("throws error on unmatched closing selection marker", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = operation("const value = oldValue⟫;\nreport(value);", "nextValue");
		expect(() => variant.apply(content, input, context)).toThrow(
			/unmatched closing selection marker ⟫; add opening ⟪/,
		);
	});

	test("repairs a stray ⟫ typed in place of the │ divider", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const notes: string[] = [];
		const input = inlineOperation("const value = ⟪oldValue⟫newValue⟫;\nreport(value)");

		expect(variant.apply(content, input, { path: "src/example.ts", notes })).toBe(
			"const value = newValue;\nreport(value);\n",
		);
		expect(notes.join("\n")).toMatch(/⟪old⟫new⟫ was read as ⟪old│new⟫/);
	});

	test("keeps the unmatched-close error when a stray ⟫ follows a proper selection", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = inlineOperation("const value = ⟪oldValue│newValue⟫;⟫\nreport(value)");

		expect(() => variant.apply(content, input, context)).toThrow(
			/unmatched closing selection marker ⟫; add opening ⟪/,
		);
	});

	test("supports an empty directional selection at the exact line boundary", () => {
		const content = "function run() {\n  finish();\n}\n";
		const input = operation("function run() {\n⟪⟫  finish();\n}", "  start();\n");
		expect(variant.apply(content, input, context)).toBe("function run() {\n  start();\n  finish();\n}\n");
	});
});

describe("overlapping operations", () => {
	test("merges overlapping edits that agree on the shared text", () => {
		// Real payload shape: a broad «* rename plus narrower ops covering some
		// of the same matches. Both state the same final text — not a conflict.
		const content = ["const a = avlue;", "const b = avlue.models;", ""].join("\n");
		const input = [
			`${M.open}*\navlue\n${M.put}\nvalue`,
			`${M.open}\nconst b = avlue.models;\n${M.put}\nconst b = value.models;`,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["const a = value;", "const b = value.models;", ""].join("\n"),
		);
	});

	test("still rejects overlapping edits that disagree", () => {
		const content = "const b = avlue.models;\n";
		const input = [
			`${M.open}*\navlue\n${M.put}\nvalue`,
			`${M.open}\nconst b = avlue.models;\n${M.put}\nconst b = other.models;`,
		].join("\n");

		expect(() => variant.apply(content, input, context)).toThrow(/target overlapping original spans/);
	});
});
