import { describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pythonExecutor from "../python-executor";
import type { ToolSession } from "./index";
import { createPythonTool } from "./python";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => "session-file",
		getSessionSpawns: () => "*",
		settings: {
			getImageAutoResize: () => true,
			getLspFormatOnWrite: () => true,
			getLspDiagnosticsOnWrite: () => true,
			getLspDiagnosticsOnEdit: () => false,
			getEditFuzzyMatch: () => true,
			getGitToolEnabled: () => true,
			getBashInterceptorEnabled: () => true,
			getBashInterceptorSimpleLsEnabled: () => true,
			getBashInterceptorRules: () => [],
			getPythonToolMode: () => "ipy-only",
			getPythonKernelMode: () => "per-call",
		},
	};
}

describe("python tool execution", () => {
	it("passes kernel options from settings and args", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "python-tool-"));
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
			stdinRequested: false,
		});

		const tool = createPythonTool(createSession(tempDir));
		const result = await tool.execute(
			"call-id",
			{ code: "print('hi')", timeout: 5, workdir: tempDir, reset: true },
			undefined,
			undefined,
			undefined,
		);

		expect(executeSpy).toHaveBeenCalledWith(
			"print('hi')",
			expect.objectContaining({
				cwd: tempDir,
				timeout: 5000,
				sessionId: "session-file",
				kernelMode: "per-call",
				reset: true,
			}),
		);
		const text = result.content.find((item) => item.type === "text")?.text;
		expect(text).toBe("ok");

		executeSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});
});
