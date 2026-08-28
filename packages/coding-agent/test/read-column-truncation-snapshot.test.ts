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
import { Patch, Patcher } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import { HashlineFilesystem } from "@oh-my-pi/pi-coding-agent/edit/hashline/filesystem";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;
const COLUMN_CAP = 64;
const LONG_LINE_LEN = COLUMN_CAP * 3;

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("tools.outputMaxColumns", COLUMN_CAP);
	settings.set("read.summarize.enabled", false);
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

async function applyEditWithTag(args: {
	session: ToolSession;
	tmpDir: string;
	filePath: string;
	header: string;
	patchBody: string;
}): Promise<void> {
	const patchInput = `${args.header}\n${args.patchBody}`;
	const patch = Patch.parse(patchInput, { cwd: args.tmpDir });
	expect(patch.sections).toHaveLength(1);

	const filesystem = new HashlineFilesystem({
		session: args.session,
		writethrough: writethroughNoop,
		beginDeferredDiagnosticsForPath: () => {
			throw new Error("deferred diagnostics unused with writethroughNoop");
		},
	});
	const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(args.session) });
	const prepared = await patcher.prepare(patch.sections[0]!);
	await patcher.commit(prepared);
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
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag);
		expect(snapshot).not.toBeNull();

		// The snapshot MUST hold the on-disk text, not the display-truncated version.
		expect(snapshot?.text).toBe(fullText);
		expect(snapshot?.text.split("\n")[1]).toBe(longLine);
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
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag);
		expect(snapshot?.text.split("\n")[1]).toBe(longLine);
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
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag);
		expect(snapshot?.text.split("\n")[1]).toBe(longLine);
		expect(snapshot?.text.split("\n")[5]).toBe(longLine);
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
			tmpDir,
			filePath,
			header,
			patchBody: "PUT 3-3:\n+epilogue\n",
		});

		const after = await fs.readFile(filePath, "utf8");
		expect(after).toBe(`intro\n${longLine}\nepilogue\n`);
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
			tmpDir,
			filePath,
			header,
			patchBody: "CUT 2\n",
		});

		expect(await fs.readFile(filePath, "utf8")).toBe("first\nlast\n");
	});
});
