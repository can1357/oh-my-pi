import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A call whose arguments span several lines, so a structural read elides the
// inner rows (3-4) and displays the rest.
const SOURCE = [
	"def draw(sheet, anchor, alpha, beta):",
	"    add_native_hole_callout(sheet=sheet,",
	"        nested=nested(alpha,",
	"            beta),",
	"        point=model_point_in_view(",
	"            anchor),",
	"        callout_xy=(0.230, 0.258))",
	"",
].join("\n");

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

// Regression: the hashline prompt promises that hunks anchored on lines a read
// never displayed are rejected, but the seen-line guard shipped opt-in. With
// the guard off, a hunk whose range fell inside an elided region was instead
// "auto-repaired" — the syntax probe kept the row the range had selected and
// spliced the body into the neighbouring call, silently and with valid syntax.
describe("read → edit seen-line guard under default settings", () => {
	let cwd: string;
	let file: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seen-lines-"));
		file = path.join(cwd, "draw.py");
		await Bun.write(file, SOURCE);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects a hunk anchored on a line the read elided", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read.split("\n")[0]).toMatch(/^\[draw\.py#[0-9A-F]{4}\]$/);
		expect(read).toContain("…");
		expect(read).not.toContain("beta),");

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 4.=4:\n+            beta, gamma),\n`,
		});

		expect(textOutput(result)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	it("applies a hunk anchored on a line the read displayed", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read).toContain("callout_xy=(0.230, 0.258))");

		await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 7.=7:\n+        callout_xy=(0.240, 0.258))\n`,
		});

		expect(await Bun.file(file).text()).toBe(SOURCE.replace("0.230", "0.240"));
	});
});

