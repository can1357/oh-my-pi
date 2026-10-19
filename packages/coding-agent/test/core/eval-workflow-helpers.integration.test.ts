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

	it("read() returns an artifact's full text and refuses artifact writes", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-artifact-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		await Bun.write(path.join(artifacts, "12.eval.log"), `${"v".repeat(14_430)}\nsecond\nthird\n`);
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"print('LEN', len(read('artifact://12')))",
				"print('LINE', read('artifact://12', offset=2, limit=1).strip())",
				"try:\n    write('artifact://12', 'x')\nexcept ValueError as e:\n    print('REFUSED', e)",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code, { localRoots: { artifact: artifacts } });
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("LEN 14444");
			expect(result.output).toContain("LINE second");
			expect(result.output).toContain("REFUSED Protocol paths are not supported");
		} finally {
			await kernel.shutdown();
		}
	});
});
