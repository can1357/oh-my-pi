import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, AssistantMessage, Message, Model, Tool, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, magicEditSchema } from "@oh-my-pi/pi-coding-agent/edit";
import { applyDescribedChange, parseMagicInput } from "@oh-my-pi/pi-coding-agent/edit/magic";
import { applyReplace, readBufferLines } from "@oh-my-pi/pi-coding-agent/edit/magic-tools";
import { fileViews } from "@oh-my-pi/pi-coding-agent/edit/magic-view";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initWorktreeFixture } from "./helpers/git-worktree";
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

let callSeq = 0;

function toolMsg(calls: Array<{ name: string; arguments: Record<string, unknown> }>, text = ""): AssistantMessage {
	const base = createAssistantMessage(text);
	const blocks: AssistantMessage["content"] = text ? [{ type: "text", text }] : [];
	for (const call of calls) {
		blocks.push({
			type: "toolCall",
			id: `tc_${++callSeq}`,
			name: call.name,
			arguments: call.arguments,
		} satisfies ToolCall);
	}
	return { ...base, content: blocks, stopReason: "toolUse" };
}

function textMsg(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { ...createAssistantMessage(text), stopReason };
}

/** Drive the change through the real `replace` engine against a file on disk, with scripted assistant turns. */
async function run(
	turns: Array<AssistantMessage | ((messages: Message[], tools: Tool[]) => AssistantMessage)>,
	content = SOURCE,
	change = "described change",
) {
	const tempDir = TempDir.createSync("@omp-magic-edit-");
	const file = path.join(tempDir.path(), "sample.ts");
	await Bun.write(file, content);
	const editor = new EditTool(makeSession(tempDir.path(), Settings.isolated({})), "replace");
	const transcripts: Message[][] = [];
	const outcome = applyDescribedChange({
		path: "sample.ts",
		change,
		content,
		complete: async (messages, tools) => {
			transcripts.push([...messages]);
			const next = turns.shift();
			if (next === undefined) throw new Error("the model was asked for more turns than scripted");
			return typeof next === "function" ? next(messages, tools) : next;
		},
		apply: edits => editor.execute("call", { path: "sample.ts", edits }),
	});
	return { outcome, transcripts, read: () => Bun.file(file).text(), dispose: () => tempDir.removeSync() };
}

describe("fileViews", () => {
	const long = longSource(50);
	const markers = (text: string) => text.split("\n").filter(line => line.startsWith("⋮"));

	it("shows a long file as plain-numbered named blocks with context, head and tail, then whole", () => {
		const [excerpt, whole] = fileViews(
			long,
			"In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.",
		);
		expect(excerpt.partial).toBe(true);
		expect(excerpt.totalLines).toBe(400);
		expect(markers(excerpt.text)).toEqual(["⋮ lines 13-228 not shown", "⋮ lines 260-388 not shown"]);
		expect(excerpt.text).toContain(
			"241│export function step30(input: number): number {\n242│\tconst doubled = input * 2;",
		);
		expect(excerpt.text.startsWith("1│export function step0(")).toBe(true);
		expect(excerpt.text.endsWith("400│")).toBe(true);
		expect(whole).toEqual({
			partial: false,
			totalLines: 400,
			text: expect.stringContaining("\n100│\t\treturn doubled - 12;\n"),
		});
	});

	it("locates qualified method names, ln references, and repeating lines, and merges tiny gaps", () => {
		const lines = Array.from({ length: 260 }, (_, i) => `\tlet v${i} = ${i};`);
		lines[0] = "impl Line {";
		lines[120] = "\tfn blank() {";
		lines[121] = "\t\treturn 0;";
		lines[122] = "\t}";
		lines[259] = "}";
		const content = lines.join("\n");
		const [excerpt] = fileViews(content, "In `Line::blank`, ln 150, and ln 180, update body.");
		expect(excerpt.partial).toBe(true);
		expect(excerpt.text).toContain("121│\tfn blank() {");
		expect(excerpt.text).toContain("\n150│");
		expect(excerpt.text).toContain("\n165│");
		expect(excerpt.text).toContain("\n180│");
		const gaps = markers(excerpt.text);
		expect(gaps).toHaveLength(2);
		for (const gap of gaps) {
			const match = /lines (\d+)-(\d+) not shown/.exec(gap);
			if (match) expect(Number(match[2]) - Number(match[1]) + 1).toBeGreaterThan(8);
		}

		// `const doubled = input * 2;` is in all fifty functions; co-location keeps only step30's copy.
		const [repeated] = fileViews(
			long,
			"In `step30()`, change `const doubled = input * 2;` to `const doubled = input * 3;`.",
		);
		expect(repeated.text).toContain("\n242│\tconst doubled = input * 2;\n");
		expect(repeated.text).not.toContain("\n202│");
		expect(markers(repeated.text)).toHaveLength(2);
	});

	it("shows whole files when short or mostly named, and falls back to head+tail when an unnamed file exceeds the limit", () => {
		const whole = (content: string, change: string) => fileViews(content, change).map(view => view.partial);
		expect(whole(SOURCE, "In `total`, delete `console.log(sum);`.")).toEqual([false]);
		expect(whole(long, "Tidy up the error handling.")).toEqual([false]);
		const many = Array.from({ length: 25 }, (_, n) => `\`step${2 * n}(\``).join(", ");
		expect(whole(long, `Add a comment above each of ${many}.`)).toEqual([false]);

		const named = "In `step30()`, return `doubled + 30`.";
		expect(fileViews(long, named, 4000).map(view => view.partial)).toEqual([true]);
		// Unnamed file too long for `limit` gets a compact head+tail preview so the model can search/read.
		const [fallback] = fileViews(long, "Tidy up the error handling.", 4000);
		expect(fallback.partial).toBe(true);
		expect(fallback.text).toContain("⋮ Open more of the file");
		expect(fallback.text).not.toContain("step30(");
	});
});

