import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

// A PYTHONPATH tree could supply another Mnemosyne, NumPy or pinned_source to the scripts that attest a runtime.
// PYTHONHOME is refused too, but a bogus home makes the interpreter itself fail before the script runs.
it.skipIf(pythonPath === undefined).each(["upstream_run_a.py", "lme_official_check.py"])(
	"%s refuses to start while PYTHONPATH could override the venv's packages",
	async script => {
		await using dir = await TempDir.create("@memory-eval-overrides-");
		const env = Object.fromEntries(
			Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")),
		);
		const proc = Bun.spawn([pythonPath!, path.join(PY, script), "--out", dir.join("a.json")], {
			env: { ...env, PYTHONPATH: dir.join("site-packages") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(code).toBe(1);
		expect(stderr).toContain(`${script}: refusing to run with PYTHONPATH set`);
	},
);