// Regression: grep printed a cross-line match as one row numbered only by its
// first line, so the continuation line carried no `N:` prefix, the seen-line
// guard rejected edits anchored on it, and a `...` gap marker separated the
// match from the context line directly below it.
describe("grep → edit seen-line guard under default settings", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seen-lines-grep-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("numbers every line of a cross-line match so an edit can anchor on it", async () => {
		const session = createSession(cwd);
		const file = path.join(cwd, "conf.py");
		await Bun.write(file, "import os\n\ndef connect(host,\n            port):\n    return (host, port)\n");

		const grep = textOutput(
			await new GrepTool(session).execute("grep", { pattern: "def connect\\(host,\\n\\s+port\\)", path: "conf.py" }),
		);
		expect(grep).toContain("*3:def connect(host,\n 4:            port):\n 5:    return (host, port)");

		await new EditTool(session, "hashline").execute("edit", {
			input: `${grep.split("\n")[0]}\nPUT 4.=4:\n+            port=5432):\n`,
		});

		expect(await Bun.file(file).text()).toBe(
			"import os\n\ndef connect(host,\n            port=5432):\n    return (host, port)\n",
		);
	});

	it("keeps the cut last row of a cross-line match wider than the column cap unseen", async () => {
		const session = createSession(cwd);
		const file = path.join(cwd, "block.txt");
		// About 850 bytes across 14 lines: past the 512-byte column cap, so grep shows a window ending mid-line.
		const lines = ["head", ...Array.from({ length: 12 }, (_, i) => `    x${i} = ${"y".repeat(60)}`), "end"];
		const source = `${lines.join("\n")}\n`;
		await Bun.write(file, source);

		const grep = textOutput(
			await new GrepTool(session).execute("grep", { pattern: "head\\n(.*\\n)*end", path: "block.txt" }),
		);
		const rows = grep.split("\n").filter(row => /^[ *]\d+:/.test(row));
		expect(rows[0]).toBe("*1:head [col 1]");
		const lastRow = rows.at(-1) ?? "";
		expect(lastRow).toEndWith("...");
		const cutLine = Number(/\d+/.exec(lastRow)?.[0]);
		expect(cutLine).toBeGreaterThan(5);
		expect(cutLine).toBeLessThan(lines.length);
		const header = grep.split("\n")[0];

		const rejected = await new EditTool(session, "hashline").execute("edit", {
			input: `${header}\nPUT ${cutLine}.=${cutLine}:\n+    cut = 0\n`,
		});
		expect(textOutput(rejected)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);

		await new EditTool(session, "hashline").execute("edit", { input: `${header}\nPUT 5.=5:\n+    x3 = 0\n` });
		lines[4] = "    x3 = 0";
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});

	it("keeps continuation rows outside the selected line range hidden and unseen", async () => {
		const session = createSession(cwd);
		const file = path.join(cwd, "conf.py");
		const source = "import os\n\ndef connect(host,\n            port):\n    return (host, port)\n";
		await Bun.write(file, source);

		// The match starts on line 3 but continues onto line 4, which the selector excludes.
		const grep = textOutput(
			await new GrepTool(session).execute("grep", {
				pattern: "def connect\\(host,\\n\\s+port\\)",
				path: "conf.py:3-3",
			}),
		);
		expect(grep).toContain("*3:def connect(host,");
		expect(grep).not.toContain("port):");

		const rejected = await new EditTool(session, "hashline").execute("edit", {
			input: `${grep.split("\n")[0]}\nPUT 4.=4:\n+            port=5432):\n`,
		});
		expect(textOutput(rejected)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);
	});

	it("keeps rows the output byte cap drops unseen", async () => {
		const session = createSession(cwd);
		const file = path.join(cwd, "pairs.txt");
		// 200 two-line matches of about 380 bytes each, kept apart by a `--` line so native grep reports
		// them separately: past the 50 KiB output cap, so grep drops the tail.
		const lines = Array.from({ length: 200 }, (_, i) => [
			`a${i} = ${"x".repeat(180)}`,
			`  b${i} = ${"y".repeat(180)}`,
			"--",
		]).flat();
		const source = `${lines.join("\n")}\n`;
		await Bun.write(file, source);

		const grep = textOutput(
			await new GrepTool(session).execute("grep", { pattern: "a\\d+ = x+\\n  b\\d+", path: "pairs.txt" }),
		);
		const rows = grep.split("\n").filter(row => /^[ *]\d+:/.test(row));
		const lastShown = Number(/\d+/.exec(rows.at(-1) ?? "")?.[0]);
		expect(lastShown).toBeGreaterThan(2);
		expect(lastShown).toBeLessThanOrEqual(lines.length - 3);
		const header = grep.split("\n")[0];

		// Each match is a first row, a continuation row and a `--` context row, so the three lines
		// after the last shown row cover every kind of row the cap drops.
		for (const line of [lastShown + 1, lastShown + 2, lastShown + 3]) {
			const rejected = await new EditTool(session, "hashline").execute("edit", {
				input: `${header}\nPUT ${line}.=${line}:\n+cut\n`,
			});
			expect(textOutput(rejected)).toContain("never displayed");
		}
		expect(await Bun.file(file).text()).toBe(source);

		await new EditTool(session, "hashline").execute("edit", { input: `${header}\nPUT 2.=2:\n+  b0 = 0\n` });
		lines[1] = "  b0 = 0";
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});
});

// Regression: an edit under a stale tag went through snapshot recovery without
// the seen-line check, so after one edit changed the file, a header copied
// from the earlier read anchored lines that read never displayed.
describe("read → edit seen-line guard under a stale tag", () => {
	let cwd: string;
	let file: string;
	const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stale-seen-"));
		file = path.join(cwd, "list.txt");
		await Bun.write(file, `${LINES.join("\n")}\n`);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("reveals a line the earlier read never displayed, then applies the retry", async () => {
		const session = createSession(cwd);
		const header = textOutput(await new ReadTool(session).execute("read", { path: "list.txt:18-22" })).split("\n")[0];
		expect(header).toMatch(/^\[list\.txt#[0-9A-F]{4}\]$/);
		const edit = new EditTool(session, "hashline");
		await edit.execute("edit-1", { input: `${header}\nPUT 20.=20:\n+LINE TWENTY\n` });
		const afterFirst = await Bun.file(file).text();
		expect(afterFirst).toContain("LINE TWENTY");

		// The header now names a stale version, whose read showed lines 18-22.
		const stale = `${header}\nPUT 3.=3:\n+LINE THREE\n`;
		const refused = await edit.execute("edit-2", { input: stale });
		expect(textOutput(refused)).toContain("never displayed");
		expect(textOutput(refused)).toContain("3:line 3");
		expect(await Bun.file(file).text()).toBe(afterFirst);

		await edit.execute("edit-3", { input: stale });
		expect(await Bun.file(file).text()).toBe(afterFirst.replace("line 3\n", "LINE THREE\n"));
	});
});
