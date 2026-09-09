import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute?: (options?: KernelExecuteOptions) => void;

	constructor(result: KernelExecuteResult, onExecute?: (options?: KernelExecuteOptions) => void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.onExecute?.(options);
		return this.result;
	}
}

describe("executePythonWithKernel result mapping", () => {
	it("adds timeout annotation when cancelled", async () => {
		const kernel = new FakeKernel({
			status: "ok",
			cancelled: true,
			timedOut: true,
			stdinRequested: false,
		});

		const result = await executePythonWithKernel(kernel, "sleep()", { timeoutMs: 5000 });

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("eval cell timed out after 5s");
	});

	it("maps kernel error status to exit code 1", async () => {
		const kernel = new FakeKernel(
			{ status: "error", cancelled: false, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("Traceback...\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Traceback");
	});
});
