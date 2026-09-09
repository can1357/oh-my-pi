import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { disposeAllKernelSessions, executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";
import { FakeKernel } from "./helpers";

describe("executePythonWithKernel", () => {
	it("captures text and display outputs", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => {
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
			options => {
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
			options => {
				options?.onChunk?.("\u001b[31mred\r\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "print('red')");

		expect(result.output).toBe("red\n");
	});

	it("returns cancelled result with timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: true, stdinRequested: false },
			options => {
				options?.onChunk?.("partial output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass", { timeoutMs: 4100 });

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("eval cell timed out after 4s");
	});

	it("returns cancelled result without timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("cancelled output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass");

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("cancelled output");
		expect(result.output).not.toContain("Command timed out");
	});

	it("truncates large output and stores full output artifact", async () => {
		const lineLength = 100;
		const lineCount = Math.ceil((DEFAULT_MAX_BYTES * 1.5) / lineLength);
		const lines = Array.from(
			{ length: lineCount },
			(_, i) => `line${i.toString().padStart(6, "0")}: ${"x".repeat(lineLength - 15)}`,
		);
		const largeOutput = `${lines.join("\n")}\nTAIL\n`;
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			async options => {
				await options?.onChunk?.(largeOutput);
			},
		);
		using tempDir = TempDir.createSync("@python-executor-artifacts-");
		const artifactPath = path.join(tempDir.path(), "0.python.txt");

		const result = await executePythonWithKernel(kernel, "print('big')", {
			artifactPath,
			artifactId: "0",
		});

		expect(result.truncated).toBe(true);
		expect(result.artifactId).toBe("0");
		expect(result.output).toContain("TAIL");

		const fullText = await Bun.file(artifactPath).text();
		expect(fullText).toBe(largeOutput);
	});
});

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});
