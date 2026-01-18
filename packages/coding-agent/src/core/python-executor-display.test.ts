import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "./python-executor";
import type { KernelDisplayOutput, KernelExecuteOptions, KernelExecuteResult } from "./python-kernel";

class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => Promise<void> | void;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => Promise<void> | void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}
}

describe("executePythonWithKernel display outputs", () => {
	it("aggregates display outputs in order", async () => {
		const outputs: KernelDisplayOutput[] = [
			{ type: "json", data: { foo: "bar" } },
			{ type: "image", data: "abc", mimeType: "image/png" },
		];

		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			async (options) => {
				if (!options?.onDisplay) return;
				for (const output of outputs) {
					await options.onDisplay(output);
				}
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.exitCode).toBe(0);
		expect(result.displayOutputs).toEqual(outputs);
	});
});
