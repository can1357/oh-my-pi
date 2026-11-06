import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pythonKernelIdleShutdownPolicy } from "@oh-my-pi/pi-coding-agent/eval/py/index";
import {
	describePythonTools,
	disposeAllKernelSessions,
	executePython,
	type PythonExecutorOptions,
	shadowPlanPythonIfPresent,
	snapshotPythonNamespaceIfPresent,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
	PythonShadowPlan,
	PythonShadowSnapshot,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { cfgPythonKernelIdleShutdownSeconds } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { EvalShadowCellSession } from "@oh-my-pi/pi-coding-agent/eval/speculation/cell-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { gateShutdown } from "../helpers/kernel-shutdown-gate";
import { rejectionWithin } from "../helpers/rejection";
import { waitFor } from "../helpers/wait-for";

const IDLE_MS = 20;
// Under the 5s test timeout, so a missed wait fails with its message.
const WAIT_MS = 2_000;
const CWD = path.resolve("/tmp/python-idle-shutdown");
const SESSION_ID = "python:python-idle";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	readonly pythonPath = "/managed/bin/python";
	readonly #death = Promise.withResolvers<void>();
	alive = true;
	tools: Array<{ name: string }> = [];
	timedOutProbes = 0;
	describeCalls = 0;
	execute = vi.fn(async () => OK_RESULT);
	snapshotUserNamespace = vi.fn(async (): Promise<PythonShadowSnapshot | null> => null);
	shadowPlan = vi.fn(async (): Promise<PythonShadowPlan | null> => null);
	shutdown = vi.fn(async (): Promise<KernelShutdownResult> => {
		this.alive = false;
		this.#death.resolve();
		return { confirmed: true };
	});

	constructor(readonly id: string) {}

	isAlive(): boolean {
		return this.alive;
	}

	whenDead(): Promise<void> {
		return this.#death.promise;
	}

	async invokeTool(): Promise<KernelExecuteResult> {
		this.describeCalls += 1;
		if (this.timedOutProbes > 0) {
			this.timedOutProbes -= 1;
			return { ...OK_RESULT, cancelled: true, timedOut: true };
		}
		return { ...OK_RESULT, reply: { ok: true, tools: this.tools, missing: [] } };
	}
}

function toolSession(cwd: string, agentRegistry: AgentRegistry): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getEvalSessionId: () => "python-idle",
		getEvalKernelOwnerId: () => null,
		getAgentId: () => "Main",
		agentRegistry,
	} as unknown as ToolSession;
}

function cellOptions(registry: AgentRegistry, signal?: AbortSignal): PythonExecutorOptions {
	return {
		cwd: CWD,
		sessionId: SESSION_ID,
		kernelMode: "session",
		kernelIdleShutdownMs: IDLE_MS,
		toolSession: toolSession(CWD, registry),
		bridge: { url: "http://127.0.0.1:1", token: "test" },
		signal,
	};
}

