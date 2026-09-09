import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => void;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.onExecute(options);
		return this.result;
	}
}

describe("executePythonWithKernel cancellation", () => {
	it("annotates timeouts when cancelled", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: true, stdinRequested: false },
			options => {
				options?.onChunk?.("tick\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "sleep(10)", { timeoutMs: 5000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("eval cell timed out after 5s");
	});
});
