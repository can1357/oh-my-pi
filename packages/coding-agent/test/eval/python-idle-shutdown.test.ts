import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const IDLE_MS = 20;

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

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached before timeout");
		await Bun.sleep(5);
	}
}

async function runRetainedCell(kernel: FakeKernel, registry: AgentRegistry): Promise<void> {
	const cwd = path.resolve("/tmp/python-idle-shutdown");
	vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
	vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);
	await executePython("x = 1", {
		cwd,
		sessionId: "python:python-idle",
		kernelMode: "session",
		kernelIdleShutdownMs: IDLE_MS,
		toolSession: toolSession(cwd, registry),
		bridge: { url: "http://127.0.0.1:1", token: "test" },
	});
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

		await waitUntil(() => kernel.describeCalls >= 2);
		expect(kernel.alive).toBe(true);
		kernel.tools = [];
		await waitUntil(() => !kernel.alive);
	});

	it("keeps a kernel whose @tool probe times out, and reaps it after a clean probe", async () => {
		const kernel = new FakeKernel("py-probe-timeout");
		kernel.timedOutProbes = 1;
		await runRetainedCell(kernel, new AgentRegistry());

		await waitUntil(() => kernel.describeCalls >= 1);
		expect(kernel.alive).toBe(true);
		await waitUntil(() => !kernel.alive);
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
		await waitUntil(() => !kernel.alive);
	});
});
