import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePython } from "./python-executor";
import { type KernelExecuteOptions, type KernelExecuteResult, PythonKernel } from "./python-kernel";

process.env.OMP_PYTHON_SKIP_CHECK = "1";

class FakeKernel {
	private result: KernelExecuteResult;
	private onExecute?: (options?: KernelExecuteOptions) => void;
	private alive: boolean;
	readonly executeCalls: string[] = [];
	shutdownCalls = 0;

	constructor(
		result: KernelExecuteResult,
		options: { alive?: boolean; onExecute?: (options?: KernelExecuteOptions) => void } = {},
	) {
		this.result = result;
		this.onExecute = options.onExecute;
		this.alive = options.alive ?? true;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		this.onExecute?.(options);
		return this.result;
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.alive = false;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}
}

const okResult: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

describe("executePython session lifecycle", () => {
	const originalStart = PythonKernel.start;

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses a session kernel across calls", async () => {
		let startCount = 0;
		const kernel = new FakeKernel(okResult, { onExecute: (options) => options?.onChunk?.("ok\n") });
		PythonKernel.start = async () => {
			startCount += 1;
			return kernel as unknown as PythonKernel;
		};

		const first = await executePython("print('one')", { sessionId: "session-1" });
		const second = await executePython("print('two')", { sessionId: "session-1" });

		expect(startCount).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')", "print('two')"]);
		expect(first.output).toContain("ok");
		expect(second.output).toContain("ok");
	});

	it("restarts the session kernel when not alive", async () => {
		const deadKernel = new FakeKernel(okResult, { alive: false });
		const liveKernel = new FakeKernel(okResult, { onExecute: (options) => options?.onChunk?.("live\n") });
		const kernels = [deadKernel, liveKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		const result = await executePython("print('restart')", { sessionId: "session-restart" });

		expect(startCount).toBe(2);
		expect(deadKernel.shutdownCalls).toBe(1);
		expect(deadKernel.executeCalls).toEqual([]);
		expect(liveKernel.executeCalls).toEqual(["print('restart')"]);
		expect(result.output).toContain("live");
	});

	it("resets the session kernel when requested", async () => {
		const firstKernel = new FakeKernel(okResult);
		const secondKernel = new FakeKernel(okResult);
		const kernels = [firstKernel, secondKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('one')", { sessionId: "session-reset" });
		await executePython("print('two')", { sessionId: "session-reset", reset: true });

		expect(startCount).toBe(2);
		expect(firstKernel.shutdownCalls).toBe(1);
		expect(secondKernel.executeCalls).toEqual(["print('two')"]);
	});

	it("uses per-call kernels when configured", async () => {
		const kernelA = new FakeKernel(okResult);
		const kernelB = new FakeKernel(okResult);
		const kernels = [kernelA, kernelB];
		let startCount = 0;
		let shutdownCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		kernelA.shutdown = async () => {
			shutdownCount += 1;
		};
		kernelB.shutdown = async () => {
			shutdownCount += 1;
		};

		await executePython("print('one')", { kernelMode: "per-call" });
		await executePython("print('two')", { kernelMode: "per-call" });

		expect(startCount).toBe(2);
		expect(shutdownCount).toBe(2);
	});
});
