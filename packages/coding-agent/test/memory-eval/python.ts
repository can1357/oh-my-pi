import { $which } from "@oh-my-pi/pi-utils";

// The harness's Python helpers need 3.10 or newer (`str | Path` is evaluated at import time).
const PROBE = 'import sys; print("omp-py", *sys.version_info[:2])';
const PROBE_OUTPUT = /^omp-py (\d+) (\d+)\s*$/;

/** Whether the probe's output names Python 3.10 or newer. A command that exits 0 without printing it is not Python. */
function isSupported(output: string): boolean {
	const match = PROBE_OUTPUT.exec(output);
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return major > 3 || (major === 3 && minor >= 10);
}

/** The first candidate that runs as Python 3.10+. A candidate that is absent, blocked, not Python or older is skipped. */
export function findPython(
	candidates: Array<string | null | undefined> = [Bun.env.PYTHON, $which("python3"), $which("python")],
): string | undefined {
	// A Windows Store alias or an unrelated PYTHON command can exist without being a usable Python interpreter.
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")));
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const probe = Bun.spawnSync([candidate, "-c", PROBE], {
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: 2000,
			});
			if (probe.exitCode === 0 && isSupported(probe.stdout.toString())) return candidate;
		} catch {
			// An absent, blocked or unlaunchable interpreter is an optional test dependency.
		}
	}
	return undefined;
}

export const pythonPath = findPython();

/** `pythonPath` for tests that have already been skipped when it is undefined. */
export function python(): string {
	if (!pythonPath) throw new Error("Python is required for this test");
	return pythonPath;
}
