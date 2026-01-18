import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "./python-executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "./python-kernel";

class FakeKernel implements PythonKernelExecutor {
	constructor(
		private result: KernelExecuteResult,
		private onExecute: (options?: KernelExecuteOptions) => void = () => {},
	) {}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.onExecute(options);
		return this.result;
	}
}

describe("executePythonWithKernel mapping", () => {
	it("annotates timeout cancellations", async () => {
		const kernel = new FakeKernel({ status: "ok", cancelled: true, timedOut: true, stdinRequested: false });
		const result = await executePythonWithKernel(kernel, "sleep(10)", { timeout: 5000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out after 5 seconds");
	});

	it("maps error status to non-zero exit code", async () => {
		const kernel = new FakeKernel(
			{ status: "error", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("traceback\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "1 / 0");

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("traceback");
		expect(result.stdinRequested).toBe(false);
	});
});
