import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { DEFAULT_FUZZY_THRESHOLD, executePatchSingle, executeReplaceSingle } from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import { HashlineFilesystem } from "@pk-nerdsaver-ai/pi-coding-agent/edit/hashline/filesystem";
import { resolveLocalUrlToPath } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import type { WritethroughCallback } from "@pk-nerdsaver-ai/pi-coding-agent/lsp";
import type { PlanModeState } from "@pk-nerdsaver-ai/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

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
});

// ─── executeReplaceSingle ─────────────────────────────────────────────────────

describe("executeReplaceSingle ACP fs routing", () => {
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

		await executeReplaceSingle({
			session,
			path: filePath,
			params: { old_text: "old content", new_text: "new content", all: false },
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

		await executeReplaceSingle({
			session,
			path: planPath,
			params: { old_text: "old plan", new_text: "new plan", all: false },
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
