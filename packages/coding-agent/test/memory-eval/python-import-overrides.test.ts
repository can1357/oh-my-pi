import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

// A PYTHONPATH sitecustomize.py runs at interpreter startup, before any line of a script, so no in-script check can stop
// it; only `python -I` can. Each script therefore refuses to run outside isolated mode, before importing anything, even
// with no PYTHON* variable set at all.
const SCRIPTS = [
	"upstream_run_a.py",
	"lme_official_check.py",
	"embed_parity.py",
	"prepare_datasets.py",
	"make_dev_subset.py",
];

it.skipIf(pythonPath === undefined).each(SCRIPTS)("%s refuses to start outside isolated mode", async script => {
	await using dir = await TempDir.create("@memory-eval-isolated-");
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")));
	const proc = Bun.spawn([pythonPath!, path.join(PY, script), "--out", dir.join("a.json")], {
		env: { ...env, HOME: dir.path(), USERPROFILE: dir.path() },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	expect(code).toBe(1);
	expect(stderr).toContain(`${script}: run it with \`python -I\``);
});
