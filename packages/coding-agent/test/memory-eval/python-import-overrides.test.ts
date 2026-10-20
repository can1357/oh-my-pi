import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

// Each script refuses any PYTHON* variable that changes what an import loads, before importing anything: a PYTHONPATH
// tree could shadow a standard module, and a PYTHONPYCACHEPREFIX could hold stale bytecode for one. PYTHONHOME is
// refused too, but a bogus home makes the interpreter itself fail before the script runs.
const SCRIPTS = [
	"upstream_run_a.py",
	"lme_official_check.py",
	"embed_parity.py",
	"prepare_datasets.py",
	"make_dev_subset.py",
];

it.skipIf(pythonPath === undefined).each(
	SCRIPTS.flatMap(script => [
		[script, "PYTHONPATH"],
		[script, "PYTHONPYCACHEPREFIX"],
	]),
)("%s refuses to start while %s could change what it imports", async (script, variable) => {
	await using dir = await TempDir.create("@memory-eval-overrides-");
	// Runs on import and exits with its own code, as a hostile shadow would before the guard sees anything.
	await Bun.write(dir.join("site-packages", "json.py"), "import sys\nsys.exit(7)\n");
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")));
	const proc = Bun.spawn([pythonPath!, path.join(PY, script), "--out", dir.join("a.json")], {
		// An allowed variable must not trip the guard; the overriding one must.
		env: { ...env, PYTHONUNBUFFERED: "1", [variable]: dir.join("site-packages") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	expect(code).toBe(1);
	expect(stderr).toContain(`${script}: refusing to run with ${variable} set`);
});