describe("magic-tools", () => {
	it("refuses ambiguous anchors unless replace_all is explicit and treats replacement text literally", () => {
		const args = { old_string: "sum", new_string: "$&" };
		expect(applyReplace(SOURCE, args)).toEqual({ error: expect.stringContaining("matches more than once") });
		expect(applyReplace(SOURCE, { ...args, replace_all: true })).toMatchObject({
			content: SOURCE.replaceAll("sum", () => "$&"),
		});
	});

	it("points out the copied gutter and shows the exact draft lines without staging a guess", () => {
		const source = "header\n\tstart();\n    first();\n\tsecond();\nend();\ncleanup();\ntrailer\n";
		const args = {
			old_string: "2│\tstart();\n\t    first();\n\tsecond();\n5\tend();\n│cleanup();",
			new_string: "logged();",
		};
		const result = applyReplace(source, args);
		expect(result).toEqual({
			error: expect.stringContaining("2│\tstart();\n3│    first();\n4│\tsecond();\n5│end();\n6│cleanup();"),
		});
		expect("error" in result && result.error).toContain("gutter was copied");
		expect(applyReplace(source + source, args)).toEqual({
			error: expect.stringContaining("Search for a short fragment"),
		});
	});

	it("offers the exact numbered lines only for unique whitespace-drift matches", () => {
		const source = "start();\n\tconst count = 1;\n\treturn count + 2;\nend();\n";
		const args = { old_string: "    const count=1;\n    return count+2;", new_string: "return 0;" };
		expect(applyReplace(source, args)).toEqual({
			error: expect.stringMatching(/Whitespace differs[\s\S]*2│\tconst count = 1;\n3│\treturn count \+ 2;/),
		});
		expect(applyReplace(source + source, args)).toEqual({
			error: expect.stringContaining("Search for a short fragment"),
		});
	});

	it("points to an already-present replacement when the old text is gone", () => {
		const args = { old_string: "return pending;", new_string: "return ready;" };
		expect(applyReplace("header\nreturn ready;\n", args)).toEqual({
			error: expect.stringMatching(/new_string is already present on line 2.*already applied/),
		});
	});

	it("shows post-edit line numbers, replacement text, and two surrounding lines", () => {
		const source = "far before\nbefore one\nbefore two\nold\nafter one\nafter two\nfar after";
		const result = applyReplace(source, { old_string: "old", new_string: "new one\nnew two" });
		expect(result).toMatchObject({
			content: source.replace("old", "new one\nnew two"),
			message: expect.stringMatching(
				/\n2│before one\n3│before two\n4│new one\n5│new two\n6│after one\n7│after two$/,
			),
		});
	});

	it("keeps an edit visible on a wide line without echoing the entire line", () => {
		const source = `${"x".repeat(10_000)}old${"y".repeat(10_000)}`;
		const result = applyReplace(source, { old_string: "old", new_string: "updated" });
		const message = "message" in result ? result.message : "";
		expect(message).toMatch(/1│…x+updatedy+…/);
		expect(message.length < 2_000).toBe(true);
	});

	it("counts all matches and caps the list of original affected lines", () => {
		const source = "old old\n".repeat(60);
		const result = applyReplace(source, { old_string: "old", new_string: "new\ntext", replace_all: true });
		expect(result).toMatchObject({
			content: source.replaceAll("old", "new\ntext"),
			message: expect.stringMatching(/Replaced 120 matches \(original lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …\)/),
		});
	});

	it("refuses replace_all on whitespace-only anchors", () => {
		expect(applyReplace("start\n\t \nend", { old_string: "\t \n", new_string: "", replace_all: true })).toEqual({
			error: expect.stringContaining("whitespace-only old_string"),
		});
	});

	it("tells the model to send an explicit empty replacement when deleting", () => {
		expect(applyReplace("delete this", { old_string: "delete this" })).toEqual({
			error: expect.stringMatching(/new_string is required.*pass "" to delete/),
		});
	});

	it("bounds read output and tells the model how to resume after an oversized line", () => {
		const source = "x".repeat(20_000) + "\nlet next = 1;\n";
		const result = readBufferLines(source, { start_line: 1, end_line: 2 });
		expect(result).toEqual({ text: expect.stringContaining("starting at line 2") });
		expect("text" in result && result.text.length < 8_100).toBe(true);
		expect(readBufferLines(source, { start_line: 2, end_line: 2 })).toEqual({
			text: expect.stringContaining("2│let next = 1;"),
		});
	});
});

