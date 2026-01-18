import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { executePythonWithKernel, type PythonKernelExecutor } from "./python-executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "./python-kernel";
import { DEFAULT_MAX_BYTES } from "./tools/truncate";

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

const cleanupPaths: string[] = [];

afterEach(() => {
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			try {
				rmSync(path, { force: true });
			} catch {}
		}
	}
});

describe("executePythonWithKernel streaming", () => {
	it("truncates large output and writes full output file", async () => {
		const largeOutput = "a".repeat(DEFAULT_MAX_BYTES + 128);
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.(largeOutput);
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.output.length).toBeLessThan(largeOutput.length);
		if (result.fullOutputPath) {
			cleanupPaths.push(result.fullOutputPath);
		}
	});

	it("annotates timed out runs", async () => {
		const kernel = new FakeKernel({ status: "ok", cancelled: true, timedOut: true, stdinRequested: false }, () => {});

		const result = await executePythonWithKernel(kernel, "sleep", { timeout: 2000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out after 2 seconds");
	});

	it("sanitizes ANSI and carriage returns", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("\u001b[31mhello\r\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hello')");

		expect(result.output).toBe("hello\n");
	});
});
