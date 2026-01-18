import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pythonExecutor from "../src/core/python-executor";
import * as pythonKernel from "../src/core/python-kernel";
import { createTools, type ToolSession } from "../src/core/tools/index";
import { createPythonTool } from "../src/core/tools/python";

function createSettings(overrides?: Partial<ToolSession["settings"]>): ToolSession["settings"] {
	return {
		getImageAutoResize: () => true,
		getLspFormatOnWrite: () => false,
		getLspDiagnosticsOnWrite: () => true,
		getLspDiagnosticsOnEdit: () => false,
		getEditFuzzyMatch: () => true,
		getGitToolEnabled: () => false,
		getBashInterceptorEnabled: () => false,
		getBashInterceptorSimpleLsEnabled: () => true,
		getBashInterceptorRules: () => [],
		getPythonToolMode: () => "ipy-only",
		getPythonKernelMode: () => "session",
		...overrides,
	};
}

function createSession(cwd: string, overrides?: Partial<ToolSession["settings"]>): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => "session.json",
		getSessionSpawns: () => null,
		settings: createSettings(overrides),
	};
}

describe("python tool settings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `python-tool-settings-${crypto.randomUUID()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes python tool when kernel is available", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const tools = await createTools(createSession(testDir), ["python"]);

		expect(tools.map((tool) => tool.name)).toEqual(["python"]);
	});

	it("falls back to bash when python is unavailable", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({
			ok: false,
			reason: "missing",
		});
		const tools = await createTools(createSession(testDir), ["python"]);

		expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
	});

	it("passes kernel mode from settings to executor", async () => {
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = createSession(testDir, { getPythonKernelMode: () => "per-call" });
		const pythonTool = createPythonTool(session);

		await pythonTool.execute("tool-call", { code: "print(1)" });

		expect(executeSpy).toHaveBeenCalledWith(
			"print(1)",
			expect.objectContaining({ kernelMode: "per-call", sessionId: "session.json" }),
		);
	});
});
