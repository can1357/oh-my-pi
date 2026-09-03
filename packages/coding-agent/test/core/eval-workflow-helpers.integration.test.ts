/**
 * End-to-end exercise of the Python eval workflow helpers: parallel, pipeline,
 * and log/phase status events.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { disposeAllKernelSessions, executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("python eval workflow helpers", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("parallel preserves input order", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-order-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "print(parallel([lambda: 1, lambda: 2, lambda: 3]))");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("[1, 2, 3]");
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel and pipeline results may be awaited without repeating work", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-awaitable-results-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"calls = []",
				"def mark(value):",
				"    calls.append(value)",
				"    return value",
				"sync_parallel = parallel([lambda: mark('sync')])",
				"awaited_parallel = await parallel([lambda: mark('awaited')])",
				"sync_pipeline = pipeline([1], lambda value: value + 1)",
				"awaited_pipeline = await pipeline([1], lambda value: value + 2)",
				"empty_parallel = await parallel([])",
				"empty_pipeline = await pipeline([])",
				"print(sync_parallel, awaited_parallel, sync_pipeline, awaited_pipeline, empty_parallel, empty_pipeline, calls)",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("['sync'] ['awaited'] [2] [3] [] [] ['sync', 'awaited']");
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel runs thunks concurrently", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-concurrent-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"import time",
				"start = time.monotonic()",
				"parallel([lambda: time.sleep(0.2) for _ in range(4)], concurrency=4)",
				"print('ELAPSED', time.monotonic() - start)",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).toBe(0);
			const match = result.output.match(/ELAPSED\s+([0-9.]+)/);
			expect(match).not.toBeNull();
			const elapsed = Number(match?.[1]);
			// Four 0.2s sleeps with concurrency 4 must overlap: serial would be
			// ~0.8s. Generous bound keeps the assertion robust under load.
			expect(elapsed).toBeLessThan(0.6);
		} finally {
			await kernel.shutdown();
		}
	});

	it("pipeline transforms items stage by stage", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-pipeline-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				"print(pipeline([1, 2, 3], lambda x: x + 1, lambda x: x * 10))",
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("[20, 30, 40]");
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel propagates a thunk exception", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = ["def boom():", "    raise ValueError('kaboom')", "parallel([lambda: 1, boom, lambda: 3])"].join(
				"\n",
			);
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("kaboom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("log and phase emit status events", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-status-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "log('hello'); phase('Scan')");
			expect(result.exitCode).toBe(0);
			const statuses = result.displayOutputs.filter(
				(o): o is Extract<typeof o, { type: "status" }> => o.type === "status",
			);
			const logEvent = statuses.find(s => s.event.op === "log");
			expect(logEvent).toBeDefined();
			expect(logEvent?.event.message).toBe("hello");
			const phaseEvent = statuses.find(s => s.event.op === "phase");
			expect(phaseEvent).toBeDefined();
			expect(phaseEvent?.event.title).toBe("Scan");
		} finally {
			await kernel.shutdown();
		}
	});

	it("local:// helpers resolve under the injected root", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-local-roots-");
		const root = path.join(tempDir.path(), "artifacts", "local");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"p = write('local://notes/merge-map.md', 'hello')",
				"print('WROTE', str(p))",
				"append('local://notes/merge-map.md', ' world')",
				"print('READ', read('local://notes/merge-map.md'))",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code, { localRoots: { local: root } });
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(`WROTE ${path.join(root, "notes", "merge-map.md")}`);
			expect(result.output).toContain("READ hello world");
			// Lands under the injected root — not a literal `local:` directory under cwd.
			expect(await Bun.file(path.join(root, "notes", "merge-map.md")).text()).toBe("hello world");
			expect(await Bun.file(path.join(tempDir.path(), "local:")).exists()).toBe(false);
		} finally {
			await kernel.shutdown();
		}
	});
});
