import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import { namespaceSessionId } from "../../src/eval/py/index";
import { PythonKernel } from "../../src/eval/py/kernel";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Fault injection for #18644 through the real shared path: a live Python kernel
// whose tool channel never answers, standing in for the serial (Windows) runner
// blocked in the cell that made the bridge call. Pre-fix, `agent()` with `tools`
// from a bridge call hangs in `describeEvalTools` until this test's timeout
// fires; post-fix the bridge marker fails it fast without touching the kernel.
// Only pre-existing modules are imported, so the pre-fix failure is the hang
// itself rather than a missing import.

// Real kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";
const pythonPath = Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-bridge-tools-deadlock-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

describe("eval bridge tools deadlock (#18644)", () => {
	it.skipIf(!PYTHON_INTEGRATION || !pythonPath)(
		"agent() with tools from a bridge call fails fast when the kernel cannot answer",
		async () => {
			const sessionId = `bridge-deadlock-${crypto.randomUUID()}`;
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				settings: Settings.isolated({ "python.interpreter": pythonPath }),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getArtifactsDir: () => null,
				getSessionId: () => sessionId,
				getEvalSessionId: () => sessionId,
				getToolByName: () => undefined,
			} as unknown as ToolSession;
			// Warm a real retained kernel under this session's identity so the
			// preflight finds a live kernel and would round-trip to it.
			const warmed = await executePython("print('ready')", {
				cwd: tempDir.path(),
				sessionId: namespaceSessionId(sessionId),
				interpreter: pythonPath,
				timeoutMs: 120_000,
			});
			expect(warmed.exitCode).toBe(0);

			// The blocked cell's kernel never answers tool requests.
			const invokeSpy = vi.spyOn(PythonKernel.prototype, "invokeTool").mockImplementation(() => {
				const { promise } = Promise.withResolvers<never>();
				return promise;
			});
			// Hang-repro bound: bun skips afterEach for a timed-out test, which would
			// strand the warmed kernel and the bridge server and keep this process
			// alive past the failure. Dispose them just after the test timeout so the
			// pre-fix failure is a bounded timeout, not a suite hang. Cleared on the
			// post-fix fast path, where the test settles in milliseconds.
			const hangWatchdog = setTimeout(() => {
				void disposeAllKernelSessions();
				void disposePyToolBridge();
			}, 35_000);
			hangWatchdog.unref?.();
			try {
				await expect(
					callSessionTool("__agent__", { prompt: "Reply with exactly: pong", tools: ["probe_echo"] }, { session }),
				).rejects.toThrow(/blocked waiting for this spawn call/);
				expect(invokeSpy).not.toHaveBeenCalled();
			} finally {
				clearTimeout(hangWatchdog);
				invokeSpy.mockRestore();
			}
		},
		30_000,
	);
});