describe("applyDescribedChange", () => {
	it("runs tool calls a model writes as fenced JSON instead of native calls", async () => {
		const fenced = (lang: string, value: unknown) => `\`\`\`${lang}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
		const { outcome, transcripts, read, dispose } = await run([
			// Gemma 3's spellings: arguments beside `function`, with `null` for an omitted option…
			textMsg(
				fenced("tool_code", [
					{ function: "replace", old_string: "\tconsole.log(sum);\n", new_string: "", replace_all: null },
					// …and a nested `function` object.
					{ function: { name: "search", parameters: { query: "return sum" } } },
				]),
			),
			// The tool name as the only key; a JSON block naming no apply tool is not a call.
			textMsg(
				`${fenced("json", { replace: { old_string: "items: number[]", new_string: "items: readonly number[]" } })}\n${fenced("json", { name: "write", arguments: {} })}`,
			),
			textMsg("DONE"),
		]);
		await outcome;
		const results = (n: number) => transcripts[n].filter(m => m.role === "toolResult").map(m => m.isError);
		expect(results(1)).toEqual([false, false]);
		expect(results(2)).toEqual([false, false, false]);
		expect(await read()).toBe(
			SOURCE.replace("\tconsole.log(sum);\n", "").replace("items: number[]", "items: readonly number[]"),
		);
		dispose();
	});

	it("applies multiple replace tool calls across turns while preserving prior edits after a miss", async () => {
		const { outcome, transcripts, read, dispose } = await run([
			// Turn 1: one replace succeeds, the second has a typo.
			toolMsg([
				{ name: "replace", arguments: { old_string: "\tconsole.log(sum);\n", new_string: "" } },
				{ name: "replace", arguments: { old_string: "\treturn sum_wrong;", new_string: "\treturn sum + 1;" } },
			]),
			// A premature DONE cannot write a draft with a failed replacement.
			textMsg("DONE"),
			toolMsg([{ name: "read", arguments: { start_line: 5, end_line: 7 } }]),
			// The model fixes only the failed replace; the deletion stayed in the draft.
			toolMsg([{ name: "replace", arguments: { old_string: "\treturn sum;", new_string: "\treturn sum + 1;" } }]),
			// Turn 3: done.
			textMsg("DONE"),
		]);
		await outcome;
		const turn2ToolResults = transcripts[1].filter(m => m.role === "toolResult");
		expect(turn2ToolResults).toHaveLength(2);
		expect(turn2ToolResults[0].isError).toBe(false);
		expect(turn2ToolResults[1].isError).toBe(true);
		expect(turn2ToolResults[1].content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("old_string not found"),
		});
		expect(String(transcripts[2].at(-1)?.content)).toContain("replacement failed");
		expect(transcripts[3].at(-1)?.content).toEqual([
			{ type: "text", text: expect.stringContaining("6│\treturn sum;") },
		]);
		expect(await read()).toBe(SOURCE.replace("\tconsole.log(sum);\n", "").replace("return sum;", "return sum + 1;"));
		dispose();
	});

	it("inspects omitted regions of a long file via search and read, then edits them", async () => {
		const long = longSource(50);
		const { outcome, transcripts, read, dispose } = await run(
			[
				// Excerpt shows step30; model searches for step10 which was omitted.
				toolMsg([{ name: "search", arguments: { query: "step10(" } }]),
				toolMsg([{ name: "read", arguments: { start_line: 81, end_line: 88 } }]),
				toolMsg([
					{
						name: "replace",
						arguments: { old_string: "return doubled - 10;", new_string: "return doubled + 10;" },
					},
				]),
				textMsg("DONE"),
			],
			long,
			"In `step30()`, check how the earlier helpers work, and make the tenth helper add its threshold.",
		);
		await outcome;
		expect(transcripts).toHaveLength(4);
		expect(String(transcripts[0][0].content)).not.toContain("export function step10(");
		expect(transcripts[1].at(-1)?.content).toEqual([
			{ type: "text", text: expect.stringContaining("81│export function step10(") },
		]);
		expect(transcripts[2].at(-1)?.content).toEqual([
			{ type: "text", text: expect.stringContaining("84│\t\treturn doubled - 10;") },
		]);
		expect(await read()).toBe(long.replace("return doubled - 10;", "return doubled + 10;"));
		dispose();
	});

	it("catches syntax errors before writing, pinpoints the breaking replace with live lines, and commits after repair", async () => {
		const { outcome, transcripts, read, dispose } = await run([
			// Edit #1 is valid; Edit #2 leaves an unclosed brace.
			toolMsg([
				{ name: "replace", arguments: { old_string: "let sum = 0;", new_string: "let sum = 1;" } },
				{
					name: "replace",
					arguments: { old_string: "\t}\n\tconsole.log(sum);", new_string: "\tconsole.log(sum);" },
				},
			]),
			// Model thinks it is done, triggering the syntax check.
			textMsg("DONE"),
			// Model receives diagnosis pointing at replace #2 and fixes only the missing brace.
			toolMsg([
				{
					name: "replace",
					arguments: {
						old_string: "\t\tsum += item;\n\tconsole.log(sum);",
						new_string: "\t\tsum += item;\n\t}\n\tconsole.log(sum);",
					},
				},
			]),
			textMsg("DONE"),
		]);
		await outcome;
		expect(transcripts).toHaveLength(4);
		const syntaxFeedback = String(transcripts[2].at(-1)?.content);
		expect(syntaxFeedback).toContain("no longer parses");
		expect(syntaxFeedback).toContain("replace #2");
		expect(syntaxFeedback).toContain("4│\t\tsum += item;");
		// Edit #1 (`sum = 1`) survived the syntax recovery without being re-emitted.
		expect(await read()).toBe(SOURCE.replace("let sum = 0;", "let sum = 1;"));
		dispose();
	});

	it("stops at a whole-file CANNOT refusal, and widens afresh when declined on an uninspected excerpt", async () => {
		const whole = await run([textMsg("CANNOT: `drain` is not in this file")]);
		const wholeErr = await rejectionOf(whole.outcome);
		expect(String(wholeErr)).toContain("`drain` is not in this file");
		expect(whole.transcripts).toHaveLength(1);
		expect(await whole.read()).toBe(SOURCE);
		whole.dispose();

		const excerpt = await run(
			[
				textMsg("CANNOT: target is omitted"),
				toolMsg([
					{
						name: "replace",
						arguments: { old_string: "return doubled - 30;", new_string: "return doubled + 30;" },
					},
				]),
				textMsg("DONE"),
			],
			longSource(50),
			"In `step30()`, replace `return doubled - 30;` with `return doubled + 30;`.",
		);
		await excerpt.outcome;
		expect(excerpt.transcripts).toHaveLength(3);
		expect(String(excerpt.transcripts[0][0].content)).toContain("⋮");
		expect(String(excerpt.transcripts[1][0].content)).not.toContain("⋮");
		expect(await excerpt.read()).toContain("return doubled + 30;");
		excerpt.dispose();
	});

	it("nudges once when the model replies with prose instead of calling a tool, and recovers", async () => {
		const { outcome, transcripts, read, dispose } = await run([
			textMsg("I will update line 7 to return sum + 1."),
			toolMsg([{ name: "replace", arguments: { old_string: "return sum;", new_string: "return sum + 1;" } }]),
			textMsg("DONE"),
		]);
		await outcome;
		expect(transcripts).toHaveLength(3);
		expect(String(transcripts[1].at(-1)?.content)).toContain("Apply the requested changes");
		expect(await read()).toBe(SOURCE.replace("return sum;", "return sum + 1;"));
		dispose();
	});

	it("recovers once from a length-truncated turn by asking for smaller replace calls", async () => {
		const { outcome, transcripts, read, dispose } = await run([
			{
				...toolMsg([{ name: "replace", arguments: { old_string: "let sum = 0;", new_string: "let sum = 99;" } }]),
				stopReason: "length",
			},
			toolMsg([{ name: "replace", arguments: { old_string: "return sum;", new_string: "return sum + 1;" } }]),
			textMsg("DONE"),
		]);
		await outcome;
		expect(transcripts).toHaveLength(3);
		expect(String(transcripts[1].at(-1)?.content)).toContain("output limit");
		expect(await read()).toBe(SOURCE.replace("return sum;", "return sum + 1;"));
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

	/** A session in `magic` mode whose apply model answers each completion turn through `respond`. */
	function magicTool(cwd: string, respond: (messages: Message[], tools: Tool[] | undefined) => AssistantMessage) {
		const settings = Settings.isolated({ "edit.mode": "magic" });
		settings.setModelRole("smol", "llama.cpp/apply-model");
		const session = makeSession(cwd, settings, {
			modelRegistry: {
				getAvailable: () => [APPLY_MODEL],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
		});
		const calls: Array<{ messages: Message[]; tools: Tool[] | undefined }> = [];
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, context) => {
			calls.push({ messages: [...context.messages], tools: context.tools });
			return Promise.resolve(respond(context.messages, context.tools));
		});
		return { tool: new EditTool(session), calls };
	}

	it("takes a `# path` payload, drives the apply tools, and returns the applied diff", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-tool-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const { tool, calls } = magicTool(tempDir.path(), messages =>
			messages.length === 1
				? toolMsg([{ name: "replace", arguments: { old_string: "return sum;", new_string: "return sum + 1;" } }])
				: textMsg("DONE"),
		);

		expect(tool.parameters).toBe(magicEditSchema);
		const input = "# sample.ts\n- Make total return sum + 1.";
		expect(tool.matcherPaths({ input })).toEqual(["sample.ts"]);
		const result = await tool.execute("call", { input });

		expect(calls).toHaveLength(2);
		expect(String(calls[0].messages[0]?.content)).toContain("Make total return sum + 1.");
		expect(await Bun.file(file).text()).toBe(SOURCE.replace("return sum;", "return sum + 1;"));
		expect(result.isError).toBeFalsy();
		expect(result.details?.diff).toContain("return sum + 1;");
	});

	it("edits an oversized file through search even when the description names no lines", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-long-");
		const file = path.join(tempDir.path(), "sample.ts");
		// 3,200 lines: exceeds half of the apply model's 32,768-token window.
		const source = longSource(400);
		await Bun.write(file, source);
		let turn = 0;
		const { tool, calls } = magicTool(tempDir.path(), () => {
			turn++;
			if (turn === 1) return toolMsg([{ name: "search", arguments: { query: "doubled - 300;" } }]);
			if (turn === 2) {
				return toolMsg([
					{
						name: "replace",
						arguments: { old_string: "return doubled - 300;", new_string: "return doubled + 300;" },
					},
				]);
			}
			return textMsg("DONE");
		});

		await tool.execute("call", {
			input: "# sample.ts\n- Flip the minus sign in the 300th helper.",
		});
		expect(calls).toHaveLength(3);
		expect(String(calls[0].messages[0]?.content)).toContain("⋮ Open more of the file");
		expect(calls[1].messages.at(-1)?.content).toEqual([
			{ type: "text", text: expect.stringContaining("return doubled - 300;") },
		]);
		expect(await Bun.file(file).text()).toBe(source.replace("doubled - 300;", "doubled + 300;"));
	});

	it("refuses edits written against a file that changed while the model was answering", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-stale-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const changed = SOURCE.replace("let sum = 0;", "let sum = 10;");
		const { tool } = magicTool(tempDir.path(), messages => {
			if (messages.length === 1) {
				// Someone else saves the file between the read and the commit.
				fs.writeFileSync(file, changed);
				return toolMsg([{ name: "replace", arguments: { old_string: "\tconsole.log(sum);\n", new_string: "" } }]);
			}
			return textMsg("DONE");
		});

		const error = await rejectionOf(
			tool.execute("call", { input: "# sample.ts\n- Delete the `console.log(sum);` line." }),
		);
		expect(String(error)).toContain("changed");
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
		vi.spyOn(ai, "completeSimple").mockImplementation((model, context) => {
			used.push(model.id);
			return Promise.resolve(
				context.messages.length === 1
					? toolMsg([{ name: "replace", arguments: { old_string: "return sum;", new_string: "return sum + 1;" } }])
					: textMsg("DONE"),
			);
		});

		await new EditTool(session).execute("call", {
			input: "# sample.ts\n- Make total return sum + 1.",
		});
		expect(used).toEqual(["role-model", "role-model"]);
	});

	it("preserves checkoutNotice on perFileResults when a multi-file magic edit touches a sibling worktree", async () => {
		using tempDir = TempDir.createSync("@omp-magic-worktree-");
		const { cwd, paths } = await initWorktreeFixture(tempDir, [{ name: "linked", branch: "preview" }], {
			files: { "local.ts": "export const value = 1;\n" },
		});

		const siblingFile = path.join(paths.linked, "local.ts");
		const { tool } = magicTool(cwd, messages =>
			messages.length === 1
				? toolMsg([
						{
							name: "replace",
							arguments: { old_string: "export const value = 1;", new_string: "export const value = 2;" },
						},
					])
				: textMsg("DONE"),
		);
		const result = await tool.execute("magic-multi-worktree", {
			input: `# local.ts\n- Change value to 2.\n# ${siblingFile}\n- Change value to 2.\n`,
		});
		expect(result.isError).toBeUndefined();
		expect(result.details?.perFileResults).toHaveLength(2);
		expect(result.details?.perFileResults?.[0]?.checkoutNotice).toBeUndefined();
		expect(result.details?.perFileResults?.[1]?.checkoutNotice).toBe("Edited worktree: preview (session: main)");
	});

	it("applies each file of a batch on its own and reports the one that was refused", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-batch-");
		const first = path.join(tempDir.path(), "first.ts");
		const second = path.join(tempDir.path(), "second.ts");
		await Bun.write(first, SOURCE);
		await Bun.write(second, "export const limit = 1;\n");
		const { tool } = magicTool(tempDir.path(), messages => {
			const header = String(messages[0]?.content);
			if (header.includes("first.ts")) return textMsg("CANNOT: `missing` is not in first.ts");
			return messages.length === 1
				? toolMsg([{ name: "replace", arguments: { old_string: "limit = 1", new_string: "limit = 2" } }])
				: textMsg("DONE");
		});

		const result = await tool.execute("call", {
			input: "# first.ts\n- Rename `missing`.\n# second.ts\n- Set limit to 2.",
		});
		expect(result.isError).toBeUndefined();
		expect(await Bun.file(first).text()).toBe(SOURCE);
		expect(await Bun.file(second).text()).toBe("export const limit = 2;\n");
		expect(result.content.map(b => (b.type === "text" ? b.text : "")).join("\n")).toContain("[first.ts] not applied");
	});
});

