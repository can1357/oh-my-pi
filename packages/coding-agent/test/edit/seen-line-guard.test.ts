import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@oh-my-pi/pi-coding-agent/edit";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({ "edit.enforceSeenLines": true }),
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
			executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 12-12:\n+EDITED`, session)),
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

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 2-2:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("EDITED");
	});

	it("records raw single-range reads as seen without emitting a hashline header", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), CONTENT, [1]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:raw:4-6` });
		const text = resultText(read);
		expect(text).not.toMatch(HEADER);
		expect(text).toContain("line 4\nline 5\nline 6");
		expect(text).not.toContain("4:line 4");

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(4)).toBe(true);
		expect(seen?.has(5)).toBe(true);
		expect(seen?.has(6)).toBe(true);
		expect(seen?.has(10)).toBe(false);

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 5-5:\n+RAW EDITED`, session));
		const edited = await Bun.file(file).text();
		expect(edited).toContain("line 4\nRAW EDITED\nline 6");
		expect(edited).not.toContain("line 5");
	});

	it("records every raw multi-range line and rejects anchors outside those ranges", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), CONTENT, [12]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:raw:2-3,7-8` });
		const text = resultText(read);
		expect(text).not.toMatch(HEADER);
		expect(text).toBe("line 2\nline 3\n\n…\n\nline 7\nline 8");

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(2)).toBe(true);
		expect(seen?.has(3)).toBe(true);
		expect(seen?.has(7)).toBe(true);
		expect(seen?.has(8)).toBe(true);
		expect(seen?.has(5)).toBe(false);

		await expect(
			executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 5-5:\n+OUTSIDE`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await Bun.file(file).text()).toBe(CONTENT);

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 7-7:\n+RAW RANGE EDITED`, session));
		const edited = await Bun.file(file).text();
		expect(edited).toContain("line 6\nRAW RANGE EDITED\nline 8");
		expect(edited).not.toContain("line 7");
	});

	it("does not mark a raw multi-range line as seen when the byte cap prevents full output", async () => {
		const file = path.join(tmpDir, "wide-raw.txt");
		const hugeLine = "x".repeat(DEFAULT_MAX_BYTES + 1);
		const content = `${hugeLine}\nline 2\n\nline 4\n`;
		await Bun.write(file, content);
		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), content, [4]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:raw:1-1,3-3` });
		expect(resultText(read)).toBe("");

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(1)).toBe(false);
		expect(seen?.has(3)).toBe(true);
		expect(seen?.has(4)).toBe(true);

		await expect(
			executeHashlineSingle(execOptions(`[wide-raw.txt#${tag}]\nPUT 1-1:\n+REPLACED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await Bun.file(file).text()).toBe(content);
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
		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT >2:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("line 2\nEDITED");
	});

	it("marks raw ACP bridge blank-line reads as seen without hashline output", async () => {
		const file = path.join(tmpDir, "notes.txt");
		const content = "";
		await Bun.write(file, content);
		const session = createBridgeSession(tmpDir, content);
		const store = getFileSnapshotStore(session);
		const tag = store.record(canonicalSnapshotKey(file), content, [2]);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:raw:1-1` });
		const text = resultText(read);
		expect(text).not.toMatch(HEADER);
		expect(text).not.toContain("1:");
		expect(text).toBe("");

		const seen = store.byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(1)).toBe(true);
		expect(seen?.has(2)).toBe(true);

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 1-1:\n+RAW BLANK EDITED`, session));
		expect(await Bun.file(file).text()).toBe("RAW BLANK EDITED");
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
				`[src/main.c#${tag}]\nPUT >1122:\n+\tbeep_3k8hz_on();\n+\tk_sleep(K_MSEC(300));\n+\tbeep_3k8hz_off();\nCUT 1288-1291`,
				session,
			),
		);
		const edited = await Bun.file(file).text();
		expect(edited).toContain("\tconfigure_gpio();\n\tbeep_3k8hz_on();\n\tk_sleep(K_MSEC(300));\n\tbeep_3k8hz_off();");
		expect(edited).not.toContain("\tbeep_3k8hz_on();\n\tline_1289();\n\tk_sleep(K_MSEC(300));");
	});

	it("reveals the actual line content in the rejection and unblocks a same-tag retry", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		let message: string | undefined;
		try {
			await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 10-12:\n+X10\n+X11\n+X12`, session));
		} catch (err) {
			message = (err as Error).message;
		}
		// Rejection surfaces the ACTUAL file content at the unseen anchor lines.
		expect(message).toMatch(/never displayed \(it showed/);
		expect(message).toContain("Actual file content at those lines:");
		expect(message).toContain("10:line 10");
		expect(message).toContain("11:line 11");
		expect(message).toContain("12:line 12");
		// Snapshot text preserved verbatim — the reject is still a no-op on disk.
		expect(await Bun.file(file).text()).toBe(CONTENT);

		// The revealed lines are now in the snapshot's seen set, so a straight
		// retry with the same `[path#tag]` header succeeds without a re-read.
		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 10-12:\n+X10\n+X11\n+X12`, session));
		const after = await Bun.file(file).text();
		expect(after).toContain("X10\nX11\nX12");
		expect(after).not.toContain("line 10");
	});

	it("keeps the re-read fallback when the anchor set exceeds the inline reveal cap", async () => {
		const file = path.join(tmpDir, "long.txt");
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = createSession(tmpDir);

		// Partial read of the head — seenLines = 1..3 only.
		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		// Anchor 60 unseen lines — deliberately over the 40-line cap.
		const dels = Array.from({ length: 60 }, (_, i) => `CUT ${100 + i}`).join("\n");
		let message: string | undefined;
		try {
			await executeHashlineSingle(execOptions(`[long.txt#${tag}]\n${dels}`, session));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/never displayed \(it showed/);
		// Only the first cap-worth of lines are revealed.
		expect(message).toContain("Preview of the actual file content at the first 40 unseen line(s)");
		expect(message).toContain("100:line 100");
		expect(message).toContain("139:line 139");
		expect(message).not.toContain("140:line 140");
		// Guidance directs at a range re-read of the FULL anchor range.
		expect(message).toMatch(/long\.txt:100-159/);
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});

	it("marks column-clipped read lines as seen (clipped-line check removed)", async () => {
		// A 4KB single line — the read tool's column cap (default 512 chars)
		// clips this into `<prefix>…` in the numbered output. The clipped-line
		// exclusion was removed, so the displayed line counts as seen and a
		// follow-up edit anchored there applies even with the guard enabled.
		const file = path.join(tmpDir, "wide.txt");
		const wide = "a".repeat(4096);
		const content = `head\n${wide}\nfoot\n`;
		await Bun.write(file, content);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:2` });
		const tag = tagFromOutput(resultText(read));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(2)).toBe(true);

		await executeHashlineSingle(execOptions(`[wide.txt#${tag}]\nPUT 2-2:\n+REPLACED`, session));
		expect(await Bun.file(file).text()).toBe("head\nREPLACED\nfoot\n");
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
			settings: Settings.isolated({
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
				"edit.enforceSeenLines": true,
			}),
			enableLsp: false,
		} as ToolSession;
	}

	it("records matched lines as seen and rejects an edit on an unsearched line", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new GrepTool(session).execute("s1", { pattern: "NEEDLE", path: file });
		const tag = tagFromOutput(resultText(search));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(4)).toBe(true);
		expect(seen?.has(8)).toBe(false);

		// The matched line is in the seen set, so editing it applies.
		await executeHashlineSingle(execOptions(`[code.txt#${tag}]\nPUT 4-4:\n+NEEDLE edited`, session));
		expect(await Bun.file(file).text()).toContain("NEEDLE edited");
	});

	it("rejects editing an unsearched line under a search-minted tag", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new GrepTool(session).execute("s1", { pattern: "NEEDLE", path: file });
		const tag = tagFromOutput(resultText(search));

		await expect(executeHashlineSingle(execOptions(`[code.txt#${tag}]\nPUT 8-8:\n+X`, session))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});
});

describe("seen-line guard disabled by default", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-off-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("applies an edit on an unseen line when edit.enforceSeenLines is off (default)", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		// createSession enables the guard; a default session leaves it off.
		const session = { ...createSession(tmpDir), settings: Settings.isolated() } as ToolSession;

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		// Line 12 was never displayed, but the guard is disabled, so it applies.
		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nPUT 12-12:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("EDITED");
	});
});
