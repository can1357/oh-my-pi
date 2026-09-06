#!/usr/bin/env bun
/** Launch the measurement process with isolated OMP state before module initialization. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseOptions } from "./tool-latency/sampling";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(
		"Usage: bun scripts/bench-tool-latency.ts [--runs 30] [--warmups 5] [--python /path/to/python3]\nWrites JSON to stdout. Uses temporary read/search fixtures and JS eval; Python is opt-in.",
	);
} else {
	parseOptions(args);
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tool-latency-"));
	try {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tool-latency/runner.ts"), ...args], {
			cwd: scratch,
			env: {
				PATH: process.env.PATH ?? "",
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				TMPDIR: scratch,
				TMP: scratch,
				TEMP: scratch,
				PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
			},
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		const stop = () => child.kill("SIGTERM");
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			process.exitCode = await child.exited;
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}
