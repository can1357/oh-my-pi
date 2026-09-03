import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_FUZZY_THRESHOLD,
	type EditToolDetails,
	executeHashlineSingle,
	executePatchSingle,
	executeReplace,
	type hashlineEditParamsSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import { HashlineFilesystem } from "@oh-my-pi/pi-coding-agent/edit/hashline/filesystem";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { WritethroughCallback } from "@oh-my-pi/pi-coding-agent/lsp";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

function makeBridge() {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		// Per ACP spec, writeTextFile writes to disk then notifies the editor buffer.
		// The mock fulfils the disk-write half so post-write verification passes.
		writeTextFile: async ({ path: p, content: c }) => {
			await Bun.write(p, c);
		},
	};
	const spy = spyOn(bridge, "writeTextFile");
	return { bridge, spy };
}

/**
 * Stand-in for an ACP client whose save pipeline reformats content before it
 * settles on disk (e.g. Zed's `format_on_save` rewriting indentation). Unlike
 * `makeBridge`, the bytes actually persisted differ from what was requested —
 * exercising the read-back/drift-detection path in `routeWriteThroughBridge`.
 */
function makeDriftingBridge() {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		writeTextFile: async ({ path: p, content: c }) => {
			await Bun.write(p, c.replace(/^ {4}/gm, "\t"));
		},
	};
	const spy = spyOn(bridge, "writeTextFile");
	return { bridge, spy };
}

function makeWritethroughMock(): { writethrough: WritethroughCallback; spy: { calledWith: string[] } } {
	const spy = { calledWith: [] as string[] };
	// The writethrough must actually write to disk so post-write verification passes.
	const writethrough: WritethroughCallback = async (dst, content) => {
		spy.calledWith.push(dst);
		await Bun.write(dst, content);
		return undefined;
	};
	return { writethrough, spy };
}

// ─── HashlineFilesystem ───────────────────────────────────────────────────────

describe("HashlineFilesystem ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-hashline-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("routes plain workspace writes through the bridge and skips writethrough", async () => {
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const content = "hello world\n";
		const relPath = "output.txt";
		const absPath = path.join(tmpDir, relPath);

		await filesystem.writeText(relPath, content);

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(bridgeSpy).toHaveBeenCalledWith({ path: absPath, content });
		expect(writeSpy.calledWith).toHaveLength(0);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});
		// Use a no-op writethrough so the call succeeds without real LSP
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		await filesystem.writeText(planPath, planContent);

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith.length).toBeGreaterThan(0);
	});

	it("keeps a local sandbox artifact addressed by absolute path off the ACP bridge", async () => {
		// Tag-based path recovery rebinds a bare `cfg-…-plan.md` edit onto its
		// absolute sandbox path. Even though it is NOT the active plan file
		// (planFilePath is still the default local://PLAN.md, a fresh-slug plan),
		// the OMP-owned artifact must be written to disk, never pushed to the editor.
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: false },
		});
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const sandboxAbs = resolveLocalUrlToPath("local://cfg-module-hygiene-plan.md", {
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			getSessionId: () => "session-a",
		});

		await filesystem.writeText(sandboxAbs, "# Plan\n");

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toContain(sandboxAbs);
	});

	it("returns the client's actually-persisted content, not the requested content, when the bridge reformats on save", async () => {
		const { bridge } = makeDriftingBridge();
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const requested = "function f() {\n    return 1;\n}\n";
		const relPath = "output.ts";
		const absPath = path.join(tmpDir, relPath);

		const result = await filesystem.writeText(relPath, requested);

		// Ground truth: the "editor" reformatted spaces to tabs on save.
		const onDisk = await fs.readFile(absPath, "utf8");
		expect(onDisk).toBe("function f() {\n\treturn 1;\n}\n");
		expect(onDisk).not.toBe(requested);

		// `writeText`'s result MUST reflect reality, not the pre-write intent —
		// this is what the patcher keys the next snapshot tag on.
		expect(result.text).toBe(onDisk);
	});
});

// ─── executeHashlineSingle end-to-end (model-visible payload) ────────────────

