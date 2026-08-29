import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_FUZZY_THRESHOLD,
	EditTool,
	type EditToolDetails,
	executePatchSingle,
	executeReplace,
} from "@oh-my-pi/pi-coding-agent/edit";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// ─── Minimal ToolSession stub ────────────────────────────────────────────────

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

// ─── Setup / teardown ────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-diff-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

// ─── executePatchSingle ───────────────────────────────────────────────────────

describe("executePatchSingle — oldText/newText propagation", () => {
	test("update: oldText is pre-edit content, newText is post-edit content", async () => {
		await Bun.write(path.join(tempDir, "foo.txt"), "a\n");

		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "foo.txt",
			params: { op: "update", diff: "@@\n-a\n+b" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(result.details?.path).toBe(path.join(tempDir, "foo.txt"));
		expect(result.details?.oldText).toBe("a\n");
		expect(result.details?.newText).toBe("b\n");
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toBe("[foo.txt]\n1:b");
	});

	test("create: oldText is undefined, newText is the created content", async () => {
		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "new.txt",
			params: { op: "create", diff: "hello\n" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(result.details?.path).toBe(path.join(tempDir, "new.txt"));
		expect(result.details?.oldText).toBeUndefined();
		expect(result.details?.newText).toBe("hello\n");
	});

	test("delete: oldText is prior content, newText is undefined", async () => {
		await Bun.write(path.join(tempDir, "gone.txt"), "will be deleted\n");

		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "gone.txt",
			params: { op: "delete" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(result.details?.path).toBe(path.join(tempDir, "gone.txt"));
		expect(result.details?.oldText).toBe("will be deleted\n");
		expect(result.details?.newText).toBeUndefined();
	});
});

describe("EditTool patch aggregation — oldText/newText propagation", () => {
	test("create followed by update preserves create-shaped oldText", async () => {
		const tool = new EditTool(makeSession(tempDir));

		const result = await tool.execute("call-create-update", {
			path: "created.txt",
			edits: [
				{ op: "create", diff: "a\n" },
				{ op: "update", diff: "@@\n-a\n+b" },
			],
		});
		const details = result.details as EditToolDetails;
		expect(details.path).toBe(path.join(tempDir, "created.txt"));
		expect("oldText" in details).toBe(true);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBe("b\n");
	});

	test("update followed by delete preserves delete-shaped newText", async () => {
		await Bun.write(path.join(tempDir, "updated-then-gone.txt"), "a\n");
		const tool = new EditTool(makeSession(tempDir));

		const result = await tool.execute("call-update-delete", {
			path: "updated-then-gone.txt",
			edits: [{ op: "update", diff: "@@\n-a\n+b" }, { op: "delete" }],
		});
		const details = result.details as EditToolDetails;
		expect(details.path).toBe(path.join(tempDir, "updated-then-gone.txt"));
		expect(details.oldText).toBe("a\n");
		expect("newText" in details).toBe(true);
		expect(details.newText).toBeUndefined();
	});
});

// ─── executeReplace ─────────────────────────────────────────────────────────

describe("executeReplace — oldText/newText propagation", () => {
	test("replace: oldText is full file before, newText is full file after", async () => {
		const originalContent = "line one\nline two\nline three\n";
		await Bun.write(path.join(tempDir, "bar.txt"), originalContent);

		const result = await executeReplace({
			session: makeSession(tempDir),
			path: "bar.txt",
			params: { old_string: "line two", new_string: "line TWO" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(result.details?.path).toBe(path.join(tempDir, "bar.txt"));
		expect(result.details?.oldText).toBe(originalContent);
		expect(result.details?.newText).toBe("line one\nline TWO\nline three\n");
		const text = result.content.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toContain("[bar.txt]\n1:line one\n2:line TWO\n3:line three");
		expect(text).not.toMatch(/^\[[^\]\n]+#[0-9A-F]{4}\]/);
	});
});
