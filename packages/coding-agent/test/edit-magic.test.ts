import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { EditTool, magicEditSchema } from "@oh-my-pi/pi-coding-agent/edit";
import { applyDescribedChange, parseMagicInput } from "@oh-my-pi/pi-coding-agent/edit/magic";
import { compileLineEdits } from "@oh-my-pi/pi-coding-agent/edit/magic-lines";
import { fileViews } from "@oh-my-pi/pi-coding-agent/edit/magic-view";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { rejectionOf } from "./helpers/rejection";

const SOURCE = [
	"function total(items: number[]) {",
	"\tlet sum = 0;",
	"\tfor (const item of items) {",
	"\t\tsum += item;",
	"\t}",
	"\tconsole.log(sum);",
	"\treturn sum;",
	"}",
	"",
].join("\n");

/** `count` eight-line functions `step0`…; `stepN` opens on line `8 * N + 1`. */
function longSource(count: number): string {
	return Array.from({ length: count }, (_, n) =>
		[
			`export function step${n}(input: number): number {`,
			"\tconst doubled = input * 2;",
			`\tif (doubled > ${n}) {`,
			`\t\treturn doubled - ${n};`,
			"\t}",
			"\treturn doubled;",
			"}",
			"",
			"",
		].join("\n"),
	).join("");
}

function makeSession(cwd: string, settings: Settings, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings,
		...extra,
	} as unknown as ToolSession;
}

/** Drive the change through the real `replace` engine against a file on disk, with scripted model replies. */
async function run(replies: string[], content = SOURCE, change = "described change") {
	const tempDir = TempDir.createSync("@omp-magic-edit-");
	const file = path.join(tempDir.path(), "sample.ts");
	await Bun.write(file, content);
	const editor = new EditTool(makeSession(tempDir.path(), Settings.isolated({})), "replace");
	const requests: string[] = [];
	const outcome = applyDescribedChange({
		path: "sample.ts",
		change,
		content,
		complete: async request => {
			requests.push(request);
			const reply = replies.shift();
			if (reply === undefined) throw new Error("the model was asked for more replies than scripted");
			return { text: reply, truncated: false };
		},
		apply: edits => editor.execute("call", { path: "sample.ts", edits }),
	});
	return { outcome, requests, read: () => Bun.file(file).text(), dispose: () => tempDir.removeSync() };
}

