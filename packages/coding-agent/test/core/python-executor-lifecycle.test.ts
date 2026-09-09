import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { getProjectDir } from "@oh-my-pi/pi-utils";

class FakeKernel {
	execute = vi.fn(async () => this.result);
	shutdown = vi.fn(async () => {
		return { confirmed: true };
	});
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

		await executePython("print('hi')", { kernelMode: "per-call", cwd: getProjectDir() });

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

		await executePython("1 + 1", { kernelMode: "session", sessionId: "test-session", cwd: getProjectDir() });
		await executePython("2 + 2", { kernelMode: "session", sessionId: "test-session", cwd: getProjectDir() });

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

		await executePython("1 + 1", { kernelMode: "session", sessionId: "reset-session", cwd: getProjectDir() });
		await executePython("2 + 2", {
			kernelMode: "session",
			sessionId: "reset-session",
			reset: true,
			cwd: getProjectDir(),
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

		await executePython("1 + 1", { kernelMode: "session", sessionId: "dead-session", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(0);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});

	it("reports uncertain completion after a kernel crash and restarts for the next cell", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		kernel.execute.mockImplementation(async () => {
			kernel.alive = false;
			throw new Error("kernel crashed");
		});
		const kernelNext = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		const options = { kernelMode: "session" as const, sessionId: "crash-session", cwd: getProjectDir() };
		await expect(executePython("1 + 1", options)).rejects.toThrow("completion is uncertain");
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernelNext.execute).not.toHaveBeenCalled();
		const next = await executePython("2 + 2", options);
		expect(next.exitCode).toBe(0);

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.execute).toHaveBeenCalledTimes(1);
		expect(kernelNext.execute).toHaveBeenCalledTimes(1);
	});

	it("restarts dead retained sessions even when shutdown confirmation is missing", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const kernelNext = new FakeKernel(OK_RESULT);
		kernel.alive = false;
		kernel.shutdown.mockResolvedValueOnce({ confirmed: false });
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernel as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelNext as unknown as pythonKernel.PythonKernel);

		await executePython("1 + 1", { kernelMode: "session", sessionId: "retry-dead-session", cwd: getProjectDir() });
		await executePython("2 + 2", { kernelMode: "session", sessionId: "retry-dead-session", cwd: getProjectDir() });

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(0);
		expect(kernelNext.execute).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent reset requests instead of throwing 'reset already in progress'", async () => {
		// Two cells from the same session asking for reset in flight at once
		// previously crashed the second one with "Python kernel reset already
		// in progress" — the user reported this as eval returning only the
		// status line and no executed output. The executor now waits for the
		// in-flight reset and then proceeds.
		const kernelA = new FakeKernel(OK_RESULT);
		const kernelB = new FakeKernel(OK_RESULT);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(kernelA as unknown as pythonKernel.PythonKernel)
			.mockResolvedValueOnce(kernelB as unknown as pythonKernel.PythonKernel);
		// Seed a live session that both reset cells will tear down.
		await executePython("1 + 1", { kernelMode: "session", sessionId: "coalesce", cwd: getProjectDir() });

		const [r1, r2] = await Promise.all([
			executePython("2 + 2", { kernelMode: "session", sessionId: "coalesce", reset: true, cwd: getProjectDir() }),
			executePython("3 + 3", { kernelMode: "session", sessionId: "coalesce", reset: true, cwd: getProjectDir() }),
		]);
		expect(r1.exitCode).toBe(0);
		expect(r2.exitCode).toBe(0);
	});
});