async function runRetainedCell(
	kernel: FakeKernel,
	registry: AgentRegistry,
	overrides: Partial<PythonExecutorOptions> = {},
): Promise<void> {
	vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
	vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);
	await executePython("x = 1", { ...cellOptions(registry), ...overrides });
}

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("python idle kernel shutdown guard", () => {
	it("keeps @tool kernels without repeated probes until activity can change their tools", async () => {
		const kernel = new FakeKernel("py-tools");
		const registry = new AgentRegistry();
		kernel.tools = [{ name: "lookup" }];
		await runRetainedCell(kernel, registry);

		await waitFor(() => kernel.describeCalls >= 1, "the @tool probe did not run", WAIT_MS);
		await Bun.sleep(IDLE_MS * 5);
		expect(kernel.describeCalls).toBe(1);
		expect(kernel.alive).toBe(true);
		kernel.tools = [];
		await executePython("del lookup", cellOptions(registry));
		await waitFor(() => !kernel.alive, "the idle kernel was not shut down", WAIT_MS);
	});

	it("follows python.kernelIdleShutdownSeconds changes made after the cell ran", async () => {
		// Isolated overrides outrank later writes, so the initial value is written rather than seeded.
		const settings = Settings.isolated();
		cfgPythonKernelIdleShutdownSeconds.set(settings, 0.2);
		const kernel = new FakeKernel("py-setting-change");
		await runRetainedCell(kernel, new AgentRegistry(), {
			kernelIdleShutdownMs: pythonKernelIdleShutdownPolicy(settings),
		});
		cfgPythonKernelIdleShutdownSeconds.set(settings, 0);
		await Bun.sleep(400);
		expect(kernel.alive).toBe(true);
		cfgPythonKernelIdleShutdownSeconds.set(settings, IDLE_MS / 1000);
		await waitFor(() => !kernel.alive, "the kernel ignored the re-enabled idle shutdown", WAIT_MS);
	});

	it("honors an extended idle window when the previous shutdown probe is still pending", async () => {
		const settings = Settings.isolated();
		cfgPythonKernelIdleShutdownSeconds.set(settings, IDLE_MS / 1000);
		const kernel = new FakeKernel("py-extended-idle-window");
		const probeStarted = Promise.withResolvers<void>();
		const finishProbe = Promise.withResolvers<void>();
		const invokeTool = kernel.invokeTool.bind(kernel);
		vi.spyOn(kernel, "invokeTool").mockImplementationOnce(async () => {
			probeStarted.resolve();
			await finishProbe.promise;
			return await invokeTool();
		});
		try {
			await runRetainedCell(kernel, new AgentRegistry(), {
				kernelIdleShutdownMs: pythonKernelIdleShutdownPolicy(settings),
			});
			await probeStarted.promise;
			const extendedAt = performance.now();
			cfgPythonKernelIdleShutdownSeconds.set(settings, 1);
			finishProbe.resolve();
			await Bun.sleep(IDLE_MS * 2);
			expect(kernel.alive).toBe(true);
			await waitFor(() => !kernel.alive, "the kernel ignored the extended idle shutdown", WAIT_MS);
			expect(performance.now() - extendedAt).toBeGreaterThanOrEqual(1_000);
			expect(kernel.describeCalls).toBe(2);
		} finally {
			finishProbe.resolve();
		}
	});

	it("keeps a kernel whose @tool probe times out, and reaps it after a clean probe", async () => {
		const kernel = new FakeKernel("py-probe-timeout");
		kernel.timedOutProbes = 1;
		await runRetainedCell(kernel, new AgentRegistry());

		await waitFor(() => kernel.describeCalls >= 1, "the @tool probe did not run", WAIT_MS);
		expect(kernel.alive).toBe(true);
		await waitFor(() => !kernel.alive, "the idle kernel was not shut down", WAIT_MS);
		expect(kernel.describeCalls).toBe(2);
	});

	it("keeps a kernel while its owning agent has a running subagent", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "Main.worker",
			displayName: "worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const kernel = new FakeKernel("py-subagent");
		await runRetainedCell(kernel, registry);

		await Bun.sleep(IDLE_MS * 5);
		expect(kernel.alive).toBe(true);
		registry.setStatus("Main.worker", "idle");
		await waitFor(() => !kernel.alive, "the idle kernel was not shut down", WAIT_MS);
	});

	it("reaps a replacement kernel whose only caller stopped waiting before it started", async () => {
		const registry = new AgentRegistry();
		const dead = new FakeKernel("py-dead");
		await runRetainedCell(dead, registry);
		dead.alive = false;
		const replacement = new FakeKernel("py-replacement");
		const started = Promise.withResolvers<void>();
		const startGate = Promise.withResolvers<void>();
		vi.spyOn(PythonKernel, "start").mockImplementation(async () => {
			started.resolve();
			await startGate.promise;
			return replacement as unknown as PythonKernelInstance;
		});
		const controller = new AbortController();
		try {
			const aborted = executePython("y = 2", cellOptions(registry, controller.signal));
			await started.promise;
			controller.abort();
			expect((await aborted).cancelled).toBe(true);
			startGate.resolve();
			await waitFor(() => !replacement.alive, "replacement kernel was not shut down", WAIT_MS);
			expect(replacement.execute).not.toHaveBeenCalled();
		} finally {
			startGate.resolve();
		}
	});

	it("rejects tool requests during an idle shutdown without waiting or keeping the next kernel", async () => {
		const registry = new AgentRegistry();
		const first = new FakeKernel("py-reaping");
		const shutdown = gateShutdown(first);
		try {
			await runRetainedCell(first, registry);
			await shutdown.started;
			const describing = describePythonTools(["lookup"], {
				cwd: CWD,
				sessionId: SESSION_ID,
				toolSession: toolSession(CWD, registry),
			});
			expect(await rejectionWithin(describing, 500)).toHaveProperty("name", "EvalKernelNotRunningError");
			shutdown.finish();
			const next = new FakeKernel("py-after-reap");
			await runRetainedCell(next, registry);
			await waitFor(() => !next.alive, "next kernel was not shut down", WAIT_MS);
		} finally {
			shutdown.finish();
		}
	});

	it("invalidates a streamed plan when the configured interpreter's namespace changes", async () => {
		const registry = new AgentRegistry();
		const kernel = new FakeKernel("py-streamed-interpreter");
		const session: ToolSession = {
			...toolSession(CWD, registry),
			settings: Settings.isolated({ "python.interpreter": kernel.pythonPath }),
		};
		let snapshot = { revision: 1, digest: "before", values: { x: 1 } };
		kernel.shadowPlan.mockImplementation(async () => ({ snapshot, operations: [] }));
		kernel.snapshotUserNamespace.mockImplementation(async () => snapshot);
		await runRetainedCell(kernel, registry, {
			interpreter: kernel.pythonPath,
			kernelIdleShutdownMs: 0,
			toolSession: session,
		});
		const shadow = new EvalShadowCellSession({
			coordinator: { maxInFlight: 1, admit: async () => undefined, close() {} },
			parentToolCallId: "eval-interpreter",
			session,
			cwd: CWD,
			sessionId: "python-idle",
		});
		try {
			const args = { language: "py", code: "x" };
			await shadow.update(
				{ type: "toolCall", id: "eval-interpreter", name: "eval", arguments: args },
				JSON.stringify(args),
			);
			await shadow.finalize({ args });
			expect(await shadow.verifySnapshotCurrent()).toBe(true);
			snapshot = { revision: 2, digest: "after", values: { x: 2 } };
			expect(await shadow.verifySnapshotCurrent()).toBe(false);
		} finally {
			await shadow.discard("test complete");
		}
	});

	for (const operation of ["snapshot", "plan"] as const) {
		it(`returns no ${operation} immediately while an idle shutdown is pending`, async () => {
			const registry = new AgentRegistry();
			const kernel = new FakeKernel(`py-reaping-${operation}`);
			const shutdown = gateShutdown(kernel);
			try {
				await runRetainedCell(kernel, registry);
				await shutdown.started;
				const options = { cwd: CWD, sessionId: SESSION_ID, code: "x", timeoutMs: 1 };
				let settled = false;
				const result = (
					operation === "snapshot" ? snapshotPythonNamespaceIfPresent(options) : shadowPlanPythonIfPresent(options)
				).then(value => {
					settled = true;
					return value;
				});
				await waitFor(() => settled, `${operation} waited for the idle shutdown`, 500);
				expect(await result).toBeNull();
				expect(kernel.snapshotUserNamespace).not.toHaveBeenCalled();
				expect(kernel.shadowPlan).not.toHaveBeenCalled();
			} finally {
				shutdown.finish();
			}
		});

		it(`holds the explicit-interpreter kernel during a speculative ${operation}`, async () => {
			const registry = new AgentRegistry();
			const kernel = new FakeKernel(`py-held-${operation}`);
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const snapshot = { revision: 1, digest: "held", values: { x: 1 } };
			kernel.snapshotUserNamespace.mockImplementation(async () => {
				entered.resolve();
				await finish.promise;
				return snapshot;
			});
			kernel.shadowPlan.mockImplementation(async () => {
				entered.resolve();
				await finish.promise;
				return { snapshot, operations: [] };
			});
			try {
				await runRetainedCell(kernel, registry, { interpreter: kernel.pythonPath });
				const options = { cwd: CWD, sessionId: SESSION_ID, interpreter: kernel.pythonPath, code: "x" };
				const result =
					operation === "snapshot"
						? snapshotPythonNamespaceIfPresent(options)
						: shadowPlanPythonIfPresent(options);
				let started = false;
				void entered.promise.then(() => {
					started = true;
				});
				await waitFor(() => started, `${operation} did not use the configured interpreter`, 500);
				await Bun.sleep(IDLE_MS * 5);
				expect(kernel.alive).toBe(true);
				finish.resolve();
				expect(await result).not.toBeNull();
				await waitFor(() => !kernel.alive, "the released kernel was not shut down", WAIT_MS);
			} finally {
				finish.resolve();
			}
		});
	}
});
