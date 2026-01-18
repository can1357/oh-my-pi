import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "./python-executor";
import type { KernelExecuteResult } from "./python-kernel";
import * as pythonKernel from "./python-kernel";

class FakeKernel {
	execute = vi.fn(async () => this.result);
	shutdown = vi.fn(async () => {});
	ping = vi.fn(async () => true);
	alive = true;

	constructor(private readonly result: KernelExecuteResult) {}

	isAlive(): boolean {
		return this.alive;
	}
}

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllKernelSessions();
});

describe("executePython lifecycle", () => {
	it("starts and shuts down per-call kernels", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);

		await executePython("print('hi')", { kernelMode: "per-call", cwd: process.cwd() });

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("reuses session kernels until reset", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "test-session", cwd: process.cwd() });
		await executePython("2 + 2", { kernelMode: "session", sessionId: "test-session", cwd: process.cwd() });

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);
	});

	it("resets session kernels when requested", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "reset-session", cwd: process.cwd() });
		await executePython("2 + 2", {
			kernelMode: "session",
			sessionId: "reset-session",
			reset: true,
			cwd: process.cwd(),
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});

	it("restarts session kernels when they are dead", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "dead-session", cwd: process.cwd() });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(0);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});
});
