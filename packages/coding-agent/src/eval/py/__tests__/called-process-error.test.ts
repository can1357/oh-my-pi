import { describe, expect, it } from "bun:test";
import { executePythonWithKernel, type PythonKernelExecutor } from "../executor";
import {
	type KernelExecuteOptions,
	type KernelExecuteResult,
	formatKernelProcessErrorEvidence,
	mapKernelErrorFrame,
} from "../kernel";

class CalledProcessErrorKernel implements PythonKernelExecutor {
	constructor(private readonly result: KernelExecuteResult) {}

	async execute(_code: string, _options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		return this.result;
	}
}

describe("CalledProcessError evidence", () => {
	it("maps a structured Colab-style error frame without parsing traceback text", () => {
		const error = mapKernelErrorFrame({
			ename: "CalledProcessError",
			evalue: "Command failed",
			traceback: ["opaque traceback"],
			command: "python train.py",
			returncode: 17,
			stdout: "training progress\n",
			stderr: "CUDA unavailable\n",
		});

		expect(error).toEqual({
			name: "CalledProcessError",
			value: "Command failed",
			traceback: ["opaque traceback"],
			command: "python train.py",
			returncode: 17,
			stdout: "training progress\n",
			stderr: "CUDA unavailable\n",
		});
	});

	it("dumps command, return code, stdout, and stderr into model-visible output", async () => {
		const kernel = new CalledProcessErrorKernel({
			status: "error",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
			error: mapKernelErrorFrame({
				ename: "CalledProcessError",
				evalue: "Command failed",
				traceback: ["opaque traceback"],
				command: "python train.py",
				returncode: 17,
				stdout: "training progress\n",
				stderr: "CUDA unavailable\n",
			}),
		});

		const result = await executePythonWithKernel(kernel, "run_training()", { cwd: process.cwd() });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("command: python train.py");
		expect(result.output).toContain("return code: 17");
		expect(result.output).toContain("stdout:\ntraining progress");
		expect(result.output).toContain("stderr:\nCUDA unavailable");
		expect(result.processError).toEqual({
			command: "python train.py",
			returncode: 17,
			stdout: "training progress\n",
			stderr: "CUDA unavailable\n",
		});
	});

	it("forwards timeout cancellation fields on PythonResult", async () => {
		const kernel = new CalledProcessErrorKernel({
			status: "ok",
			cancelled: true,
			timedOut: true,
			stdinRequested: false,
		});
		const result = await executePythonWithKernel(kernel, "pass", {
			cwd: process.cwd(),
			idleTimeoutMs: 30_000,
		});
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(result.cancellationCause).toBe("idle_watchdog_timeout");
		expect(result.effectiveTimeoutMs).toBe(30_000);
	});

	it("preserves argv list command and space-joins model-visible text", () => {
		const error = mapKernelErrorFrame({
			ename: "CalledProcessError",
			evalue: "Command failed",
			traceback: [],
			command: ["python", "train.py", "--flag"],
			returncode: 9,
			stdout: "",
			stderr: "boom",
		});
		expect(error.command).toEqual(["python", "train.py", "--flag"]);
		expect(formatKernelProcessErrorEvidence(error)).toContain("command: python train.py --flag");
		expect(formatKernelProcessErrorEvidence(error)).not.toContain("[");
	});

	it("omits returncode for TimeoutExpired frames", () => {
		const error = mapKernelErrorFrame({
			ename: "TimeoutExpired",
			evalue: "timed out",
			traceback: [],
			command: ["python", "slow.py"],
			stdout: "partial",
			stderr: "",
		});
		expect(error.command).toEqual(["python", "slow.py"]);
		expect(error.returncode).toBeUndefined();
		expect(formatKernelProcessErrorEvidence(error)).toContain("command: python slow.py");
		expect(formatKernelProcessErrorEvidence(error)).not.toContain("return code:");
	});

});
