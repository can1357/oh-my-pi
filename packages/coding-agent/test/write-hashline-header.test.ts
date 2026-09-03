import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Patch, Patcher } from "@oh-my-pi/hashline";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import { HashlineFilesystem } from "@oh-my-pi/pi-coding-agent/edit/hashline/filesystem";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag!);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.text).toBe(content);
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
		const patch = Patch.parse(patchInput, { cwd: tmpDir });
		expect(patch.sections).toHaveLength(1);

		const filesystem = new HashlineFilesystem({
			session,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(session) });
		const prepared = await patcher.prepare(patch.sections[0]!);
		const sectionResult = await patcher.commit(prepared);
		expect(sectionResult.op).toBe("update");

		const final = await fs.readFile(filePath, "utf8");
		expect(final).toBe("export const enabled = true;\n");
	});

	it("omits the hashline header when the edit mode is not hashline", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		const tool = new WriteTool(session);
		const content = "no anchors here\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);
		expect(text.startsWith("[")).toBe(false);
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});
});
