import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { getProjectDir, TempDir } from "@oh-my-pi/pi-utils";

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

/**
 * An error whose name says "AbortError" or "TimeoutError" is not a cancellation
 * unless something asked for one: the caller's signal, or the caller's
 * deadline. Each of these errors comes from inside the kernel path with no
 * signal and no deadline, so it must reach the caller with its text, never as
 * an empty `{ cancelled: true }`.
 */
describe("executePython reports a failure nobody cancelled as a failure", () => {
	const named = (name: "AbortError" | "TimeoutError", message: string): Error =>
		Object.assign(new Error(message), { name });

	it("a kernel whose process exits during startup reports its exit code and stderr, not a cancellation", async () => {
		using tempDir = TempDir.createSync("@python-kernel-dies-at-start-");
		// A real kernel process, on an interpreter that fails the way a broken
		// version-manager shim does: a message on stderr, then a non-zero exit.
		// It exits at once: the diagnosis must come from observing the exit, not
		// from a sleep long enough to make the observation likely.
		const interpreter = path.join(tempDir.path(), "python");
		await Bun.write(interpreter, "#!/bin/sh\necho 'shim: python 3.12.4 is not installed' >&2\nexit 3\n");
		await fs.chmod(interpreter, 0o755);
		const run = executePython("1 + 1", { kernelMode: "per-call", interpreter, cwd: tempDir.path() });
		await expect(run).rejects.toThrow("Python kernel exited with code 3");
		await expect(run).rejects.toThrow("shim: python 3.12.4 is not installed");
	});

	it("a kernel whose process exits during startup saying nothing still reports its exit code", async () => {
		using tempDir = TempDir.createSync("@python-kernel-dies-silently-at-start-");
		// Nothing on stderr, so the exit code is the only thing that explains the
		// failure: a diagnosis built from the stderr drain alone has no reason at all.
		const interpreter = path.join(tempDir.path(), "python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 23\n");
		await fs.chmod(interpreter, 0o755);
		const run = executePython("1 + 1", { kernelMode: "per-call", interpreter, cwd: tempDir.path() });
		await expect(run).rejects.toThrow("Python kernel exited with code 23");
	});

	for (const name of ["AbortError", "TimeoutError"] as const) {
		it(`a kernel start that fails with an unrequested ${name} rejects with its text`, async () => {
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			// The kernel's own startup budget (not the caller's) ran out.
			vi.spyOn(pythonKernel.PythonKernel, "start").mockRejectedValue(named(name, "Python kernel init timed out"));
			const options = { kernelMode: "session" as const, sessionId: `start-${name}`, cwd: getProjectDir() };
			await expect(executePython("1 + 1", options)).rejects.toThrow("Python kernel init timed out");
		});

		it(`a cell that fails with an unrequested ${name} rejects with its text`, async () => {
			const kernel = new FakeKernel(OK_RESULT);
			kernel.execute.mockRejectedValue(named(name, "kernel transport request aborted"));
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);
			const options = { kernelMode: "session" as const, sessionId: `execute-${name}`, cwd: getProjectDir() };
			await expect(executePython("1 + 1", options)).rejects.toThrow("kernel transport request aborted");
		});
	}

	it("a cell the caller cancels still reports as cancelled", async () => {
		const controller = new AbortController();
		const kernel = new FakeKernel(OK_RESULT);
		kernel.execute.mockImplementation(async () => {
			controller.abort();
			throw named("AbortError", "the caller cancelled");
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as pythonKernel.PythonKernel);
		const result = await executePython("1 + 1", {
			kernelMode: "session",
			sessionId: "caller-cancel",
			cwd: getProjectDir(),
			signal: controller.signal,
		});
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});
});
