import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { EditTool, magicEditSchema } from "@oh-my-pi/pi-coding-agent/edit";
import { applyDescribedChange, parseMagicInput, parseMagicReply } from "@oh-my-pi/pi-coding-agent/edit/magic";
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

function block(search: string, replace: string, marker = "SEARCH"): string {
	return `<<<<<<< ${marker}\n${search}\n=======\n${replace === "" ? "" : `${replace}\n`}>>>>>>> REPLACE`;
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
async function run(replies: string[], content = SOURCE) {
	const tempDir = TempDir.createSync("@omp-magic-edit-");
	const file = path.join(tempDir.path(), "sample.ts");
	await Bun.write(file, content);
	const editor = new EditTool(makeSession(tempDir.path(), Settings.isolated({})), "replace");
	const requests: string[] = [];
	const outcome = applyDescribedChange({
		path: "sample.ts",
		change: "described change",
		content,
		complete: async request => {
			requests.push(request);
			const reply = replies.shift();
			if (reply === undefined) throw new Error("the model was asked for more replies than scripted");
			return reply;
		},
		apply: edits => editor.execute("call", { path: "sample.ts", edits }),
	});
	return { outcome, requests, read: () => Bun.file(file).text(), dispose: () => tempDir.removeSync() };
}

describe("parseMagicReply", () => {
	it("reads blocks through fences and commentary, and marks SEARCH ALL", () => {
		const reply = `Here is the edit:\n\`\`\`\n${block("a", "b")}\n\`\`\`\n${block("old", "new", "SEARCH ALL")}\n`;
		expect(parseMagicReply(reply)).toEqual({
			kind: "blocks",
			blocks: [
				{ search: ["a"], replace: ["b"], all: false },
				{ search: ["old"], replace: ["new"], all: true },
			],
		});
	});

	it("treats a CANNOT first line as a refusal even when blocks follow", () => {
		expect(parseMagicReply(`CANNOT: no function named drain\n${block("a", "b")}`)).toEqual({
			kind: "refusal",
			reason: "no function named drain",
		});
	});

	it("rejects an unclosed block, a reply without blocks, and an empty SEARCH", () => {
		expect(parseMagicReply("<<<<<<< SEARCH\na\n=======\nb\n").kind).toBe("malformed");
		expect(parseMagicReply("I changed the file as requested.").kind).toBe("malformed");
		expect(parseMagicReply("<<<<<<< SEARCH\n=======\nb\n>>>>>>> REPLACE").kind).toBe("malformed");
	});
});

describe("applyDescribedChange", () => {
	it("deletes whole lines for an empty REPLACE instead of leaving a blank line", async () => {
		const { outcome, read, dispose } = await run([block("\tconsole.log(sum);", "")]);
		await outcome;
		expect(await read()).toBe(SOURCE.replace("\tconsole.log(sum);\n", ""));
		dispose();
	});

	it("deletes the unterminated last line together with the newline before it", async () => {
		const { outcome, read, dispose } = await run([block("last", "")], "first\nlast");
		await outcome;
		expect(await read()).toBe("first");
		dispose();
	});

	it("renames every occurrence with SEARCH ALL and applies later blocks to the result", async () => {
		const { outcome, read, dispose } = await run([
			`${block("sum", "acc", "SEARCH ALL")}\n${block("\tlet acc = 0;", "\tlet acc = 1;")}`,
		]);
		await outcome;
		const after = await read();
		expect(after).not.toContain("sum");
		expect(after).toContain("\tlet acc = 1;\n");
		expect(after).toContain("\treturn acc;\n");
		dispose();
	});

	it("sends a rejected batch back with its rejection and applies the corrected reply", async () => {
		const { outcome, requests, read, dispose } = await run([
			block("\tlet total = 0;", "\tlet sum = 1;"),
			block("\tlet sum = 0;", "\tlet sum = 1;"),
		]);
		await outcome;
		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toContain("<rejection>");
		// The retry carries the rejected reply and the engine's reason for it.
		expect(requests[1]).toContain("\tlet total = 0;");
		expect(requests[1]).toMatch(/<rejection>\n[^<]*sample\.ts/);
		expect(await read()).toBe(SOURCE.replace("let sum = 0;", "let sum = 1;"));
		dispose();
	});

	it("applies nothing from a batch whose later block fails", async () => {
		const failing = `${block("\tlet sum = 0;", "\tlet sum = 1;")}\n${block("\tno such line", "\tx")}`;
		const { outcome, requests, read, dispose } = await run([failing, failing, failing]);
		const error = await rejectionOf(outcome);
		expect(String(error)).toContain("the file is unchanged");
		expect(requests).toHaveLength(3);
		expect(await read()).toBe(SOURCE);
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

	it("shows the model the file behind line numbers", async () => {
		const { outcome, requests, dispose } = await run([block("\treturn sum;", "\treturn sum + 0;")]);
		await outcome;
		expect(requests[0]).toContain("2\t\tlet sum = 0;\n3\t\tfor (const item of items) {");
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

describe("edit tool in magic_edit mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A session in `magic_edit` mode whose apply model answers each file's request through `reply`. */
	function magicTool(cwd: string, reply: (request: string) => string, format: "markdown" | "xml" = "markdown") {
		const settings = Settings.isolated({ "edit.mode": "magic_edit", "edit.magic.format": format });
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
		const { tool, requests } = magicTool(tempDir.path(), () => block("\treturn sum;", "\treturn sum + 1;"));

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

	it("reads the payload as xml when edit.magic.format says so", async () => {
		using tempDir = TempDir.createSync("@omp-magic-edit-xml-");
		const file = path.join(tempDir.path(), "sample.ts");
		await Bun.write(file, SOURCE);
		const { tool } = magicTool(tempDir.path(), () => block("\treturn sum;", "\treturn sum + 1;"), "xml");

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
			request.includes("File `second.ts`")
				? "CANNOT: there is no `drain` function here"
				: block("\tlet sum = 0;", "\tlet sum = 1;"),
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