describe("fileViews", () => {
	const long = longSource(50);
	const markers = (text: string) => text.split("\n").filter(line => line.startsWith("⋮"));

	it("shows a long file as the named lines with their block, context, head and tail, then whole", () => {
		const [excerpt, whole] = fileViews(
			long,
			"In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.",
		);
		expect(excerpt.partial).toBe(true);
		// step30 opens on line 241 and closes on 247; twelve lines of context either side.
		expect(markers(excerpt.text)).toEqual(["⋮ lines 13-228 not shown", "⋮ lines 260-388 not shown"]);
		// A line that opens a block carries the block's span for the model to copy.
		expect(excerpt.text).toContain(
			"241-247\texport function step30(input: number): number {\n242\t\tconst doubled = input * 2;",
		);
		expect(excerpt.text.startsWith("1-7\texport function step0(")).toBe(true);
		expect(excerpt.text.endsWith("400\t")).toBe(true);
		expect(whole).toEqual({ partial: false, text: expect.stringContaining("\n100\t\t\treturn doubled - 12;\n") });
	});

	it("places a repeating line by the other lines the change names, and reads line numbers", () => {
		// `const doubled = input * 2;` is in all fifty functions.
		const [repeated] = fileViews(
			long,
			"In `step30()`, change `const doubled = input * 2;` to `const doubled = input * 3;`.",
		);
		expect(repeated.text).toContain("\n242\t\tconst doubled = input * 2;\n");
		expect(repeated.text).not.toContain("\n202\t");
		expect(repeated.text).not.toContain("\n322\t");
		expect(markers(repeated.text)).toHaveLength(2);

		const [byNumber] = fileViews(long, "Delete lines 120-121 and line 300.");
		expect(markers(byNumber.text)).toEqual([
			"⋮ lines 13-107 not shown",
			"⋮ lines 134-287 not shown",
			"⋮ lines 313-388 not shown",
		]);
	});

	it("shows the whole file when it is short, when nothing is named, or when most of it is", () => {
		const whole = (content: string, change: string) => fileViews(content, change).map(view => view.partial);
		expect(whole(SOURCE, "In `total`, delete `console.log(sum);`.")).toEqual([false]);
		expect(whole(long, "Tidy up the error handling.")).toEqual([false]);
		const many = Array.from({ length: 25 }, (_, n) => `\`step${2 * n}(\``).join(", ");
		expect(whole(long, `Add a comment above each of ${many}.`)).toEqual([false]);
	});

	it("drops the views that exceed the limit", () => {
		const named = "In `step30()`, return `doubled + 30`.";
		expect(fileViews(long, named, 4000).map(view => view.partial)).toEqual([true]);
		expect(fileViews(long, "Tidy up the error handling.", 4000)).toEqual([]);
	});
	it("locates qualified method names and ln references, merges tiny gaps, and bounds blocks accurately", () => {
		const lines = Array.from({ length: 260 }, (_, i) => `\tlet v${i} = ${i};`);
		lines[0] = "impl Line {";
		lines[120] = "\tfn blank() {";
		lines[121] = "\t\treturn 0;";
		lines[122] = "\t}";
		lines[259] = "}";
		const content = lines.join("\n");
		// Qualified Rust method (`Line::blank`) and `ln` reference both locate their middle-of-file regions;
		// two `ln` hits 30 lines apart leave a 5-line gap between their 12-line contexts, which merges seamlessly.
		const [excerpt] = fileViews(content, "In `Line::blank`, ln 150, and ln 180, update body.");
		expect(excerpt.partial).toBe(true);
		expect(excerpt.text).toContain("121-123\t\tfn blank() {");
		expect(excerpt.text).toContain("\n150\t");
		expect(excerpt.text).toContain("\n180\t");
		expect(excerpt.text).toContain("\n165\t");
		const gaps = excerpt.text.split("\n").filter(line => line.startsWith("⋮"));
		expect(gaps).toHaveLength(2);
		for (const gap of gaps) {
			const match = /lines (\d+)-(\d+) not shown/.exec(gap);
			if (match) expect(Number(match[2]) - Number(match[1]) + 1).toBeGreaterThan(8);
		}
		// A closing brace followed by a misplaced indented block never opens a block span.
		const closing = "function a() {\n\treturn 1;\n}\n\n\tfunction misplaced() {\n\t\treturn 2;\n\t}\n";
		const [numbered] = fileViews(closing, "described change");
		expect(numbered.text).not.toMatch(/^3-\d+\t\}/m);
		expect(numbered.text).toContain("\n3\t}\n");
		// A multi-line header whose `{` is on its own line spans through its closing `}`.
		const multiline = "if cond\n  || cond2\n{\n  body;\n}\n";
		const [ml] = fileViews(multiline, "described change");
		expect(ml.text).toContain("1-5\tif cond");
	});
});

