import { afterEach, describe, expect, it } from "bun:test";
import { executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

interface KernelStub {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
	shutdown: () => Promise<void>;
}

type KernelStartOptions = Parameters<typeof PythonKernel.start>[0];

const originalDateNow = Date.now;

const originalStart = PythonKernel.start;

function createCancellationError(name: "AbortError" | "TimeoutError", message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function rejectOnStartupCancellation(options: KernelStartOptions): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	const finish = (error: unknown) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
		reject(error);
	};
	const onAbort = () => {
		finish(options.signal?.reason ?? createCancellationError("AbortError", "Python kernel startup aborted"));
	};

	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.deadlineMs !== undefined) {
		const remainingMs = Math.max(0, options.deadlineMs - Date.now());
		timeout = setTimeout(() => {
			finish(createCancellationError("TimeoutError", "Python kernel startup timed out"));
		}, remainingMs);
		timeout.unref();
	}

	return promise;
}

describe("executePython (per-call)", () => {
	afterEach(() => {
		PythonKernel.start = originalStart;
		Date.now = originalDateNow;
	});

	it("returns a cancelled timeout result when kernel startup exceeds the deadline", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@omp-python-executor-per-call-");

		PythonKernel.start = async options => await rejectOnStartupCancellation(options);

		const result = await executePython("sleep(10)", {
			kernelMode: "per-call",
			timeoutMs: 25,
			cwd: tempDir.path(),
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});

	it("returns a cancelled timeout result when the startup budget expires before kernel creation", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@omp-python-executor-per-call-");

		let nowCalls = 0;
		Date.now = () => {
			nowCalls += 1;
			return nowCalls <= 2 ? 1_000 : 2_000;
		};

		const result = await executePython("sleep(10)", {
			kernelMode: "per-call",
			timeoutMs: 10,
			cwd: tempDir.path(),
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});

	it("returns a cancelled result when caller aborts during kernel startup", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@omp-python-executor-per-call-");
		const startupStarted = Promise.withResolvers<void>();

		PythonKernel.start = async options => {
			startupStarted.resolve();
			return await rejectOnStartupCancellation(options);
		};

		const abortController = new AbortController();
		const resultPromise = executePython("sleep(10)", {
			kernelMode: "per-call",
			signal: abortController.signal,
			cwd: tempDir.path(),
		});
		await startupStarted.promise;
		abortController.abort(createCancellationError("AbortError", "caller aborted"));

		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toBe("");
	});

	it("shuts down kernel on timed-out cancellation", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@omp-python-executor-per-call-");

		let shutdownCalls = 0;
		const executionStarted = Promise.withResolvers<void>();
		const abortController = new AbortController();
		const kernel: KernelStub = {
			execute: async (_code: string, options?: KernelExecuteOptions) => {
				executionStarted.resolve();
				const signal = options?.signal;
				if (!signal) {
					return {
						status: "ok",
						cancelled: false,
						timedOut: false,
						stdinRequested: false,
					};
				}
				if (!signal.aborted) {
					const cancellation = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => cancellation.resolve(), { once: true });
					await cancellation.promise;
				}
				return {
					status: "ok",
					cancelled: true,
					timedOut: true,
					stdinRequested: false,
				};
			},
			shutdown: async () => {
				shutdownCalls += 1;
			},
		};

		PythonKernel.start = async () => kernel as unknown as PythonKernel;

		const resultPromise = executePython("sleep(10)", {
			kernelMode: "per-call",
			timeoutMs: 2000,
			signal: abortController.signal,
			cwd: tempDir.path(),
		});
		await executionStarted.promise;
		abortController.abort(createCancellationError("TimeoutError", "execution deadline elapsed"));

		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("eval cell timed out after");
		expect(shutdownCalls).toBe(1);
	});
});
