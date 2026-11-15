/**
 * A Python eval cell runs as an omp tool process: its environment carries the
 * `OMPCODE=1` mark the bash tool and the JS kernel carry, so an `omp <words>` a
 * cell starts without a terminal is refused instead of becoming a headless agent.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` like the other real-kernel tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("python kernel tool-process mark", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("marks the kernel and its children with OMPCODE=1", async () => {
		using tempDir = TempDir.createSync("@python-tool-mark-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				"import os, subprocess\nprint('KERNEL', os.environ.get('OMPCODE'))\nprint('CHILD', subprocess.run(['sh', '-c', 'echo $OMPCODE'], capture_output=True, text=True).stdout.strip())",
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("KERNEL 1");
			expect(result.output).toContain("CHILD 1");
		} finally {
			await kernel.shutdown();
		}
	});
});
