/**
 * Regression: column truncation in `read` is display-only. The snapshot
 * recorded for the hashline TAG returned to the model MUST contain the
 * on-disk content, not the ellipsis-truncated display content.
 *
 * Before the fix, `collectedLines` was mutated in place with `…`-terminated
 * lines and that mutated array was passed straight to the snapshot store.
 * Every subsequent edit on a file with any line wider than
 * `tools.outputMaxColumns` failed with a permanent hash-mismatch loop
 * (`Section is bound to #XYZ, but the current file hashes to #ABC`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgReadSummarizeEnabled, cfgToolsOutputMaxColumns } from "@oh-my-pi/pi-coding-agent/tools/settings";

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;
const COLUMN_CAP = 64;
const LONG_LINE_LEN = COLUMN_CAP * 3;

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	cfgToolsOutputMaxColumns.set(settings, COLUMN_CAP);
	cfgReadSummarizeEnabled.set(settings, false);
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

function extractHeader(text: string): { header: string; tag: string; relPath: string } {
	const match = HASHLINE_HEADER_LINE.exec(text);
	if (!match) throw new Error(`no hashline header in:\n${text}`);
	const [header, relPath, tag] = match;
	return { header: header!, tag: tag!, relPath: relPath! };
}

async function applyEditWithTag(args: { session: ToolSession; header: string; patchBody: string }): Promise<void> {
	const patchInput = `${args.header}\n${args.patchBody}`;
	await new EditTool(args.session, "hashline").execute("call-edit", { input: patchInput });
}

describe("read tool column truncation vs hashline snapshot", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-column-trunc-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("snapshot keeps untruncated content for a full-file read with long lines", async () => {
		const filePath = path.join(tmpDir, "wide.txt");
		const longLine = "x".repeat(LONG_LINE_LEN);
		const fullText = `first short line\n${longLine}\nthird short line\n`;
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-1", { path: filePath });
		const text = textOutput(result);

		// Sanity: display IS column-truncated.
		expect(text).toContain("…");
		expect(text).not.toContain(longLine);

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot).not.toBeNull();

		// The snapshot MUST hold the on-disk text, not the display-truncated version.
		expect(snapshot).toBe(fullText);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
	});

	it("range read snapshot keeps untruncated content for long lines", async () => {
		const filePath = path.join(tmpDir, "wide-range.txt");
		const longLine = "y".repeat(LONG_LINE_LEN);
		const fullText = `head\n${longLine}\ntail\n`;
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-range", { path: `${filePath}:1-3` });
		const text = textOutput(result);
		expect(text).toContain("…");

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
	});

	it("multi-range read snapshot keeps untruncated content for long lines", async () => {
		const filePath = path.join(tmpDir, "wide-multi.txt");
		const longLine = "z".repeat(LONG_LINE_LEN);
		const fullText = ["a", longLine, "c", "d", "e", longLine, "g"].join("\n");
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-multi", { path: `${filePath}:1-2,6-7` });
		const text = textOutput(result);
		expect(text).toContain("…");

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
		expect(snapshot?.split("\n")[5]).toBe(longLine);
	});

	it("edit can apply against a file with long lines without re-reading", async () => {
		// The bug: after reading a file with column-truncated lines, ANY follow-up
		// hashline edit failed with "current file hashes to #XYZ" because the
		// recorded snapshot held `…`-suffixed lines instead of the on-disk content.
		const filePath = path.join(tmpDir, "editable-wide.txt");
		const longLine = "w".repeat(LONG_LINE_LEN);
		const original = `intro\n${longLine}\noutro\n`;
		await fs.writeFile(filePath, original);

		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const readResult = await readTool.execute("call-read", { path: filePath });
		const readText = textOutput(readResult);
		const { header } = extractHeader(readText);

		// Replace line 3 ("outro") using the TAG returned by the truncating read.
		await applyEditWithTag({
			session,
			header,
			patchBody: "PUT 3-3:\n+epilogue\n",
		});

		const after = await fs.readFile(filePath, "utf8");
		expect(after).toBe(`intro\n${longLine}\nepilogue\n`);
	});

	it("rejects a PUT or CUT of a column-cut line until a raw read shows its tail", async () => {
		const filePath = path.join(tmpDir, "tail.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `first\n${longLine}\nlast\n`;
		await fs.writeFile(filePath, original);

		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readTool = new ReadTool(session);
		const readText = textOutput(await readTool.execute("read-cut", { path: filePath }));
		const { header } = extractHeader(readText);
		const shownLine = readText
			.split("\n")
			.find(line => line.startsWith("2:"))!
			.slice(2);
		expect(shownLine.endsWith("…")).toBe(true);

		const editTool = new EditTool(session, "hashline");
		for (const body of [
			`PUT 2.=2:\n+${shownLine.slice(0, -1).replace("note:", "NOTE:")}\n`,
			`PUT 2.=2:\n+${shownLine.replace("note:", "NOTE:")}\n`,
			"CUT 2.=2\n",
		]) {
			const result = await editTool.execute("edit-cut", { input: `${header}\n${body}` });
			expect(textOutput(result)).toContain("tail.txt:2:raw");
			expect(await fs.readFile(filePath, "utf8")).toBe(original);
		}

		const raw = textOutput(await readTool.execute("read-raw", { path: `${filePath}:2-2:raw` }));
		expect(raw).toContain(longLine);
		await editTool.execute("edit-full", {
			input: `${header}\nPUT 2.=2:\n+${longLine.replace("note:", "NOTE:")}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(original.replace("note:", "NOTE:"));
	});

	it("rejects a cut line in a multi-range read but allows edits to the other displayed range", async () => {
		const filePath = path.join(tmpDir, "multi-cut.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `first\n${longLine}\nthird\nfourth\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readText = textOutput(
			await new ReadTool(session).execute("read-multi-cut", { path: `${filePath}:2-2,4-4` }),
		);
		const { header } = extractHeader(readText);
		const editTool = new EditTool(session, "hashline");
		const cut = await editTool.execute("edit-multi-cut", {
			input: `${header}\nCUT 2.=2\n`,
		});
		expect(textOutput(cut)).toContain("multi-cut.txt:2:raw");
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
		await editTool.execute("edit-multi-full", {
			input: `${header}\nPUT 4.=4:\n+FOURTH\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(original.replace("fourth", "FOURTH"));
	});

	it("rejects a block PUT or CUT whose interior holds a column-cut line", async () => {
		const filePath = path.join(tmpDir, "block.ts");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `function f() {\n\tconst x = "${longLine}";\n\treturn x;\n}\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readText = textOutput(await new ReadTool(session).execute("read-block", { path: filePath }));
		const { header } = extractHeader(readText);
		const shownLine = readText
			.split("\n")
			.find(line => line.startsWith("2:"))!
			.slice(2, -1);
		const editTool = new EditTool(session, "hashline");
		for (const body of [`PUT 1*:\n+function f() {\n+${shownLine}\n+\treturn x.trim();\n+}\n`, "CUT 1*\n"]) {
			const result = await editTool.execute("edit-block", { input: `${header}\n${body}` });
			expect(textOutput(result)).toContain("block.ts:2:raw");
			expect(await fs.readFile(filePath, "utf8")).toBe(original);
		}
	});

	it("marks a line seen when column capping is disabled", async () => {
		const filePath = path.join(tmpDir, "uncapped.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		await fs.writeFile(filePath, `${longLine}\n`);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 0);
		const readText = textOutput(await new ReadTool(session).execute("read-full", { path: filePath }));
		const { header } = extractHeader(readText);
		await new EditTool(session, "hashline").execute("edit-full", {
			input: `${header}\nPUT 1.=1:\n+${longLine.replace("note:", "NOTE:")}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(`${longLine.replace("note:", "NOTE:")}\n`);
	});

	it("does not treat a clipped grep match as an editable full line", async () => {
		const filePath = path.join(tmpDir, "grep-wide.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `${longLine}\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		const grepText = textOutput(
			await new GrepTool(session).execute("grep-cut", {
				pattern: "note:",
				path: filePath,
			}),
		);
		expect(grepText).not.toContain("END-OF-LINE-TAIL");
		const tag = getEditStore(session).headHash(filePath);
		expect(tag).not.toBeNull();
		const result = await new EditTool(session, "hashline").execute("edit-grep-cut", {
			input: `[${filePath}#${tag}]\nPUT 1.=1:\n+NOTE: cut\n`,
		});
		expect(textOutput(result)).toContain("grep-wide.txt:1:raw");
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
	});

	it("keeps a genuine blank line editable without exposing the EOF sentinel", async () => {
		const filePath = path.join(tmpDir, "eof-blank.txt");
		await fs.writeFile(filePath, "first\n\nlast\n");

		const session = createSession(tmpDir);
		const readText = textOutput(await new ReadTool(session).execute("call-eof-blank", { path: filePath }));
		expect(readText).toContain("1:first\n2:\n3:last");
		expect(readText).not.toContain("\n4:");

		const { header } = extractHeader(readText);
		await applyEditWithTag({
			session,
			header,
			patchBody: "CUT 2\n",
		});

		expect(await fs.readFile(filePath, "utf8")).toBe("first\nlast\n");
	});
});