describe("compileLineEdits", () => {
	const THREE = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n";
	const fn = (name: string, value: number) => `function ${name}() {\n  return ${value};\n}\n`;

	/** `content` after the operations in `reply`, or the problem reported to the model. */
	function after(content: string, reply: string, options: { change?: string; cut?: boolean } = {}): string {
		const views = fileViews(content, options.change ?? "described change");
		const compiled = compileLineEdits(reply, content, views[0], options.cut);
		if ("problem" in compiled) return `problem: ${compiled.problem}`;
		expect(content.split(compiled.edit.old_string)).toHaveLength(2);
		return content.replace(compiled.edit.old_string, compiled.edit.new_string ?? "");
	}

	it("deletes, inserts, replaces and substitutes by original line number in one reply", () => {
		// Line 6 is the console.log, line 2 the declaration, line 7 the return.
		const reply = [
			'["delete",6,6]',
			'["insert","after",2,"\\tlet count = 0;"]',
			'["replace",7,7,"\\treturn sum / count;"]',
			'["sub",4,"+=","-="]',
			'["sub","all","items","values"]',
		].join("\n");
		expect(after(SOURCE, reply)).toBe(
			[
				"function total(values: number[]) {",
				"\tlet sum = 0;",
				"\tlet count = 0;",
				"\tfor (const item of values) {",
				"\t\tsum -= item;",
				"\t}",
				"\treturn sum / count;",
				"}",
				"",
			].join("\n"),
		);
	});

	it("takes a sub's line number as a hint when one line holds the text, and names the nearest lines when several do", () => {
		// `sum = 0` is on line 2 only; `sum` is on lines 2, 4, 6 and 7.
		expect(after(SOURCE, '["sub",3,"sum = 0","sum = 1"]')).toBe(SOURCE.replace("sum = 0", "sum = 1"));
		expect(after(SOURCE, '["sub",3,"sum","total"]')).toContain("the nearest line that does is 2 or 4");
		expect(after(SOURCE, '["sub","all","nothing","x"]')).toContain("does not contain");
	});

	it("reads the near-miss forms of delete, swap, indent and dedent", () => {
		expect(after(SOURCE, '["remove",6]')).toBe(SOURCE.replace("\tconsole.log(sum);\n", ""));
		const swapped = THREE.replace("return 1;", "return 0;")
			.replace("return 2;", "return 1;")
			.replace("return 0;", "return 2;");
		expect(after(THREE, '["swap",2,6]')).toBe(swapped);
		expect(after(THREE, '["swap",2,6,6,2]')).toBe(swapped);
		// No amount is one step of the file's indentation; a negative amount is the opposite shift.
		expect(after(THREE, '["dedent",2,2]')).toBe(THREE.replace("  return 1;", "return 1;"));
		expect(after(THREE, '["indent",2,2,-2]')).toBe(THREE.replace("  return 1;", "return 1;"));
		expect(after(THREE, '["indent",2,2]')).toBe(THREE.replace("  return 1;", "    return 1;"));
	});

	it("merges inserts at one place in the order given, but never into the place a move lands", () => {
		expect(after(THREE, '["insert","after",2,"  // one"]\n["insert","before",3,"  // two"]')).toBe(
			THREE.replace("  return 1;\n", "  return 1;\n  // one\n  // two\n"),
		);
		expect(after(THREE, '["move",9,11,"before",1]\n["insert","before",1,"// top"]')).toContain(
			"insert at the same place",
		);
	});

	it("treats blank lines between blocks as separators, whatever the range says about them", () => {
		const swapped = `${fn("b", 2)}\n${fn("a", 1)}\n${fn("c", 3)}`;
		expect(after(THREE, '["swap",1,3,5,7]')).toBe(swapped);
		// The same swap with each range one blank line too long.
		expect(after(THREE, '["swap",1,4,5,8]')).toBe(swapped);

		const moved = `${fn("c", 3)}\n${fn("a", 1)}\n${fn("b", 2)}`;
		expect(after(THREE, '["move",9,11,"before",1]')).toBe(moved);
		expect(after(THREE, '["move",8,11,"before",1]')).toBe(moved);

		// A deleted block leaves one separator behind, not two.
		expect(after(THREE, '["delete",5,7]')).toBe(`${fn("a", 1)}\n${fn("c", 3)}`);
		// Moving a block to where it already is changes nothing, and says so.
		expect(after(THREE, '["move",5,7,"after",4]')).toContain("nothing moves");
	});

	it("unwraps a block by deleting its two wrapper lines and dedenting what stays", () => {
		const wrapped = "start();\nif (ready) {\n  first();\n\n  second();\n}\nend();\n";
		expect(after(wrapped, '["delete",2,2]\n["dedent",3,5,2]\n["delete",6,6]')).toBe(
			"start();\nfirst();\n\nsecond();\nend();\n",
		);
		// A line without the indentation to remove is a mistake in the range, not something to guess at.
		expect(after(wrapped, '["dedent",1,3,2]')).toContain("problem: Line 1 does not have the specified indentation");
	});

	it("reads the operations out of the ways small models wrap them", () => {
		const deleted = SOURCE.replace("\tconsole.log(sum);\n", "");
		expect(after(SOURCE, '```json\n["delete","6","6"]\n```\nExplanation: line 6 is the log call.')).toBe(deleted);
		expect(after(SOURCE, '[["delete",6,6]]')).toBe(deleted);
		expect(after(SOURCE, '{"delete", 6, 6}')).toBe(deleted);
		// Operations after commentary mean the model changed its mind: nothing is taken from the reply.
		expect(after(SOURCE, '["delete",6,6]\nWait, that is the wrong line.\n["delete",7,7]')).toContain("problem:");
		expect(after(SOURCE, "I deleted line 6 as requested.")).toContain("problem:");
	});

	it("uses a reply cut at the output limit only when its operations were already finished", () => {
		const deleted = SOURCE.replace("\tconsole.log(sum);\n", "");
		expect(after(SOURCE, '["delete",6,6]\nExplanation: the log call is on', { cut: true })).toBe(deleted);
		expect(after(SOURCE, '["delete",6,6]\n["sub",2,"0",', { cut: true })).toContain("problem:");
	});

	it("rejects operations it cannot place instead of guessing", () => {
		expect(after(SOURCE, '["delete",3,5]\n["replace",4,4,"x"]')).toContain("same lines");
		expect(after(SOURCE, '["delete",8,12]')).toContain('expected ["delete", first, last]');
		expect(after(SOURCE, '["replace",2,2,"\\tlet sum = 0;"]')).toContain("no changes");
		expect(after(SOURCE, '["erase",6,6]')).toContain("unknown operation");
		// In an excerpt, a line that was not shown cannot be named.
		const long = longSource(50);
		const change = "In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.";
		expect(after(long, '["delete",100,100]', { change })).toContain("not shown");
		expect(after(long, '["sub",244,"- 30","+ 30"]', { change })).toBe(long.replace("doubled - 30;", "doubled + 30;"));
	});

	it("allows multiline sub replacements, ignores no-op subs, and shifts substituted lines", () => {
		expect(after(SOURCE, '["sub",2,"sum = 0;","sum = 0;\\n\\tlet count = 0;"]')).toBe(
			SOURCE.replace("let sum = 0;", "let sum = 0;\n\tlet count = 0;"),
		);
		const noop =
			'["sub",3,"for (const item of items) {","for (const item of items) {"]\n["replace",3,5,"\\treturn items.length;"]';
		expect(after(SOURCE, noop)).not.toContain("problem:");
		expect(after(SOURCE, '["indent",2,2,2]\n["sub",2,"sum = 0","sum = 1"]')).toBe(
			SOURCE.replace("\tlet sum = 0;", "  \tlet sum = 1;"),
		);
		expect(after(SOURCE, '["sub",2,"sum = 0;\\n\\tfor","x"]')).toContain("problem:");
	});

	it("does not collide on carried blank separators between neighbouring deletes or inserts", () => {
		expect(after(THREE, '["delete",5,7]\n["delete",9,11]')).toBe(fn("a", 1));
		expect(after(THREE, '["insert","after",8,"function d() {\\n  return 4;\\n}"]\n["delete",9,11]')).toBe(
			`${fn("a", 1)}\n${fn("b", 2)}\n${fn("d", 4)}`,
		);
	});

	it("reports multiple per-operation problems at once and names colliding operations", () => {
		const two = after(SOURCE, '["sub",2,"missing1","x"]\n["sub",7,"missing2","y"]');
		expect(two).toContain("Operation 1");
		expect(two).toContain("Operation 2");
		const collide = after(SOURCE, '["delete",3,5]\n["replace",4,4,"x"]');
		expect(collide).toContain("Operation 1");
		expect(collide).toContain("Operation 2");
		expect(collide).toContain("same lines");
	});
});

