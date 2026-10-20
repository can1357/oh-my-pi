import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { WRITE_MAP_MAX_CHARS, WRITE_MAP_MAX_LINES } from "@oh-my-pi/pi-coding-agent/tools/write-content";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

describe("write tool hashline header", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-hashline-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("inserts a fresh [path#TAG] header that maps to the written content", async () => {
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const value = 42;\nexport const flag = true;\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const lines = resultText(result).split("\n");

		// First line is the hashline header; subsequent text is the byte count.
		const match = HASHLINE_HEADER_LINE.exec(lines[0] ?? "");
		expect(match).not.toBeNull();
		const [, headerPath, tag] = match!;
		expect(headerPath).toBe(path.relative(tmpDir, filePath));
		expect(lines[1]).toBe(`Successfully wrote ${content.length} bytes to ${headerPath}`);

		// The tag must address a snapshot whose content matches what we wrote so a
		// follow-up edit can land without an extra `read` round-trip.
		const snapshot = getEditStore(session).byHashText(filePath, tag!);
		expect(snapshot).toBe(content);
	});

	it("makes the post-write tag usable by the hashline patcher", async () => {
		const filePath = path.join(tmpDir, "config.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const enabled = false;\n";

		const writeResult = await tool.execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		// Apply a hashline patch immediately, using only the tag the write tool
		// returned — no intervening `read`.
		const patchInput = `${headerLine}\nPUT 1-1:\n+export const enabled = true;\n`;
		await new EditTool(session, "hashline").execute("call-2", { input: patchInput });

		const final = await fs.readFile(filePath, "utf8");
		expect(final).toBe("export const enabled = true;\n");
	});

	it("numbers the written lines so the model knows the line numbers it anchors on", async () => {
		const filePath = path.join(tmpDir, "numbered.ts");
		const session = createSession(tmpDir);
		const content = "export const enabled = false;\nexport const flag = true;\n";

		const result = await new WriteTool(session).execute("call-1", { path: filePath, content });
		const lines = resultText(result).split("\n");
		const match = HASHLINE_HEADER_LINE.exec(lines[0] ?? "");
		expect(match).not.toBeNull();
		const tag = match![2];

		// The write displays the lines it wrote, numbered like a read, so the
		// model anchors on the line numbers it just saw instead of guessing.
		expect(lines).toContain("1:export const enabled = false;");
		expect(lines).toContain("2:export const flag = true;");
		expect(getEditStore(session).seenLines(filePath, tag)).toEqual([1, 2]);
	});

	it("rejects an anchor on a line the write did not display", async () => {
		const filePath = path.join(tmpDir, "long.ts");
		const session = createSession(tmpDir);
		const content = `${Array.from({ length: WRITE_MAP_MAX_LINES + 1 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";

		// Only the first WRITE_MAP_MAX_LINES lines are numbered, so the last
		// line is an anchor the write never displayed: the seen-line guard
		// rejects it instead of applying the edit at a guessed line number.
		const editResult = await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT ${WRITE_MAP_MAX_LINES + 1}.=${WRITE_MAP_MAX_LINES + 1}:\n+changed\n`,
		});

		expect(resultText(editResult)).toContain("never displayed");
		expect(await fs.readFile(filePath, "utf8")).toBe(content);
	});

	it("records no seen line when it numbered none, so every anchor is unseen", async () => {
		const filePath = path.join(tmpDir, "unnumbered.ts");
		const session = createSession(tmpDir);
		// A first line past the map's character cap leaves the write with no
		// numbered row at all. The tag then records the empty seen set — "no
		// line was displayed" — instead of a missing record, so the guard runs
		// and reads every anchor on it as unseen.
		const content = `${"x".repeat(WRITE_MAP_MAX_CHARS + 1)}\n`;

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content });
		const text = resultText(writeResult);
		const headerLine = text.split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);
		const tag = HASHLINE_HEADER_LINE.exec(headerLine)![2];

		// No row is numbered, and the note says so instead of claiming a
		// numbered range that does not exist.
		expect(text).not.toContain(`1:${"x".repeat(8)}`);
		expect(text).toContain("(1 line; none were numbered — read the file before anchoring an edit)");
		// The empty set, not a missing one: the guard rejects every anchor.
		expect(getEditStore(session).seenLines(filePath, tag)).toEqual([]);
	});

	it("says the file is empty when the write numbered nothing", async () => {
		const filePath = path.join(tmpDir, "empty.ts");
		const session = createSession(tmpDir);

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content: "" });
		const text = resultText(writeResult);
		const headerLine = text.split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);
		const tag = HASHLINE_HEADER_LINE.exec(headerLine)![2];

		expect(text).toContain("(the file is empty; there is nothing to anchor)");
		expect(getEditStore(session).seenLines(filePath, tag)).toEqual([]);
	});

	it("names a local:// write by its URL, and the header round-trips through edit and write", async () => {
		const session = createSession(tmpDir);
		const backingPath = path.join(tmpDir, "artifacts", "local", "notes.ts");
		const content = "export const enabled = false;\n";

		const writeResult = await new WriteTool(session).execute("call-1", { path: "local://notes.ts", content });
		const [headerLine = "", writeLine] = resultText(writeResult).split("\n");
		expect(HASHLINE_HEADER_LINE.exec(headerLine)?.[1]).toBe("local://notes.ts");
		expect(writeLine).toBe(`Successfully wrote ${content.length} bytes to local://notes.ts`);

		await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT 1-1:\n+export const enabled = true;\n`,
		});
		expect(await fs.readFile(backingPath, "utf8")).toBe("export const enabled = true;\n");

		// The URL-form header also addresses the same file as a `write` path.
		await new WriteTool(session).execute("call-3", { path: headerLine, content: "export const v = 2;\n" });
		expect(await fs.readFile(backingPath, "utf8")).toBe("export const v = 2;\n");
	});

	it("omits the hashline header when the edit mode is not hashline", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const session = createSession(tmpDir);
		cfgEditMode.set(session.settings, "replace");
		const tool = new WriteTool(session);
		const content = "no anchors here\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);
		expect(text.startsWith("[")).toBe(false);
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});

	it("reports UTF-8 bytes, not JavaScript string length", async () => {
		const filePath = path.join(tmpDir, "notes.txt");
		const session = createSession(tmpDir);
		cfgEditMode.set(session.settings, "replace");
		const tool = new WriteTool(session);
		const content = "café\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		expect(resultText(result)).toBe(`Successfully wrote 6 bytes to ${path.relative(tmpDir, filePath)}`);
	});

	it("writes numbered data verbatim but still strips copied read rows", async () => {
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const dump = "100000000: 30 00 00 54 bc.eq 0x100000004\n100000004: c0 03 5f d6 ret\n";
		const dumpPath = path.join(tmpDir, "disassembly.txt");
		const dumpResult = await tool.execute("call-1", { path: dumpPath, content: dump });
		expect(resultText(dumpResult)).not.toContain("auto-stripped");
		expect(await Bun.file(dumpPath).text()).toBe(dump);

		const echoPath = path.join(tmpDir, "echo.ts");
		await tool.execute("call-2", { path: echoPath, content: "1:const a = 1;\n2:const b = 2;\n" });
		expect(await Bun.file(echoPath).text()).toBe("const a = 1;\nconst b = 2;\n");
	});
});
