import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { namespaceSessionId as namespaceJsSessionId, resolveJsKernelIdentity } from "../../src/eval/js";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { disposeAllKernelSessions, describePythonTools, executePython } from "../../src/eval/py/executor";
import { namespaceSessionId as namespacePythonSessionId } from "../../src/eval/py";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import { describeEvalTools } from "../../src/task/eval-tools";
import type { ToolSession } from "../../src/tools";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Issue #18644: only the Windows Python runner serves requests serially
// (`_serve_windows`), so only it deadlocks when a blocked cell's kernel is
// asked for its tools. POSIX Python serves tool requests on dedicated
// `omp-tool-<rid>` threads while a cell parks, and the JS kernel serves them
// inside the worker run context — the documented `wait()`-serve path. These
// tests pin both sides: POSIX/JS keep the live round-trip (a `describe` issued
// while a cell is parked resolves), and the Windows Python path fails fast
// with the busy-kernel error instead of deadlocking.

const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";
const pythonPath = Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-tool-busy-");
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(id: string): ToolSession {
	// The interpreter matches what the Python tests warm their kernels with, so
	// `resolvePythonKernelIdentity` finds the retained kernel (empty reads back
	// as undefined, keeping the JS test on the default interpreter).
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated(pythonPath ? { "python.interpreter": pythonPath } : {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getToolByName: () => undefined,
	} as unknown as ToolSession;
}

describe("eval kernel-defined tools behind a running cell (#18644)", () => {
	it("JS: a describe issued while a cell is parked still resolves", async () => {
		const id = `tool-busy-js-${crypto.randomUUID()}`;
		const session = makeSession(id);
		const sessionKey = namespaceJsSessionId(id);
		expect(resolveJsKernelIdentity(session).sessionKey).toBe(sessionKey);

		const defined = await executeJs(
			`tool(function probe_echo({ text }) { return text; }, { name: "probe_echo", description: "Echo.", parameters: { type: "object", properties: { text: { type: "string" } } } });`,
			{ sessionId: sessionKey, session },
		);
		expect(defined.exitCode).toBe(0);

		// The cell prints once it is running, then parks forever; the host
		// awaits that print rather than guessing a delay.
		const parked = Promise.withResolvers<void>();
		const controller = new AbortController();
		const cell = executeJs(`console.log("parked");\nawait new Promise(() => {});`, {
			sessionId: sessionKey,
			session,
			signal: controller.signal,
			onChunk: chunk => {
				if (chunk.includes("parked")) parked.resolve();
			},
		});
		const cellSettled = cell.then(
			() => "resolved",
			(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
		);
		try {
			await parked.promise;
			// The cell is parked; the worker still answers the describe, so the
			// `agent(tools=[...])` preflight resolves instead of erroring.
			const descriptors = await describeEvalTools(session, ["probe_echo"]);
			expect(descriptors.map(descriptor => descriptor.name)).toEqual(["probe_echo"]);
			expect(descriptors[0]?.language).toBe("js");
		} finally {
			controller.abort(new Error("test: release the parked cell"));
			await cellSettled;
		}
	}, 30_000);

	it.skipIf(!PYTHON_INTEGRATION || !pythonPath)(
		"POSIX Python: a describe issued while a cell is parked still resolves",
		async () => {
			if (process.platform === "win32") return;
			const id = `tool-busy-py-${crypto.randomUUID()}`;
			const session = makeSession(id);
			const namespaced = namespacePythonSessionId(id);
			const options = { cwd: tempDir.path(), sessionId: namespaced, interpreter: pythonPath };

			const defined = await executePython(
				["@tool", "def probe_echo(text: str) -> str:", '    """Echo."""', "    return text"].join("\n"),
				options,
			);
			expect(defined.exitCode).toBe(0);

			const parked = Promise.withResolvers<void>();
			const controller = new AbortController();
			const cell = executePython(
				['print("parked", flush=True)', "import asyncio", "await asyncio.sleep(30)"].join("\n"),
				{
					...options,
					signal: controller.signal,
					onChunk: chunk => {
						if (chunk.includes("parked")) parked.resolve();
					},
				},
			);
			const cellSettled = cell.then(
				() => "resolved",
				(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
			);
			try {
				await parked.promise;
				// The cell is parked on the sleep; the runner's tool thread still
				// answers the describe, so the preflight resolves.
				const { tools, missing } = await describePythonTools(["probe_echo"], {
					...options,
					toolSession: session,
				});
				expect(missing).toEqual([]);
				expect(tools.map(tool => tool.name)).toEqual(["probe_echo"]);
				// And the full `agent(tools=[...])` path resolves names the same way.
				const descriptors = await describeEvalTools(session, ["probe_echo"]);
				expect(descriptors.map(descriptor => descriptor.name)).toEqual(["probe_echo"]);
			} finally {
				controller.abort(new Error("test: release the parked cell"));
				await cellSettled;
			}
		},
		60_000,
	);

	it.skipIf(!PYTHON_INTEGRATION || !pythonPath)(
		"Windows Python: a tool request behind a running cell fails fast (#18644)",
		async () => {
			const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
			if (!descriptor) throw new Error("process.platform descriptor is unavailable");
			const id = `tool-busy-win-${crypto.randomUUID()}`;
			const session = makeSession(id);
			const namespaced = namespacePythonSessionId(id);
			const options = { cwd: tempDir.path(), sessionId: namespaced, interpreter: pythonPath };

			// Warm the retained kernel unstubbed: startup probes the real platform.
			const defined = await executePython(
				["@tool", "def probe_echo(text: str) -> str:", '    """Echo."""', "    return text"].join("\n"),
				options,
			);
			expect(defined.exitCode).toBe(0);

			// From here the host believes it is Windows: the runner is treated
			// as serial, so a tool request behind a running cell must fail
			// fast instead of waiting for a reply that cannot come.
			const parked = Promise.withResolvers<void>();
			const controller = new AbortController();
			Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
			try {
				// Stands in for a cell blocked on `await agent(... tools ...)`:
				// on Windows the runner cannot read the describe until it settles.
				const cell = executePython(
					['print("parked", flush=True)', "import asyncio", "await asyncio.sleep(30)"].join("\n"),
					{
						...options,
						signal: controller.signal,
						onChunk: chunk => {
							if (chunk.includes("parked")) parked.resolve();
						},
					},
				);
				const cellSettled = cell.then(
					() => "resolved",
					(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
				);
				try {
					await parked.promise;
					await expect(
						callSessionTool(
							"__agent__",
							{ prompt: "Reply with exactly: pong", tools: ["probe_echo"] },
							{ session },
						),
					).rejects.toThrow(
						/Python kernel-defined tools cannot be served while a Python cell is running on Windows/,
					);
				} finally {
					controller.abort(new Error("test: release the parked cell"));
					await cellSettled;
				}
			} finally {
				Object.defineProperty(process, "platform", descriptor);
			}

			// Idle again: the same lookup resolves.
			const idle = await describeEvalTools(session, ["probe_echo"]);
			expect(idle.map(tool => tool.name)).toEqual(["probe_echo"]);
		},
		60_000,
	);
});
