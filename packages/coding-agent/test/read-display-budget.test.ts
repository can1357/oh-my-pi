import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, SNAPSHOT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/tools/read";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { cfgToolsOutputMaxColumns } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const WIDE_LINE = "H".repeat(80_000);
const SMALL_LINES = Array.from({ length: 300 }, (_, i) => (i === 150 ? WIDE_LINE : `r${i + 1}`));
const SMALL_SOURCE = `${SMALL_LINES.join("\n")}\n`;
// Past the snapshot cap the file is streamed: the last line alone carries it over. There the
// wide lines are kept only as heads, which must cut like the whole line, multi-byte text included.
const HUGE_LAST_LINE = "T".repeat(SNAPSHOT_MAX_BYTES + 200_000);
const STREAMED_WIDE_LINES = new Map([
	[199, "語".repeat(30_000)],
	[200, "😀".repeat(20_000)],
	[299, HUGE_LAST_LINE],
]);
const BIG_LINES = SMALL_LINES.map((line, i) => STREAMED_WIDE_LINES.get(i) ?? line);

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string, maxColumns = 768): ToolSession {
	const settings = Settings.isolated({ "edit.mode": "hashline", "read.summarize.enabled": false });
	cfgToolsOutputMaxColumns.set(settings, maxColumns);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		enableLsp: false,
	};
}

async function read(session: ToolSession, target: string): Promise<string> {
	return textOutput(await wrapToolWithMetaNotice(new ReadTool(session)).execute("read", { path: target }));
}

function rows(text: string): Map<number, string> {
	const shown = new Map<number, string>();
	for (const line of text.split("\n")) {
		const match = /^(\d+):(.*)$/.exec(line);
		if (match) shown.set(Number(match[1]), match[2]!);
	}
	return shown;
}

// Numbered reads display a line wider than `tools.outputMaxColumns` cut to the
// cap, so the page budget charges that cut width, not the line's source size.
describe("read charges column-cut lines their displayed width", () => {
	let dir: string;
	let small: string;
	let big: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-display-budget-"));
		small = path.join(dir, "small.txt");
		big = path.join(dir, "big.txt");
		await fs.writeFile(small, SMALL_SOURCE);
		await fs.writeFile(big, `${BIG_LINES.join("\n")}\n`);
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	for (const [label, file, cutLines] of [
		["a buffered file", () => small, [151]],
		["a file past the snapshot cap", () => big, [151, 200, 201, 300]],
	] as const) {
		it(`shows every line of ${label} with the wide lines cut`, async () => {
			const text = await read(createSession(dir), file());
			const shown = rows(text);
			expect(shown.size).toBe(300);
			for (const line of cutLines) expect(shown.get(line)).toBe(`${BIG_LINES[line - 1]!.slice(0, 768)}…`);
			expect(shown.get(299)).toBe("r299");
			expect(text).toContain("truncated to 768");
			expect(text).not.toContain("to continue");
		});

		it(`pages through the wide line of ${label}`, async () => {
			const shown = rows(await read(createSession(dir), `${file()}:151`));
			expect(shown.get(150)).toBe("r150");
			expect(shown.get(151)).toBe(`${WIDE_LINE.slice(0, 768)}…`);
			expect(shown.get(152)).toBe("r152");
			expect(shown.has(300)).toBe(true);
		});
	}

	it("shows a wide line in each range of a multi-range read past the snapshot cap", async () => {
		const shown = rows(await read(createSession(dir), `${big}:150-152,299-300`));
		expect([...shown.keys()]).toEqual([150, 151, 152, 299, 300]);
		expect(shown.get(151)).toBe(`${WIDE_LINE.slice(0, 768)}…`);
		expect(shown.get(300)).toBe(`${HUGE_LAST_LINE.slice(0, 768)}…`);
	});

	it("returns a whole JSONL page of 5 KB records in one read", async () => {
		const file = path.join(dir, "records.jsonl");
		const records = Array.from({ length: 35 }, (_, i) => JSON.stringify({ id: i + 1, body: "x".repeat(5_000) }));
		await fs.writeFile(file, `${records.join("\n")}\n`);
		const shown = rows(await read(createSession(dir), file));
		expect(shown.size).toBe(35);
		expect(shown.get(35)).toBe(`${records[34]!.slice(0, 768)}…`);
	});

	it("emits no hashline tag for a streamed whole-file read built from cut-line heads", async () => {
		// Past the snapshot cap a whole-file window would be hashed from its collected lines,
		// which here hold only the heads of the cut lines: no tag beats a tag of the wrong text.
		const text = await read(createSession(dir), big);
		expect(rows(text).size).toBe(300);
		expect(text.split("\n")[0]).not.toMatch(/^\[[^\]]*#[0-9A-F]{4}\]$/);
	});

	it("still refuses an edit anchored on the cut line", async () => {
		const session = createSession(dir);
		const header = (await read(session, small)).split("\n")[0]!;
		const result = await new EditTool(session, "hashline").execute("edit", { input: `${header}\nCUT 151.=151\n` });
		expect(textOutput(result)).toContain("small.txt:151:raw");
		expect(await fs.readFile(small, "utf8")).toBe(SMALL_SOURCE);
	});

	it("keeps a raw read of the wide line byte-capped and uncut", async () => {
		const text = await read(createSession(dir), `${small}:raw:151-151`);
		expect(text).toStartWith("H".repeat(40_000));
		expect(text).not.toContain("…");
		expect(text).toContain("partial");
	});

	it("stops before the wide line when the column cap is off", async () => {
		const text = await read(createSession(dir, 0), small);
		const shown = rows(text);
		expect(shown.has(150)).toBe(true);
		expect(shown.has(151)).toBe(false);
		expect(text).toContain("Use");
		expect(text).toContain(":151 to continue");
	});
});
