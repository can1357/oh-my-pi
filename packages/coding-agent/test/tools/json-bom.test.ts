import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";
import { quotePosixArgument } from "../../src/utils/shell-quote";

async function runJq(command: string): Promise<{ code: number | undefined; output: string }> {
	let output = "";
	const result = await new Shell().run({ command }, (_error, chunk) => {
		output += chunk;
	});
	return { code: result.exitCode, output };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("JSON input BOM decoding", () => {
	let dir: string;
	let json: string;
	let jsonl: string;
	let tool: ReadTool;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-bom-"));
		json = path.join(dir, "bom.json");
		jsonl = path.join(dir, "bom.jsonl");
		await Bun.write(json, '\uFEFF{"ok":true,"items":["a","b","c"],"text":"x\uFEFFy"}\n');
		await Bun.write(jsonl, '\uFEFF{"n":1}\n{"n":2}\n{"n":3}\n');
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new ReadTool(session);
	});

	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("queries BOM-prefixed JSON with raw, compact, and array pagination", async () => {
		expect(textOf(await tool.execute("bom-ok", { path: `${json}?q=.ok` }))).toBe("true");
		expect(textOf(await tool.execute("bom-raw", { path: `${json}?q=.text&raw=true` }))).toBe("x\uFEFFy");
		expect(textOf(await tool.execute("bom-page", { path: `${json}?q=.items&compact=true&limit=2` }))).toBe(
			'["a","b"]\n[1 more items; append ?q=.items&compact=true&limit=2&offset=2 to continue]',
		);
	});

	it("queries a JSONL stream with a BOM only before its first value", async () => {
		expect(textOf(await tool.execute("bom-jsonl", { path: `${jsonl}?q=.n&limit=2` }))).toBe(
			"1\n2\n[more results; append ?q=.n&limit=2&offset=2 to continue]",
		);
	});

	it.each(["file operands", "stdin", "slurpfile", "line-counted input"])(
		"decodes a leading BOM in embedded jq %s",
		async mode => {
			const file = quotePosixArgument(jsonl);
			const commands: Record<string, [string, string]> = {
				"file operands": [`jq -c '.n' ${file} ${file}`, "1\n2\n3\n1\n2\n3\n"],
				stdin: [`cat ${file} | jq -c '.n'`, "1\n2\n3\n"],
				slurpfile: [`jq -nc --slurpfile rows ${file} '$rows[].n'`, "1\n2\n3\n"],
				"line-counted input": [`jq -c '[.n, input_line_number]' ${file}`, "[1,1]\n[2,2]\n[3,3]\n"],
			};
			const [command, output] = commands[mode];
			expect(await runJq(command)).toEqual({ code: 0, output });
		},
	);

	it("preserves BOM bytes in raw input and U+FEFF inside JSON strings", async () => {
		const file = quotePosixArgument(json);
		const result = await runJq(`jq -Rrs '.' ${file}`);
		expect(result.code).toBe(0);
		expect(result.output).toBe(`${await fs.readFile(json, "utf8")}\n`);
	});

	it("rejects malformed JSON, a second leading BOM, and a BOM between JSONL values", async () => {
		for (const [name, input] of [
			["broken", '\uFEFF{"ok":'],
			["double", '\uFEFF\uFEFF{"ok":true}'],
			["midstream", "1\n\uFEFF2\n"],
		]) {
			const file = path.join(dir, `${name}.json`);
			await Bun.write(file, input);
			await expect(tool.execute(name, { path: `${file}?q=.` })).rejects.toThrow(/failed to parse/i);
		}
	});
});
