import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import { generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@oh-my-pi/pi-tui/tools/streaming-output";
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

// Regression (#19092): a change made outside the edit tool (formatter, build
// step, another writer) dropped every line an earlier read had displayed, so an
// unchanged line at its old number was rejected as never displayed.
describe("read → outside change → partial read → edit", () => {
	let cwd: string;
	let file: string;
	const LINES = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-outside-seen-"));
		file = path.join(cwd, "f.txt");
		await Bun.write(file, `${LINES.join("\n")}\n`);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("keeps lines that kept their number and content seen", async () => {
		const session = createSession(cwd);
		const read = new ReadTool(session);
		expect(textOutput(await read.execute("read-1", { path: "f.txt" }))).toContain("5:line 5");
		const changed = `${LINES.join("\n")}\n`.replace("line 50\n", "line FIFTY\n");
		await Bun.write(file, changed);
		const header = textOutput(await read.execute("read-2", { path: "f.txt:48-52" })).split("\n")[0];

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${header}\nPUT 5.=5:\n+line FIVE\n`,
		});

		expect(textOutput(result)).not.toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(changed.replace("line 5\n", "line FIVE\n"));
	});
});

// Regression: an `@file` mention recorded its snapshot with no seen-line set,
// so the guard accepted anchors on rows the truncated mention never showed,
// and a line-1 byte prefix was numbered `1:` under a tag; replacing that row
// from the prefix dropped the line's unseen tail.
describe("@file mention → edit seen-line guard", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mention-seen-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	async function mention(session: ToolSession, name: string): Promise<string> {
		const [message] = await generateFileMentionMessages([name], cwd, {
			useHashLines: true,
			snapshotStore: getEditStore(session),
		});
		if (message?.role !== "fileMention") throw new Error("expected file mention message");
		return message.files[0]?.content ?? "";
	}

	it("rejects a hunk anchored past the rows a head-truncated mention showed", async () => {
		const file = path.join(cwd, "long.txt");
		const source = `${Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		await Bun.write(file, source);
		const session = createSession(cwd);
		const content = await mention(session, "long.txt");
		const header = content.split("\n")[0];
		expect(header).toMatch(/^\[long\.txt#[0-9A-F]{4}\]$/);
		// The truncation notice is not a numbered source row.
		expect(content.split("\n").at(-1)).toMatch(/^\[Showing lines 1-\d+ of \d+/);

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${header}\nPUT ${DEFAULT_MAX_LINES + 5}.=${DEFAULT_MAX_LINES + 5}:\n+changed\n`,
		});

		expect(textOutput(result)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);
	});

	it("emits no tag or numbered row for a line 1 cut at the byte cap", async () => {
		await Bun.write(path.join(cwd, "wide.json"), `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\nlast\n`);
		const content = await mention(createSession(cwd), "wide.json");

		expect(content).toContain("exceeds");
		expect(content).not.toMatch(/^\[wide\.json#/);
		expect(content).not.toMatch(/^1:/m);
	});
});
