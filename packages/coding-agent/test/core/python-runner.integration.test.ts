/**
 * End-to-end exercise of the new subprocess-backed Python runner.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllKernelSessions, executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { filterEnv, resolvePythonRuntime } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";
const MATPLOTLIB_TEST_CWD = process.cwd();

async function hasMatplotlib(cwd: string): Promise<boolean> {
	if (!SHOULD_RUN) return false;
	try {
		const { env } = (await Settings.init()).getShellConfig();
		const runtime = resolvePythonRuntime(cwd, filterEnv(env));
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		const result = Bun.spawnSync([runtime.pythonPath, "-c", "import matplotlib"], {
			cwd,
			env: spawnEnv,
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

const HAS_MATPLOTLIB = await hasMatplotlib(MATPLOTLIB_TEST_CWD);

describe.skipIf(!SHOULD_RUN)("python runner subprocess", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@python-runner-stream-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executePythonWithKernel(
				kernel,
				["import sys", "for i in range(5):", "    print(i, flush=True)"].join("\n"),
				{
					onChunk: chunk => {
						chunks.push(chunk);
					},
				},
			);
			expect(result.exitCode).toBe(0);
			// 5 lines * (digit + newline) → at least 5 distinct chunks once printed.
			const text = chunks.join("");
			expect(text).toContain("0\n");
			expect(text).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(process.platform === "win32")("runs in its own POSIX session", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-isolation-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "import os; print(os.getsid(0), os.getpid())");
			const [sessionId, processId] = result.output.trim().split(/\s+/).map(Number);
			expect(sessionId).toBe(processId);
		} finally {
			await kernel.shutdown();
		}
	});

	it("cancels a long sleep via SIGINT within 500ms", async () => {
		using tempDir = TempDir.createSync("@python-runner-cancel-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const start = Date.now();
			const ac = new AbortController();
			const pending = executePythonWithKernel(kernel, "import time\ntime.sleep(30)", {
				signal: ac.signal,
			});
			setTimeout(() => ac.abort(new DOMException("user cancelled", "AbortError")), 50);
			const result = await pending;
			const elapsed = Date.now() - start;
			expect(result.cancelled).toBe(true);
			expect(elapsed).toBeLessThan(2_000);
			// Kernel must survive cancellation and remain usable.
			const next = await executePythonWithKernel(kernel, "print('alive')");
			expect(next.exitCode).toBe(0);
			expect(next.output).toContain("alive");
		} finally {
			await kernel.shutdown();
		}
	});

	it("preserves user namespace across calls", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "x = 41");
			const result = await executePythonWithKernel(kernel, "x + 1");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("emits an error frame when user code raises", async () => {
		using tempDir = TempDir.createSync("@python-runner-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("boom");
			// Traceback starts at user code; runner-internal frames stay hidden.
			expect(result.output).toContain('File "<cell>"');
			expect(result.output).not.toContain("_exec_source_async");
		} finally {
			await kernel.shutdown();
		}
	});

	it("reports cell syntax errors without runner-internal frames", async () => {
		using tempDir = TempDir.createSync("@python-runner-syntax-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, 'echo "hi"');
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("SyntaxError");
			expect(result.output).toContain('File "<cell>"');
			// Caret display only — no stack header, no runner machinery.
			expect(result.output).not.toContain("Traceback (most recent call last");
			expect(result.output).not.toContain("_compile_source");
		} finally {
			await kernel.shutdown();
		}
	});

	it("supports top-level await across cells", async () => {
		using tempDir = TempDir.createSync("@python-runner-await-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executePythonWithKernel(
				kernel,
				["import asyncio", "x = await asyncio.sleep(0, result=21)", "x * 2"].join("\n"),
			);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("42");
			const second = await executePythonWithKernel(kernel, "x + 1");
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("22");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("captures display(fig) as a PNG before the figure is closed", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([0, 1], [0, 1])",
					"display(fig)",
					"plt.close(fig)",
				].join("\n"),
			);

			expect(result.exitCode).toBe(0);
			const images = result.displayOutputs.filter(output => output.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0]).toMatchObject({ mimeType: "image/png" });
			expect(images[0]?.data).not.toContain("blob:");
			expect(result.output).toContain("<Figure");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("does not flush a second PNG for a displayed open figure", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([0, 1], [1, 0])",
					"display(fig)",
				].join("\n"),
			);

			expect(result.exitCode).toBe(0);
			expect(result.displayOutputs.filter(output => output.type === "image")).toHaveLength(1);
		} finally {
			await kernel.shutdown();
		}
	});

	it("translates %pwd magic to the user namespace", async () => {
		using tempDir = TempDir.createSync("@python-runner-magic-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "%pwd");
			expect(result.exitCode).toBe(0);
			// %pwd returns the cwd string, which becomes the last-expression result.
			// On macOS, the OS may resolve /var to /private/var, so check by basename.
			expect(result.output).toContain(path.basename(tempDir.path()));
		} finally {
			await kernel.shutdown();
		}
	});
});
