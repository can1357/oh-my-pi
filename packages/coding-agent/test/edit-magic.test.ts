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

	it("tells the model which line holds the text a sub missed", () => {
		expect(after(SOURCE, '["sub",3,"sum = 0","sum = 1"]')).toContain("the nearest line that does is 2");
		expect(after(SOURCE, '["sub","all","nothing","x"]')).toContain("does not contain");
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
			'["sub",3,"sum = 0","sum = 1"]',
			'["sub",2,"sum = 0","sum = 1"]',
		]);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toContain("<rejection>");
		// The retry carries the rejected reply and why it was rejected.
		expect(requests[1]).toContain('["sub",3,"sum = 0","sum = 1"]');
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
	it("splits `# path` sections and merges sections naming the same file", () => {
		expect(
			parseMagicInput(
				"# a.ts\nRename x to y.\n\n# b.ts\nDelete line 3.\n# a.ts\nThen drop the import.\n",
				"markdown",
			),
		).toEqual([
			{ path: "a.ts", change: "Rename x to y.\n\nThen drop the import." },
			{ path: "b.ts", change: "Delete line 3." },
		]);
	});

	it("rejects text before the first header and a section without changes", () => {
		expect(() => parseMagicInput("Rename x to y.\n# a.ts\nok", "markdown")).toThrow("# path");
		expect(() => parseMagicInput("# a.ts\n# b.ts\nDelete line 3.", "markdown")).toThrow("a.ts");
	});

	it("reads xml `<edit file>` elements, inline or multi-line, and keeps `# ` lines as change text", () => {
		const input =
			'<edit file="a.ts">\n# Heading stays text\nRename x to y.\n</edit>\n\n<edit file="b.ts">Delete line 3.</edit>\n';
		expect(parseMagicInput(input, "xml")).toEqual([
			{ path: "a.ts", change: "# Heading stays text\nRename x to y." },
			{ path: "b.ts", change: "Delete line 3." },
		]);
	});

	it("rejects an unclosed xml element and text outside the elements", () => {
		expect(() => parseMagicInput('<edit file="a.ts">\nRename x to y.', "xml")).toThrow("</edit>");
		expect(() => parseMagicInput('Also fix b.ts.\n<edit file="a.ts">\nok\n</edit>', "xml")).toThrow("<edit file=");
	});
});

describe("edit tool in magic mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A session in `magic` mode whose apply model answers each file's request through `reply`. */
	function magicTool(cwd: string, reply: (request: string) => string, format: "markdown" | "xml" = "markdown") {
		const settings = Settings.isolated({ "edit.mode": "magic", "edit.magic.format": format });
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
		const input = "# sample.ts\nMake total return sum + 1.";
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
		const { tool, requests } = magicTool(tempDir.path(), () => '["sub",2404,"- 300","+ 300"]', "xml");

		await tool.execute("call", {
			input: '<edit file="sample.ts">\nIn `step300()`, replace `return doubled - 300;` with `return doubled + 300;`.\n</edit>',
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("⋮ lines 13-2388 not shown");
		expect(await Bun.file(file).text()).toBe(source.replace("doubled - 300;", "doubled + 300;"));

		const error = await rejectionOf(
			tool.execute("call", { input: '<edit file="sample.ts">\nTidy up the error handling.\n</edit>' }),
		);
		expect(String(error)).toContain("quote the lines to change, or give their line numbers");
		expect(requests).toHaveLength(1);
	});

	it("refuses line operations written against a file that changed while the model was answering", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-stale-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const changed = SOURCE.replace("let sum = 0;", "let sum = 10;");
		const { tool } = magicTool(
			tempDir.path(),
			() => {
				// Someone else saves the file between the read and the write.
				fs.writeFileSync(file, changed);
				return '["delete",6,6]';
			},
			"xml",
		);

		const error = await rejectionOf(
			tool.execute("call", { input: '<edit file="sample.ts">\nDelete the `console.log(sum);` line.\n</edit>' }),
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
			input: '<edit file="sample.ts">\nMake total return sum + 1.\n</edit>',
		});
		expect(used).toEqual(["role-model"]);
	});

	it("reads the payload as xml when edit.magic.format says so", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-xml-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const { tool } = magicTool(tempDir.path(), () => '["sub",7,"sum;","sum + 1;"]', "xml");

		const input = '<edit file="sample.ts">\nMake total return sum + 1.\n</edit>';
		expect(tool.matcherPaths({ input })).toEqual(["sample.ts"]);
		await tool.execute("call", { input });
		expect(await Bun.file(file).text()).toBe(SOURCE.replace("return sum;", "return sum + 1;"));
		// The markdown syntax is not this format's payload.
		const error = await rejectionOf(tool.execute("call", { input: "# sample.ts\nMake total return sum + 2." }));
		expect(String(error)).toContain("<edit file=");
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
			input: "# first.ts\nStart the sum at 1.\n# second.ts\nRemove `drain`.",
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
