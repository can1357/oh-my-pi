import * as fs from "node:fs";
import type { Subprocess } from "bun";

/** A detached process and the file its stdout/stderr go to. */
export interface SpawnedDetached {
	proc: Subprocess;
	logPath: string;
}

/**
 * Start `cmd` in its own session so it outlives this omp process; its output
 * goes to `logPath`, truncated first unless `append`.
 */
export function spawnDetached(
	cmd: string[],
	cwd: string | undefined,
	env: Record<string, string>,
	logPath: string,
	options: { append?: boolean } = {},
): SpawnedDetached {
	const log = fs.openSync(logPath, options.append ? "a" : "w");
	try {
		const proc = Bun.spawn({
			cmd,
			cwd,
			env,
			detached: true,
			stdin: "ignore",
			stdout: log,
			stderr: log,
			windowsHide: true,
		});
		proc.unref();
		return { proc, logPath };
	} finally {
		fs.closeSync(log);
	}
}
