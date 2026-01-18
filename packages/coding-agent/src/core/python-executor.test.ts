import { afterEach, describe, expect, it, vi } from "bun:test";
import { rmSync } from "node:fs";
import {
	disposeAllKernelSessions,
	executePythonWithKernel,
	getPreludeDocs,
	type PythonKernelExecutor,
	warmPythonEnvironment,
} from "./python-executor";
import { type KernelExecuteOptions, type KernelExecuteResult, type PreludeHelper, PythonKernel } from "./python-kernel";
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

describe("executePythonWithKernel", () => {
	it("captures text and display outputs", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("hello\n");
				options?.onDisplay?.({ type: "json", data: { foo: "bar" } });
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hello')");

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("hello");
		expect(result.displayOutputs).toHaveLength(1);
	});

	it("marks stdin request as error", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: true },
			() => {},
		);

		const result = await executePythonWithKernel(kernel, "input('prompt')");

		expect(result.exitCode).toBe(1);
		expect(result.stdinRequested).toBe(true);
		expect(result.output).toContain("Kernel requested stdin; interactive input is not supported.");
	});

	it("maps error status to exit code 1", async () => {
		const kernel = new FakeKernel(
			{ status: "error", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("Traceback\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "raise ValueError('nope')");

		expect(result.exitCode).toBe(1);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("Traceback");
	});

	it("sanitizes streamed chunks", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("\u001b[31mred\r\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "print('red')");

		expect(result.output).toBe("red\n");
	});

	it("returns cancelled result with timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: true, stdinRequested: false },
			(options) => {
				options?.onChunk?.("partial output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass", { timeout: 4100 });

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command timed out after 4 seconds");
	});

	it("returns cancelled result without timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.("cancelled output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass");

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("cancelled output");
		expect(result.output).not.toContain("Command timed out");
	});

	it("truncates large output and stores full output file", async () => {
		const largeOutput = `${"x".repeat(DEFAULT_MAX_BYTES + 1024)}TAIL`;
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			(options) => {
				options?.onChunk?.(largeOutput);
			},
		);

		const result = await executePythonWithKernel(kernel, "print('big')");

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.output).toContain("TAIL");

		const fullText = await Bun.file(result.fullOutputPath as string).text();
		expect(fullText).toBe(largeOutput);

		rmSync(result.fullOutputPath as string, { force: true });
	});
});

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("warmPythonEnvironment", () => {
	it("caches prelude docs on warmup", async () => {
		const previousSkip = process.env.OMP_PYTHON_SKIP_CHECK;
		process.env.OMP_PYTHON_SKIP_CHECK = "1";
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			ping: vi.fn().mockResolvedValue(true),
			isAlive: () => true,
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernel);

		const result = await warmPythonEnvironment("/tmp/test", "session-1");

		expect(result.ok).toBe(true);
		expect(result.docs).toEqual(docs);
		expect(getPreludeDocs()).toEqual(docs);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		startSpy.mockRestore();
		if (previousSkip === undefined) {
			delete process.env.OMP_PYTHON_SKIP_CHECK;
		} else {
			process.env.OMP_PYTHON_SKIP_CHECK = previousSkip;
		}
	});
});
