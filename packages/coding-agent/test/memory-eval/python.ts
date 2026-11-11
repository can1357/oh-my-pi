import { $which } from "@oh-my-pi/pi-utils";

// The harness's Python helpers need 3.10 or newer (`str | Path` is evaluated at import time).
const PROBE = "import sys; sys.exit(sys.version_info < (3, 10))";

/** The first candidate that runs as Python 3.10+. A candidate that is absent, blocked or older is skipped. */
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
				stdout: "ignore",
				stderr: "ignore",
				timeout: 2000,
			});
			if (probe.exitCode === 0) return candidate;
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
