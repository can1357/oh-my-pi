import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pythonPath } from "./python";

const RUN_A = path.join(import.meta.dir, "../../bench/memory-eval/py/upstream_run_a.py");

// A PYTHONPATH tree could supply another Mnemosyne (or its dependencies) to Run A while the dump still calibrates.
// PYTHONHOME is refused too, but a bogus home makes the interpreter itself fail before the script runs.
it.skipIf(pythonPath === undefined).each(["PYTHONPATH"])(
	"Run A refuses to start while %s could override the venv's packages",
	async name => {
		await using dir = await TempDir.create("@memory-eval-run-a-");
		const env = Object.fromEntries(
			Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")),
		);
		const proc = Bun.spawn([pythonPath!, RUN_A, "--out", dir.join("a.json")], {
			env: { ...env, [name]: dir.join("site-packages") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(code).toBe(1);
		expect(stderr).toContain(`refusing to run with ${name} set`);
	},
);