function getText(result: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

function extractTag(text: string): string {
	const match = /#([0-9A-Fa-f]{4})\]/.exec(text);
	if (!match) throw new Error(`no snapshot tag found in: ${text}`);
	return match[1] ?? "";
}

describe("executeHashlineSingle model-visible payload under write-time drift", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-hashline-e2e-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("keeps the model-visible diff scoped to the intended hunk, not the whole reformatted file, when the bridge drifts", async () => {
		// Source-shaped content (short lines, closing braces at col 0) is exactly
		// what defeats the compact-diff-preview's contiguous-run collapse, so this
		// is the worst case for payload inflation, not a favorable one.
		const lines = ["function f() {"];
		for (let i = 0; i < 60; i++) lines.push(`    const v${i} = ${i};`);
		lines.push("}", "");
		const original = lines.join("\n");
		const relPath = "big.ts";
		const absPath = path.join(tmpDir, relPath);
		await fs.writeFile(absPath, original);

		const { bridge } = makeDriftingBridge();
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const realTag = computeFileHash(original);

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+    const v0 = 100;`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const text = getText(result);

		// Ground truth: the "editor" reformatted every untouched indented line.
		const onDisk = await fs.readFile(absPath, "utf8");
		expect(onDisk).not.toBe(original);
		expect(onDisk.split("\n").filter(l => l.startsWith("\t")).length).toBeGreaterThan(50);

		// The model-visible response must stay small: a few lines around the
		// intended hunk plus a short warning, not a diff spanning ~60 reformatted
		// lines. This is the regression a naive "key the diff on the verified
		// content" fix would introduce.
		expect(text.length).toBeLessThan(600);
		expect(text).toMatch(/reformatted it on save/);
		expect(text).not.toContain("v59"); // an untouched, far-away line never appears

		// And the returned tag must still be valid for a follow-up edit.
		const nextTag = extractTag(text);
		const followUp = await executeHashlineSingle({
			session,
			input: `[${relPath}#${nextTag}]\nPUT 1-1:\n+function g() {`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		expect(getText(followUp)).not.toMatch(/mismatch|stale/i);
	});

	it("does not warn about drift for a byte-perfect (non-reformatting) bridge write on a BOM'd file", async () => {
		const { bridge } = makeBridge(); // verbatim: writes exactly what it's given
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const relPath = "bom.txt";
		const absPath = path.join(tmpDir, relPath);
		const original = "\uFEFFhello\nworld\n";
		await fs.writeFile(absPath, original);

		const realTag = computeFileHash("hello\nworld\n"); // tag hashes BOM-stripped content

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+earth`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const text = getText(result);
		expect(text).not.toMatch(/reformatted it on save/);
	});

	it("propagates a notebook's editable view (not raw JSON) as the write result, so a follow-up edit's tag stays valid", async () => {
		const relPath = "nb.ipynb";
		const absPath = path.join(tmpDir, relPath);
		const notebook = {
			cells: [{ cell_type: "code", source: ["print('old')\n"], metadata: {}, outputs: [], execution_count: null }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		};
		await fs.writeFile(absPath, JSON.stringify(notebook));

		const { writethrough } = makeWritethroughMock();
		// No bridge at all: this reproduces the bug on the plain writethrough
		// path, where the notebook's view-space (cell text) and storage-space
		// (full JSON) were being conflated regardless of any ACP client.
		const session = createSession(tmpDir);

		const cellView = "# %% [code] cell:0\nprint('old')\n";
		const realTag = computeFileHash(cellView);

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+print('new')`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		const text = getText(result);
		expect(text).not.toMatch(/mismatch|stale/i);

		const nextTag = extractTag(text);
		const followUp = await executeHashlineSingle({
			session,
			input: `[${relPath}#${nextTag}]\nPUT 2-2:\n+print('newer')`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		expect(getText(followUp)).not.toMatch(/mismatch|stale/i);

		const updated = JSON.parse(await fs.readFile(absPath, "utf8"));
		expect(updated.cells[0].source.join("")).toContain("newer");
	});
});

// ─── executeReplace ─────────────────────────────────────────────────────────

describe("executeReplace ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-replace-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("routes plain workspace writes through the bridge and skips writethrough", async () => {
		const filePath = path.join(tmpDir, "target.txt");
		await Bun.write(filePath, "old content\n");

		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		await executeReplace({
			session,
			path: filePath,
			params: { old_string: "old content", new_string: "new content", replace_all: false },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		const [[callArg]] = bridgeSpy.mock.calls;
		expect(callArg.path).toBe(filePath);
		expect(callArg.content).toContain("new content");
		expect(writeSpy.calledWith).toHaveLength(0);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		// Create the plan file with some content to replace
		const resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "old plan\n");

		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await executeReplace({
			session,
			path: planPath,
			params: { old_string: "old plan", new_string: "new plan", replace_all: false },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith.length).toBeGreaterThan(0);
	});
});

// ─── executePatchSingle ───────────────────────────────────────────────────────

describe("executePatchSingle ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-patch-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("routes plain workspace writes through the bridge and skips writethrough", async () => {
		const filePath = path.join(tmpDir, "target.txt");
		await Bun.write(filePath, "a\n");

		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		await executePatchSingle({
			session,
			path: filePath,
			params: { op: "update", diff: "@@\n-a\n+b" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		const [[callArg]] = bridgeSpy.mock.calls;
		expect(callArg.path).toBe(filePath);
		expect(callArg.content).toContain("b");
		expect(writeSpy.calledWith).toHaveLength(0);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		const resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "a\n");

		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await executePatchSingle({
			session,
			path: planPath,
			params: { op: "update", diff: "@@\n-a\n+b" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith.length).toBeGreaterThan(0);
	});
});
