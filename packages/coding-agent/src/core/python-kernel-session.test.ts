import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePython } from "./python-executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "./python-kernel";
import { PythonKernel } from "./python-kernel";

class FakeKernel {
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls += 1;
		options?.onChunk?.("ok\n");
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.alive = false;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}
}

describe("executePython kernel reuse", () => {
	const originalStart = PythonKernel.start;
	let startCalls = 0;
	let kernels: FakeKernel[] = [];

	beforeEach(() => {
		process.env.OMP_PYTHON_SKIP_CHECK = "1";
		startCalls = 0;
		kernels = [];
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernels.push(kernel);
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;
	});

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses kernels for session mode", async () => {
		await executePython("print('one')", { cwd: "/tmp", sessionId: "session-a", kernelMode: "session" });
		await executePython("print('two')", { cwd: "/tmp", sessionId: "session-a", kernelMode: "session" });

		expect(startCalls).toBe(1);
		expect(kernels[0]?.executeCalls).toBe(2);
	});

	it("creates and disposes per-call kernels", async () => {
		await executePython("print('one')", { cwd: "/tmp", kernelMode: "per-call" });
		await executePython("print('two')", { cwd: "/tmp", kernelMode: "per-call" });

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
		expect(kernels[1]?.shutdownCalls).toBe(1);
	});

	it("resets the session kernel when requested", async () => {
		await executePython("print('one')", { cwd: "/tmp", sessionId: "session-b", kernelMode: "session" });
		await executePython("print('two')", {
			cwd: "/tmp",
			sessionId: "session-b",
			kernelMode: "session",
			reset: true,
		});

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
	});
});