describe("applyDescribedChange", () => {
	it("deletes the unterminated last line together with the newline before it", async () => {
		const { outcome, read, dispose } = await run(['["delete",2,2]'], "first\nlast");
		await outcome;
		expect(await read()).toBe("first");
		dispose();
	});

	it("sends a rejected reply back with its rejection and applies the corrected one", async () => {
		const { outcome, requests, read, dispose } = await run([
			// Four lines hold `sum`, so the wrong line number cannot be read as a hint.
			'["sub",3,"sum","total"]',
			'["sub",2,"sum = 0","sum = 1"]',
		]);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toContain("<rejection>");
		// The retry carries the rejected reply and why it was rejected.
		expect(requests[1]).toContain('["sub",3,"sum","total"]');
		expect(requests[1]).toMatch(/<rejection>\n[^<]*line 3 does not contain/);
		expect(await read()).toBe(SOURCE.replace("let sum = 0;", "let sum = 1;"));
		dispose();
	});

	it("applies nothing from a reply whose later operation fails", async () => {
		const failing = '["sub",2,"0","1"]\n["sub",7,"no such text","x"]';
		const { outcome, requests, read, dispose } = await run([failing, failing, failing]);
		const error = await rejectionOf(outcome);
		expect(String(error)).toContain("the file is unchanged");
		expect(requests).toHaveLength(3);
		expect(await read()).toBe(SOURCE);
		dispose();
	});

	it("returns a range that would leave the file unparseable instead of writing it", async () => {
		// Lines 3-5 are the loop; 3-4 leaves its closing brace behind.
		const { outcome, requests, read, dispose } = await run(['["delete",3,4]', '["delete",3,5]']);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatch(/<rejection>\n[^<]*no longer parses[^<]*ends on line 5/);
		expect(await read()).toBe(SOURCE.replace("\tfor (const item of items) {\n\t\tsum += item;\n\t}\n", ""));
		dispose();
	});

	it("questions a range that runs past the block it starts, and applies it when the model repeats it", async () => {
		// Lines 3-6: the loop and the statement after it.
		const { outcome, requests, read, dispose } = await run(['["delete",3,6]', '["delete",3,6]']);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatch(/<rejection>\n[^<]*line 3 opens a block that ends on line 5/);
		expect(await read()).toBe("function total(items: number[]) {\n\tlet sum = 0;\n\treturn sum;\n}\n");
		dispose();
	});

	it("does not question an unwrap or the deletion of a blank line", async () => {
		const wrapped = "start();\nif (ready) {\n  first();\n\n  second();\n}\nend();\n";
		const unwrap = await run(['["delete",2,2]\n["dedent",3,5,2]\n["delete",6,6]'], wrapped);
		await unwrap.outcome;
		expect(await unwrap.read()).toBe("start();\nfirst();\n\nsecond();\nend();\n");
		unwrap.dispose();
		// Line 3 is blank and the lines after it are indented: no block starts there.
		const spaced = "function f() {\n  a();\n\n  if (x) {\n    b();\n  }\n}\n";
		const blank = await run(['["delete",3,3]'], spaced);
		await blank.outcome;
		expect(await blank.read()).toBe(spaced.replace("a();\n\n", "a();\n"));
		blank.dispose();
	});

	it("stops at a refusal without asking again", async () => {
		const { outcome, requests, read, dispose } = await run(["CANNOT: `drain` is not in this file"]);
		const error = await rejectionOf(outcome);
		expect(String(error)).toContain("`drain` is not in this file");
		expect(requests).toHaveLength(1);
		expect(await read()).toBe(SOURCE);
		dispose();
	});

	it("asks again with the whole file when the reply to an excerpt is rejected", async () => {
		const { outcome, requests, read, dispose } = await run(
			['["sub",244,"tripled","doubled"]', '["sub",244,"- 30","+ 30"]'],
			longSource(50),
			"In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.",
		);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[0]).toContain("⋮ lines 13-228 not shown");
		expect(requests[0]).not.toContain("\n100\t");
		expect(requests[1]).not.toContain("⋮");
		expect(requests[1]).toContain("\n100\t");
		expect(requests[1]).toContain("<rejection>");
		expect(await read()).toContain("\t\treturn doubled + 30;\n");
		dispose();
	});

	it("puts a change declined on an excerpt to the model afresh with the whole file", async () => {
		const { outcome, requests, dispose } = await run(
			["CANNOT: the target is not shown", "CANNOT: `step30` returns nothing like that"],
			longSource(50),
			"In `step30()`, replace `return tripled;` with `return doubled;`.",
		);
		const error = await rejectionOf(outcome);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("\n100\t");
		expect(requests[1]).not.toContain("<reply>");
		// Declined with the whole file in view: the excerpt is not to blame.
		expect(String(error)).toContain("`step30` returns nothing like that");
		expect(String(error)).not.toContain("line numbers");
		dispose();
	});

	it("shows the model each line behind its number, and a block's span on the line that opens it", async () => {
		const { outcome, requests, dispose } = await run(['["sub",7,"sum;","sum + 0;"]']);
		await outcome;
		expect(requests[0]).toContain("2\t\tlet sum = 0;\n3-5\t\tfor (const item of items) {\n4\t\t\tsum += item;");
		dispose();
	});

	it("pinpoints the syntax-breaking operation with boundary context, ignoring valid unwrap pairs", async () => {
		const wrapped = "start();\nif (ready) {\n  first();\n\n  second();\n}\nend();\n";
		const bad = '["delete",2,2]\n["dedent",3,5,2]\n["delete",6,6]\n["insert","before",1,"if (broken {"]';
		const good = '["delete",2,2]\n["dedent",3,5,2]\n["delete",6,6]';
		const { outcome, requests, dispose } = await run([bad, good], wrapped);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("Operation 4");
		expect(requests[1]).toContain("+ if (broken {");
		expect(requests[1]).toContain("1\tstart();");
		expect(requests[1]).not.toContain("Operation 1");
		expect(requests[1]).not.toContain("Operation 3");
		expect(requests[1]).not.toContain("so a range cuts a block in two");
		dispose();
	});

	it("does not spend a correction attempt when widening after an excerpt refusal", async () => {
		const { outcome, requests, read, dispose } = await run(
			["CANNOT: omitted", '["sub",244,"missing1","x"]', '["sub",244,"missing2","x"]', '["sub",244,"- 30","+ 30"]'],
			longSource(50),
			"In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.",
		);
		await outcome;
		expect(requests).toHaveLength(4);
		expect(await read()).toContain("\t\treturn doubled + 30;\n");
		dispose();
	});

	it("does not re-doubt a confirmed range when another op changes, and never doubts moving a closing brace", async () => {
		const first = '["delete",3,6]\n["sub",7,"sum","sum + 1"]';
		const second = '["delete",3,6]\n["sub",7,"sum","sum + 2"]';
		const { outcome, requests, read, dispose } = await run([first, second]);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("ends on line 5");
		expect(await read()).toContain("return sum + 2;");
		dispose();
		const brace = "function a() {\n\treturn 1;\n}\n\n\tfunction misplaced() {\n\t\treturn 2;\n\t}\n";
		const moved = await run(['["move",3,3,"after",7]'], brace);
		await moved.outcome;
		expect(moved.requests).toHaveLength(1);
		expect(await moved.read()).not.toContain("\treturn 1;\n}\n");
		moved.dispose();
	});
});