describe("call intake", () => {
	const changedReturn = "return sum + 1;";
	const updateReturn = { name: "replace", arguments: { old_string: "return sum;", new_string: changedReturn } };
	const revised = SOURCE.replace("return sum;", changedReturn);
	const fenced = (language: string, body: string) => `\`\`\`${language}\n${body}\n\`\`\``;
	const results = (messages: Message[]) =>
		messages
			.filter(message => message.role === "toolResult")
			.map(message => ({
				name: message.toolName,
				error: message.isError,
				text: message.content.map(block => (block.type === "text" ? block.text : "")).join(""),
			}));

	it.each([
		{
			shape: "a bare Python line amid prose, with mixed quotes and escapes",
			turns: [
				String.raw`I'll update the return value.
replace(old_string="return sum;", new_string='return sum + \x31;', replace_all=True)`,
			],
			tools: ["replace"],
		},
		{
			shape: "a tool_code fence with multiline triple-quoted Python strings",
			turns: [
				fenced(
					"tool_code",
					`replace(old_string="""\tconsole.log(sum);\n\treturn sum;""",
new_string="""\tconsole.log(sum);\n\treturn sum + 1;""", replace_all=False)`,
				),
			],
			tools: ["replace"],
		},
		{
			shape: "a tool_response fence with a singleton Python call list",
			turns: [
				fenced("tool_response", "[read(start_line=7, end_line=7)]"),
				`replace(old_string='''return sum;''', new_string="${changedReturn}")`,
			],
			tools: ["read", "replace"],
		},
		{
			shape: "a python fence with several calls in one list",
			turns: [
				fenced(
					"python",
					`[read(start_line=7, end_line=7),
replace(old_string='return sum;', new_string='${changedReturn}', replace_all=None),
search(query='${changedReturn}')]`,
				),
			],
			tools: ["read", "replace", "search"],
		},
	])("runs $shape and writes the edited draft", async ({ turns, tools }) => {
		const { outcome, transcripts, read, dispose } = await run([...turns.map(text => textMsg(text)), textMsg("DONE")]);
		try {
			await outcome;
			expect(results(transcripts.at(-1)!).map(({ name, error }) => ({ name, error }))).toEqual(
				tools.map(name => ({ name, error: false })),
			);
			expect(await read()).toBe(revised);
		} finally {
			dispose();
		}
	});

	it("takes Python literals in fenced JSON without translating words inside replacement text", async () => {
		const { outcome, read, dispose } = await run([
			textMsg(
				fenced(
					"json",
					`[
{"replace":{"old_string":"let sum = 0;","new_string":"let sum = 1;","replace_all":True}},
{"replace":{"old_string":"return sum;","new_string":"return sum + 1; // False None True","replace_all":None}},
{"replace":{"old_string":"console.log(sum);","new_string":"console.info(sum);","replace_all":False}}
]`,
				),
			),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			expect(await read()).toBe(
				revised
					.replace("let sum = 0;", "let sum = 1;")
					.replace("console.log", "console.info")
					.replace(changedReturn, `${changedReturn} // False None True`),
			);
		} finally {
			dispose();
		}
	});

	it("does not run a call mentioned in ordinary prose", async () => {
		const { outcome, transcripts, read, dispose } = await run([
			textMsg('I can use replace(old_string="return sum;", new_string="return sum + 999;") for this.'),
			toolMsg([updateReturn]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			expect(results(transcripts[1])).toEqual([]);
			expect(String(transcripts[1].at(-1)?.content)).toContain("Apply the requested changes");
			expect(await read()).toBe(revised);
		} finally {
			dispose();
		}
	});

	it("normalizes native null options, boolean strings and integer strings against tool schemas", async () => {
		const content = `${SOURCE}// return sum;\n`;
		const { outcome, transcripts, read, dispose } = await run(
			[
				toolMsg([
					{ name: "read", arguments: { start_line: "7", end_line: "7" } },
					{
						name: "replace",
						arguments: { old_string: "console.log", new_string: "console.info", replace_all: null },
					},
					{
						name: "replace",
						arguments: { old_string: "let sum = 0;", new_string: "let sum = 1;", replace_all: "false" },
					},
					{ name: "replace", arguments: { ...updateReturn.arguments, replace_all: "true" } },
				]),
				textMsg("DONE"),
			],
			content,
		);
		try {
			await outcome;
			expect(results(transcripts[1])[0]).toMatchObject({ error: false, text: expect.stringContaining("Lines 7-7") });
			expect(await read()).toBe(
				content
					.replace("console.log", "console.info")
					.replace("let sum = 0;", "let sum = 1;")
					.replaceAll("return sum;", changedReturn),
			);
		} finally {
			dispose();
		}
	});

	it("reports glued native JSON objects that disagree instead of dispatching partial arguments", async () => {
		const error = "Unexpected non-whitespace after JSON object";
		const { outcome, transcripts, read, dispose } = await run([
			toolMsg([
				{
					name: "replace",
					arguments: {
						__parseError: error,
						__rawJson:
							'{"old_string":"return sum;","new_string":"return sum + 999;"}{"old_string":"return sum;"}',
					},
				},
			]),
			toolMsg([updateReturn]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			const [result] = results(transcripts[1]);
			expect(result.error).toBe(true);
			expect(result.text).toContain("Malformed replace arguments");
			expect(result.text).toContain(error);
			expect(result.text).toContain("one JSON object per call");
			expect(await read()).toBe(revised);
		} finally {
			dispose();
		}
	});

	it("runs one native call when all glued JSON objects represent the same arguments", async () => {
		const new_string = '// } { "quoted"\n\treturn sum + 1;';
		const old_string = "return sum;";
		const object = JSON.stringify({ old_string, new_string });
		const repeated = JSON.stringify({ new_string, old_string });
		const { outcome, transcripts, read, dispose } = await run([
			toolMsg([
				{
					name: "replace",
					arguments: {
						__parseError: "Unexpected non-whitespace after JSON object",
						__rawJson: `${object} \n ${repeated}${object}`,
					},
				},
			]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			expect(results(transcripts[1])).toMatchObject([{ name: "replace", error: false }]);
			expect(await read()).toBe(SOURCE.replace(old_string, new_string));
		} finally {
			dispose();
		}
	});

	it("reports the original error when an identical failed replace is retried", async () => {
		const miss = { ...updateReturn, arguments: { ...updateReturn.arguments, old_string: "return missing;" } };
		const { outcome, transcripts, read, dispose } = await run([
			toolMsg([miss]),
			toolMsg([{ name: "replace", arguments: { new_string: changedReturn, old_string: "return missing;" } }]),
			toolMsg([updateReturn]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			const [first, retry] = results(transcripts[2]);
			expect(first.error).toBe(true);
			expect(retry.error).toBe(true);
			expect(retry.text).toContain("already failed");
			expect(retry.text).toContain(first.text);
			expect(await read()).toBe(revised);
		} finally {
			dispose();
		}
	});

	it("reports an already applied replace without repeating it or preventing DONE", async () => {
		const replacement = {
			name: "replace",
			arguments: { old_string: "return sum;", new_string: "// once\n\treturn sum;" },
		};
		const { outcome, transcripts, read, dispose } = await run([
			toolMsg([replacement]),
			toolMsg([replacement]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			const [, retry] = results(transcripts[2]);
			expect(retry).toMatchObject({ error: true, text: expect.stringContaining("already applied") });
			expect(await read()).toBe(SOURCE.replace(replacement.arguments.old_string, replacement.arguments.new_string));
		} finally {
			dispose();
		}
	});

	it.each([
		["positional arguments", 'replace("return sum;", "return sum + 999;")'],
		["a nonliteral expression", 'replace(old_string="return sum;", new_string="return " + "sum + 999;")'],
		[
			"an unknown tool in a call list",
			'[replace(old_string="return sum;", new_string="return sum + 999;"), write()]',
		],
		[
			"malformed fenced call text",
			fenced("tool_code", '[replace(old_string="return sum;" new_string="return sum + 999;")]'),
		],
	])("gives call-format feedback for %s without dispatching a partial call", async (_shape, malformed) => {
		const { outcome, transcripts, read, dispose } = await run([
			textMsg(malformed),
			toolMsg([updateReturn]),
			textMsg("DONE"),
		]);
		try {
			await outcome;
			expect(results(transcripts[1])).toEqual([]);
			const feedback = String(transcripts[1].at(-1)?.content);
			expect(feedback).toContain("native tool calls");
			expect(feedback).toContain("one JSON object per call");
			expect(feedback).toContain("fenced block");
			expect(await read()).toBe(revised);
		} finally {
			dispose();
		}
	});
});
