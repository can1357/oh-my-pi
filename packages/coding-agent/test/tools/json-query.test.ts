import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ReadTool } from "../../src/tools/read";

type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
};

type SessionLike = ConstructorParameters<typeof ReadTool>[0];

function getText(result: ToolTextResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<SessionLike> = {}): SessionLike {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as SessionLike;
}

describe("JSON query in read tool", () => {
	let tempDir: string;
	let jsonFile: string;
	let jsonlFile: string;
	let numbersFile: string;
	let mixedFile: string;
	let failingLineFile: string;
	let session: SessionLike;
	let readTool: ReadTool;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-test-"));
		jsonFile = path.join(tempDir, "data.json");
		jsonlFile = path.join(tempDir, "events.jsonl");
		numbersFile = path.join(tempDir, "numbers.json");
		mixedFile = path.join(tempDir, "mixed.json");
		failingLineFile = path.join(tempDir, "failing.jsonl");

		const testData = {
			name: "my-project",
			version: "1.2.3",
			active: true,
			items: [
				{ id: 1, name: "item-one", active: true },
				{ id: 2, name: "item-two", active: false },
				{ id: 3, name: "item-three", active: true },
			],
			metadata: {
				tags: ["alpha", "beta", "gamma"],
				nested: { deep: "secret-value" },
			},
		};

		const testLines = [
			JSON.stringify({ timestamp: "2026-10-01", status: "ok", user: "alice" }),
			JSON.stringify({ timestamp: "2026-10-02", status: "error", user: "bob" }),
			JSON.stringify({ timestamp: "2026-10-03", status: "ok", user: "charlie" }),
		];

		await fs.writeFile(jsonFile, JSON.stringify(testData, null, 2), "utf-8");
		await fs.writeFile(jsonlFile, testLines.join("\n") + "\n", "utf-8");
		// Literals JS numbers cannot hold; jaq prints them verbatim.
		await fs.writeFile(numbersFile, '{"ids":[12345678901234567890,1.0,3]}', "utf-8");
		// `.name` fails on the third element.
		await fs.writeFile(mixedFile, '[{"name":"a"},{"name":"b"},3]', "utf-8");
		// `.n + 1` fails on the second line only.
		await fs.writeFile(failingLineFile, '{"n":1}\n{"n":"x"}\n{"n":3}\n', "utf-8");

		session = createSession(tempDir);
		readTool = new ReadTool(session);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("queries a simple property from a JSON file", async () => {
		const result = await readTool.execute("call_1", { path: `${jsonFile}?q=.name` });
		const text = getText(result);
		expect(text).toContain('"my-project"');
	});

	it("queries with pipes in jq filter expression", async () => {
		const result = await readTool.execute("call_2", { path: `${jsonFile}?q=.items[] | select(.active) | .name` });
		const text = getText(result);
		expect(text).toContain('"item-one"');
		expect(text).toContain('"item-three"');
		expect(text).not.toContain('"item-two"');
	});

	it("supports raw unquoted output and preserves trailing whitespace", async () => {
		const result = await readTool.execute("call_3", { path: `${jsonFile}?q="foo  "&raw=true` });
		const text = getText(result);
		expect(text).toBe("foo  ");
	});

	it("supports compact output via compact=true parameter", async () => {
		const result = await readTool.execute("call_4", { path: `${jsonFile}?q=.metadata.tags&compact=true` });
		const text = getText(result);
		expect(text.trim()).toBe('["alpha","beta","gamma"]');
	});

	it("queries JSONL stream lines with filtering", async () => {
		const result = await readTool.execute("call_5", {
			path: `${jsonlFile}?q=select(.status == "ok") | .user&raw=true`,
		});
		const text = getText(result);
		const lines = text.trim().split("\n");
		expect(lines).toEqual(["alice", "charlie"]);
	});

	it("fails cleanly with descriptive error on invalid jq syntax", async () => {
		await expect(readTool.execute("call_6", { path: `${jsonFile}?q=invalid [[[` })).rejects.toThrow(
			/Failed to execute JSON query/i,
		);
	});

	it("reads the file normally without jq query when ?q= is omitted", async () => {
		const result = await readTool.execute("call_7", { path: jsonFile });
		const text = getText(result);
		expect(text).toContain('"my-project"');
		expect(text).toContain('"secret-value"');
	});

	it("supports offset and limit pagination on JSON arrays with repeatable continuation hint", async () => {
		const result = await readTool.execute("call_p1", { path: `${jsonFile}?q=.items&offset=1&limit=1` });
		const text = getText(result);
		expect(text).toContain('"item-two"');
		expect(text).not.toContain('"item-one"');
		expect(text).not.toContain('"item-three"');
		expect(text).toContain("[1 more items; append ?q=.items&limit=1&offset=2 to continue]");

		// Follow the continuation hint
		const nextResult = await readTool.execute("call_p1_cont", { path: `${jsonFile}?q=.items&limit=1&offset=2` });
		const nextText = getText(nextResult);
		expect(nextText).toContain('"item-three"');
		expect(nextText).not.toContain('"item-two"');
	});

	it("preserves compact format when paging an array with compact=true", async () => {
		const result = await readTool.execute("call_compact_page", {
			path: `${jsonFile}?q=.items&compact=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain('[{"id":2,"name":"item-two","active":false}]');
	});

	it("does not slice a single JSON object mid-syntax when limit is supplied", async () => {
		const result = await readTool.execute("call_obj_limit", {
			path: `${jsonFile}?q=.metadata&limit=2`,
		});
		const text = getText(result);
		expect(text).toContain('"tags"');
		expect(text).toContain('"nested"');
		expect(text).toContain('"secret-value"');
		expect(() => JSON.parse(text)).not.toThrow();
	});

	it("preserves arithmetic + operator in jq filters without URL corruption", async () => {
		const result = await readTool.execute("call_plus", {
			path: `${jsonFile}?q=.items | length + 1`,
		});
		const text = getText(result);
		expect(text.trim()).toBe("4");
	});

	it("supports offset and limit pagination on JSONL streams with continuation hint", async () => {
		const result = await readTool.execute("call_p2", {
			path: `${jsonlFile}?q=.user&raw=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain("bob");
		expect(text).not.toContain("alice");
		expect(text).not.toContain("charlie");
		expect(text).toContain("[more results; append ?q=.user&raw=true&limit=1&offset=2 to continue]");
	});

	it("keeps number literals verbatim when paging an array", async () => {
		const result = await readTool.execute("call_big", { path: `${numbersFile}?q=.ids&limit=2` });
		expect(getText(result)).toBe(
			"[\n  12345678901234567890,\n  1.0\n]\n[1 more items; append ?q=.ids&limit=2&offset=2 to continue]",
		);
	});

	it("pages pretty streams by whole value and the hint round-trips the filter", async () => {
		const first = getText(
			await readTool.execute("call_mixed", { path: `${jsonFile}?q=.items[] | .id, {name}&limit=3` }),
		);
		expect(first).toBe(
			'1\n{\n  "name": "item-one"\n}\n2\n[more results; append ?q=.items[] | .id, {name}&limit=3&offset=3 to continue]',
		);

		const suffix = /append (\?.*) to continue\]$/.exec(first)?.[1];
		const next = getText(await readTool.execute("call_mixed_next", { path: `${jsonFile}${suffix}` }));
		expect(next).toBe('{\n  "name": "item-two"\n}\n3\n{\n  "name": "item-three"\n}');
	});

	it("pages raw streams of objects by whole value", async () => {
		const result = await readTool.execute("call_raw_objects", { path: `${jsonFile}?q=.items[]&raw=true&limit=1` });
		expect(getText(result)).toBe(
			'{\n  "id": 1,\n  "name": "item-one",\n  "active": true\n}\n[more results; append ?q=.items[]&raw=true&limit=1&offset=1 to continue]',
		);
	});

	it("stops jq once the page is full, before later results fail", async () => {
		const result = await readTool.execute("call_early_stop", { path: `${mixedFile}?q=.[] | .name&raw=true&limit=1` });
		// jaq may report the later failure before it is stopped; the page still stands
		expect(getText(result).split("\n").slice(-2)).toEqual([
			"a",
			"[more results; append ?q=.[] | .name&raw=true&limit=1&offset=1 to continue]",
		]);
	});

	// Holds for the bundled jq and, with PI_DISABLE_UUTILS_BUILTINS set, for a system jq.
	it("reports a line that fails mid-file alongside the other lines' results", async () => {
		const text = getText(await readTool.execute("call_mid_error", { path: `${failingLineFile}?q=.n + 1` }));
		expect(text).toStartWith("[jq stderr: ");
		expect(text.split("\n").slice(1)).toEqual(["2", "4"]);

		const paged = getText(
			await readTool.execute("call_mid_error_page", { path: `${failingLineFile}?q=.n + 1&limit=1` }),
		);
		expect(paged).toStartWith("[jq stderr: ");
		expect(paged).toEndWith("\n2\n[more results; append ?q=.n + 1&limit=1&offset=1 to continue]");
	});

	it("strips terminal controls from jq's stderr", async () => {
		const query = String.raw`.name as $name | "\u001b[31mred\u0000" | stderr | $name`;
		const text = getText(await readTool.execute("call_stderr_controls", { path: `${jsonFile}?q=${query}` }));
		expect(text).toBe('[jq stderr: red]\n"my-project"');
	});

	it("treats a filter starting with - as a filter, not jq flags", async () => {
		const result = await readTool.execute("call_negate", { path: `${jsonFile}?q=-.items[0].id` });
		expect(getText(result)).toBe("-1");
	});

	it("applies trailing line range selectors over query output", async () => {
		const result = await readTool.execute("call_sel", {
			path: `${jsonFile}?q=.items[] | .name&raw=true:raw:1-2`,
		});
		const text = getText(result);
		expect(text).toContain("item-one");
		expect(text).toContain("item-two");
		expect(text).not.toContain("item-three");
	});
});
