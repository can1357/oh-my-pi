import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "./python-executor";
import * as pythonKernel from "./python-kernel";

class FakeKernel {
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	constructor(private readonly shouldThrow: boolean = false) {}

	isAlive(): boolean {
		return this.alive;
	}

	async execute(): Promise<{ status: "ok"; cancelled: false; timedOut: false; stdinRequested: false }> {
		this.executeCalls += 1;
		if (this.shouldThrow) {
			this.alive = false;
			throw new Error("kernel crashed");
		}
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.alive = false;
	}
}

describe("executePython session lifecycle", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await disposeAllKernelSessions();
	});

	it("restarts session when kernel is not alive", async () => {
		const kernel1 = new FakeKernel();
		kernel1.alive = false;
		const kernel2 = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel1 as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernel2 as unknown as pythonKernel.PythonKernel);

		await executePython("print('hi')", { cwd: "/tmp", sessionId: "session-1", kernelMode: "session" });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.executeCalls).toBe(0);
		expect(kernel1.shutdownCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});

	it("restarts after an execution failure when kernel is dead", async () => {
		const kernel1 = new FakeKernel(true);
		const kernel2 = new FakeKernel();
		const starts = [kernel1, kernel2];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async () => {
			const next = starts.shift();
			if (!next) {
				throw new Error("No kernel available");
			}
			return next as unknown as pythonKernel.PythonKernel;
		});

		await executePython("raise", { cwd: "/tmp", sessionId: "session-2", kernelMode: "session" });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.executeCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});

	it("resets existing session when requested", async () => {
		const kernel1 = new FakeKernel();
		const kernel2 = new FakeKernel();
		const starts = [kernel1, kernel2];
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(pythonKernel.PythonKernel, "start").mockImplementation(async () => {
			const next = starts.shift();
			if (!next) {
				throw new Error("No kernel available");
			}
			return next as unknown as pythonKernel.PythonKernel;
		});

		await executePython("print('one')", { cwd: "/tmp", sessionId: "session-3", kernelMode: "session" });
		await executePython("print('two')", {
			cwd: "/tmp",
			sessionId: "session-3",
			kernelMode: "session",
			reset: true,
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel1.shutdownCalls).toBe(1);
		expect(kernel2.executeCalls).toBe(1);
	});
});
