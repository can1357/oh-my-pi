import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	describePythonTools,
	disposeAllKernelSessions,
	executePython,
	type PythonExecutorOptions,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
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

async function runRetainedCell(kernel: FakeKernel, registry: AgentRegistry): Promise<void> {
	vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
	vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);
	await executePython("x = 1", cellOptions(registry));
}

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("python idle kernel shutdown guard", () => {
	it("keeps a kernel whose @tool tools subagents may call, and reaps it once they are gone", async () => {
		const kernel = new FakeKernel("py-tools");
		kernel.tools = [{ name: "lookup" }];
		await runRetainedCell(kernel, new AgentRegistry());

		await waitFor(() => kernel.describeCalls >= 2, "the @tool probe did not run twice", WAIT_MS);
		expect(kernel.alive).toBe(true);
		kernel.tools = [];
		await waitFor(() => !kernel.alive, "the idle kernel was not shut down", WAIT_MS);
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

	it("lets a cancelled tool request stop waiting for an idle shutdown without keeping the next kernel", async () => {
		const registry = new AgentRegistry();
		const first = new FakeKernel("py-reaping");
		const shutdown = gateShutdown(first);
		try {
			await runRetainedCell(first, registry);
			await shutdown.started;
			const controller = new AbortController();
			const describing = describePythonTools(["lookup"], {
				cwd: CWD,
				sessionId: SESSION_ID,
				toolSession: toolSession(CWD, registry),
				signal: controller.signal,
			});
			controller.abort();
			expect(await rejectionWithin(describing, 500)).toHaveProperty("name", "PythonExecutionCancelledError");
			shutdown.finish();
			const next = new FakeKernel("py-after-reap");
			await runRetainedCell(next, registry);
			await waitFor(() => !next.alive, "next kernel was not shut down", WAIT_MS);
		} finally {
			shutdown.finish();
		}
	});
});
