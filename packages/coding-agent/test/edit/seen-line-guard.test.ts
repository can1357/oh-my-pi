import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@pk-nerdsaver-ai/pi-coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { GrepTool } from "../../src/tools/grep";

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
	} as ToolSession;
}

function createBridgeSession(cwd: string, content: string): ToolSession {
	const bridge = {
		capabilities: { readTextFile: true },
		readTextFile: async () => content,
	};
	return {
		...createSession(cwd),
		getClientBridge: () => bridge,
	} as ToolSession;
}

function execOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

const HEADER = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function tagFromOutput(text: string): string {
	const match = HEADER.exec(text);
	if (!match) throw new Error(`no hashline header in read output:\n${text}`);
	return match[2];
}

// Flat plain-text lines so bracket-context never pulls a distant boundary line
// into the displayed window — the seen set stays exactly the read range (+context).
const CONTENT = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("read → edit seen-line guard", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-guard-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("records the displayed range as seen and excludes far lines", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(1)).toBe(true);
		expect(seen?.has(3)).toBe(true);
		expect(seen?.has(12)).toBe(false);
	});

	it("rejects an edit on a line the partial read never displayed", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		await expect(
			executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 12.=12:\n+EDITED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		// The reject left the file untouched.
		expect(await Bun.file(file).text()).toBe(CONTENT);
	});

	it("applies an edit on a displayed line", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("EDITED");
	});

	it("merges displayed lines from ACP bridge range reads into existing provenance", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createBridgeSession(tmpDir, CONTENT);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), CONTENT, [12]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		expect(tagFromOutput(resultText(read))).toBe(tag);

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(2)).toBe(true);
		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nINS.POST 2:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("line 2\nEDITED");
	});

	it("merges displayed lines from ACP bridge multi-range reads into existing provenance", async () => {
		const file = path.join(tmpDir, "src/main.c");
		const lines = Array.from({ length: 1300 }, (_, i) => `\tline_${i + 1}();`);
		lines[1121] = "\tconfigure_gpio();";
		lines[1287] = "\tbeep_3k8hz_on();";
		lines[1289] = "\tk_sleep(K_MSEC(300));";
		lines[1290] = "\tbeep_3k8hz_off();";
		const content = `${lines.join("\n")}\n`;
		await Bun.write(file, content);
		const session = createBridgeSession(tmpDir, content);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), content, [1288, 1289, 1290, 1291]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1118-1126,1284-1292` });
		const text = resultText(read);
		expect(tagFromOutput(text)).toBe(tag);
		expect(text).toContain("1122:\tconfigure_gpio();");

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(1122)).toBe(true);
		await executeHashlineSingle(
			execOptions(
				`[src/main.c#${tag}]\nINS.POST 1122:\n+\tbeep_3k8hz_on();\n+\tk_sleep(K_MSEC(300));\n+\tbeep_3k8hz_off();\nDEL 1288.=1291`,
				session,
			),
		);
		const edited = await Bun.file(file).text();
		expect(edited).toContain("\tconfigure_gpio();\n\tbeep_3k8hz_on();\n\tk_sleep(K_MSEC(300));\n\tbeep_3k8hz_off();");
		expect(edited).not.toContain("\tbeep_3k8hz_on();\n\tline_1289();\n\tk_sleep(K_MSEC(300));");
	});
});

describe("search → edit seen-line guard", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-search-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function searchSession(cwd: string): ToolSession {
		return {
			cwd,
			hasUI: false,
			hasEditTool: true,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
			// Zero context so the seen set is exactly the matched lines.
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
			enableLsp: false,
		} as ToolSession;
	}

	it("records matched lines as seen and rejects an edit on an unsearched line", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new GrepTool(session).execute("s1", { pattern: "NEEDLE", paths: [file] });
		const tag = tagFromOutput(resultText(search));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(4)).toBe(true);
		expect(seen?.has(8)).toBe(false);

		// The matched line is in the seen set, so editing it applies.
		await executeHashlineSingle(execOptions(`[code.txt#${tag}]\nSWAP 4.=4:\n+NEEDLE edited`, session));
		expect(await Bun.file(file).text()).toContain("NEEDLE edited");
	});

	it("rejects editing an unsearched line under a search-minted tag", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new GrepTool(session).execute("s1", { pattern: "NEEDLE", paths: [file] });
		const tag = tagFromOutput(resultText(search));

		await expect(executeHashlineSingle(execOptions(`[code.txt#${tag}]\nSWAP 8.=8:\n+X`, session))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});
});
