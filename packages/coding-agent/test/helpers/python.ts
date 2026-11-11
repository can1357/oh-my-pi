import { $whichAll } from "@oh-my-pi/pi-utils";

/**
 * The interpreter Python-backed tests run: `$PYTHON`, else the first `python` / `python3` on PATH
 * (the order `enumeratePythonRuntimes` uses) that actually starts. Windows' App Execution Alias
 * stubs (`WindowsApps\python3.exe` without the Store package) are on PATH but only print
 * "Python was not found" and exit non-zero, so a bare PATH lookup is not enough.
 * `undefined` when no working interpreter exists.
 */
export const TEST_PYTHON: string | undefined =
	Bun.env.PYTHON ??
	[...$whichAll("python"), ...$whichAll("python3")].find(
		candidate =>
			Bun.spawnSync([candidate, "-c", "pass"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode ===
			0,
	);