const APPLY_MODEL = {
	id: "apply-model",
	name: "Apply Model",
	api: "openai-responses",
	provider: "llama.cpp",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4096,
} as Model<Api>;

describe("parseMagicInput", () => {
	it("splits `# path` sections, merges sections naming the same file, and keeps a fenced `# ` line as change text", () => {
		expect(
			parseMagicInput(
				"# a.ts\n- Rename x to y.\n\n# b.sh\n- Add after line 2:\n```sh\n# starts the job\nstart\n```\n# a.ts\n- Then drop the import.\n",
			),
		).toEqual([
			{ path: "a.ts", change: "- Rename x to y.\n\n- Then drop the import." },
			{ path: "b.sh", change: "- Add after line 2:\n```sh\n# starts the job\nstart\n```" },
		]);
	});

	it("rejects text before the first header and a section without changes", () => {
		expect(() => parseMagicInput("- Rename x to y.\n# a.ts\n- ok")).toThrow("# path");
		expect(() => parseMagicInput("# a.ts\n# b.ts\n- Delete line 3.")).toThrow("a.ts");
	});
});

describe("edit tool in magic mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A session in `magic` mode whose apply model answers each file's request through `reply`. */
	function magicTool(cwd: string, reply: (request: string) => string) {
		const settings = Settings.isolated({ "edit.mode": "magic" });
		settings.setModelRole("smol", "llama.cpp/apply-model");
		const session = makeSession(cwd, settings, {
			modelRegistry: {
				getAvailable: () => [APPLY_MODEL],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
		});
		const requests: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, context) => {
			const request = String(context.messages[0]?.content);
			requests.push(request);
			return Promise.resolve(createAssistantMessage(reply(request)));
		});
		return { tool: new EditTool(session), requests };
	}

	it("takes a `# path` payload, has the apply model write the change, and returns the applied diff", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-tool-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const { tool, requests } = magicTool(tempDir.path(), () => '["sub",7,"sum;","sum + 1;"]');

		expect(tool.parameters).toBe(magicEditSchema);
		const input = "# sample.ts\n- Make total return sum + 1.";
		expect(tool.matcherPaths({ input })).toEqual(["sample.ts"]);
		const result = await tool.execute("call", { input });

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("Make total return sum + 1.");
		expect(await Bun.file(file).text()).toBe(SOURCE.replace("return sum;", "return sum + 1;"));
		expect(result.isError).toBeFalsy();
		expect(result.details?.diff).toContain("return sum + 1;");
	});

	it("edits a file too long for the apply model through an excerpt, and says what to do when nothing is named", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-long-");
		const file = path.join(tempDir.path(), "sample.ts");
		// 3,200 lines: more than half of the apply model's 32,768-token window.
		const source = longSource(400);
		await Bun.write(file, source);
		const { tool, requests } = magicTool(tempDir.path(), () => '["sub",2404,"- 300","+ 300"]');

		await tool.execute("call", {
			input: "# sample.ts\n- In `step300()`, replace `return doubled - 300;` with `return doubled + 300;`.",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("⋮ lines 13-2388 not shown");
		expect(await Bun.file(file).text()).toBe(source.replace("doubled - 300;", "doubled + 300;"));

		const error = await rejectionOf(tool.execute("call", { input: "# sample.ts\n- Tidy up the error handling." }));
		expect(String(error)).toContain("quote the lines to change, or give their line numbers");
		expect(requests).toHaveLength(1);
	});

	it("refuses line operations written against a file that changed while the model was answering", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-stale-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const changed = SOURCE.replace("let sum = 0;", "let sum = 10;");
		const { tool } = magicTool(tempDir.path(), () => {
			// Someone else saves the file between the read and the write.
			fs.writeFileSync(file, changed);
			return '["delete",6,6]';
		});

		const error = await rejectionOf(
			tool.execute("call", { input: "# sample.ts\n- Delete the `console.log(sum);` line." }),
		);
		expect(String(error)).toContain("could not be applied");
		expect(await Bun.file(file).text()).toBe(changed);
	});

	it("lets edit.magic.model name a role, which then replaces the smol role as the apply model", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-role-");
		await Bun.write(path.join(tempDir.path(), "sample.ts"), SOURCE);
		const roleModel = { ...APPLY_MODEL, id: "role-model" };
		const settings = Settings.isolated({ "edit.mode": "magic", "edit.magic.model": "@apply" });
		settings.setModelRole("smol", "llama.cpp/apply-model");
		settings.setModelRole("apply", "llama.cpp/role-model");
		const session = makeSession(tempDir.path(), settings, {
			modelRegistry: {
				getAvailable: () => [APPLY_MODEL, roleModel],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
		});
		const used: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(model => {
			used.push(model.id);
			return Promise.resolve(createAssistantMessage('["sub",7,"sum;","sum + 1;"]'));
		});

		await new EditTool(session).execute("call", {
			input: "# sample.ts\n- Make total return sum + 1.",
		});
		expect(used).toEqual(["role-model"]);
	});

	it("sizes a completion's output limit to the reply, except for an apply model that can reason", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-limit-");
		const file = path.join(tempDir.path(), "sample.ts");
		const limits: Record<string, number | undefined> = {};
		vi.spyOn(ai, "completeSimple").mockImplementation((model, _context, options) => {
			limits[model.id] = options?.maxTokens;
			return Promise.resolve(createAssistantMessage('["sub",7,"sum;","sum + 1;"]'));
		});
		for (const reasoning of [false, true]) {
			await Bun.write(file, SOURCE);
			const model = { ...APPLY_MODEL, id: reasoning ? "thinker" : "plain", reasoning };
			const settings = Settings.isolated({ "edit.mode": "magic", "edit.magic.model": `llama.cpp/${model.id}` });
			const session = makeSession(tempDir.path(), settings, {
				modelRegistry: {
					getAvailable: () => [model],
					getApiKey: async () => "test-key",
					resolver: () => async () => "test-key",
				} as unknown as ModelRegistry,
			});
			await new EditTool(session).execute("call", { input: "# sample.ts\n- Make total return sum + 1." });
		}
		// Reasoning is billed against the same limit, so a reply-sized one would cut the answer off.
		expect(limits.plain).toBeLessThan(1000);
		// The apply model's own maximum.
		expect(limits.thinker).toBe(4096);
	});

	it("applies each file of a batch on its own and reports the one that was refused", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-batch-");
		const first = path.join(tempDir.path(), "first.ts");
		const second = path.join(tempDir.path(), "second.ts");
		await Bun.write(first, SOURCE);
		await Bun.write(second, "export const limit = 1;\n");
		const { tool, requests } = magicTool(tempDir.path(), request =>
			request.includes("File `second.ts`") ? "CANNOT: there is no `drain` function here" : '["sub",2,"= 0","= 1"]',
		);

		const result = await tool.execute("call", {
			input: "# first.ts\n- Start the sum at 1.\n# second.ts\n- Remove `drain`.",
		});

		expect(requests).toHaveLength(2);
		expect(await Bun.file(first).text()).toBe(SOURCE.replace("let sum = 0;", "let sum = 1;"));
		expect(await Bun.file(second).text()).toBe("export const limit = 1;\n");
		// One file applied, so the call is not an error; the refusal names its file.
		expect(result.isError).toBeFalsy();
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("[second.ts] not applied");
		expect(text).toContain("no `drain` function");
		expect(result.details?.perFileResults?.map(entry => [path.basename(entry.path), entry.isError === true])).toEqual(
			[
				["first.ts", false],
				["second.ts", true],
			],
		);
	});
});
