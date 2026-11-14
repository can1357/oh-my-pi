import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("JSON modifier-only selectors", () => {
	let dir: string;
	let tool: ReadTool;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-modifier-"));
		await Bun.write(path.join(dir, "array.json"), "[1,2,3]");
		await Bun.write(path.join(dir, "events.jsonl"), '{"n":1}\n{"n":2}\n{"n":3}\n');
		await Bun.write(path.join(dir, "events.ndjson"), '"a"\n"b"\n"c"\n');
		await Bun.write(path.join(dir, "string.json"), '"hello"');
		await Bun.write(path.join(dir, "object.json"), '{"ok":true,"nested":{"n":2}}');
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

	it("pages a JSON array with an implicit identity query and a followable continuation", async () => {
		const first = textOf(await tool.execute("array-limit", { path: "array.json?limit=2" }));
		expect(first).toBe("[\n  1,\n  2\n]\n[1 more items; append ?q=.&limit=2&offset=2 to continue]");
		const suffix = /append (\?.*) to continue\]$/.exec(first)?.[1];
		expect(textOf(await tool.execute("array-next", { path: `array.json${suffix}` }))).toBe("[\n  3\n]");
	});

	it("pages JSONL whole values with modifier-only compact and offset parameters", async () => {
		expect(textOf(await tool.execute("jsonl-limit", { path: "events.jsonl?limit=2&compact=true" }))).toBe(
			'{"n":1}\n{"n":2}\n[more results; append ?q=.&compact=true&limit=2&offset=2 to continue]',
		);
		expect(textOf(await tool.execute("jsonl-offset", { path: "events.jsonl?offset=1&limit=1&compact=true" }))).toBe(
			'{"n":2}\n[more results; append ?q=.&compact=true&limit=1&offset=2 to continue]',
		);
	});

	it("supports modifier-only raw strings, compact objects, and NDJSON streams", async () => {
		expect(textOf(await tool.execute("string-raw", { path: "string.json?raw=true" }))).toBe("hello");
		expect(textOf(await tool.execute("object-compact", { path: "object.json?compact=true" }))).toBe(
			'{"ok":true,"nested":{"n":2}}',
		);
		expect(textOf(await tool.execute("ndjson-raw", { path: "events.ndjson?raw=true&limit=2" }))).toBe(
			"a\nb\n[more results; append ?q=.&raw=true&limit=2&offset=2 to continue]",
		);
	});

	it("retains the default page size and continuation for an offset-only selector", async () => {
		await Bun.write(path.join(dir, "long.json"), JSON.stringify(Array.from({ length: 102 }, (_, i) => i)));
		const result = textOf(await tool.execute("offset-only", { path: "long.json?offset=1&compact=true" }));
		const [values, hint] = result.split("\n");
		expect(JSON.parse(values)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
		expect(hint).toBe("[1 more items; append ?q=.&compact=true&limit=100&offset=101 to continue]");
	});

	it("treats empty q and query aliases as the identity query", async () => {
		for (const name of ["q", "query"]) {
			expect(textOf(await tool.execute(`empty-${name}`, { path: `object.json?${name}=&compact=true` }))).toBe(
				'{"ok":true,"nested":{"n":2}}',
			);
		}
	});

	it("does not reinterpret unknown query parameters as JSON selectors", async () => {
		await expect(tool.execute("unknown-selector", { path: "array.json?download=1" })).rejects.toThrow(
			/Path .*download=1.*not found/,
		);
	});

	it.skipIf(process.platform === "win32")("prefers literal filenames containing modifier-like queries", async () => {
		await Bun.write(path.join(dir, "array.json?limit=2"), "literal limit file\n");
		expect(textOf(await tool.execute("literal-modifier", { path: "array.json?limit=2" }))).toContain(
			"literal limit file",
		);
	});
});
