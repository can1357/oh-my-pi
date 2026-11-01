import { $which } from "@oh-my-pi/pi-utils";

function findPython(): string | undefined {
	// A Windows Store alias or an unrelated PYTHON command can exist without being a usable Python 3 interpreter.
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.toUpperCase().startsWith("PYTHON")));
	for (const candidate of [Bun.env.PYTHON, $which("python3"), $which("python")]) {
		if (!candidate) continue;
		try {
			const probe = Bun.spawnSync([candidate, "-c", "import sys; sys.exit(sys.version_info.major != 3)"], {
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
