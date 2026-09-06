#!/usr/bin/env bun
/** Launch the measurement process with isolated OMP state before module initialization. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseOptions } from "./tool-latency/sampling";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(
		"Usage: bun scripts/bench-tool-latency.ts [--runs 30] [--warmups 5] [--python /path/to/python3] [--cold-runs 5] [--direnv /path/to/direnv]\nWrites JSON to stdout. Uses temporary read/search fixtures and JS eval; Python, cold-process sampling and isolated direnv fixtures are opt-in.",
	);
} else {
	const options = parseOptions(args);
	if (options.python && !path.isAbsolute(options.python)) throw new Error("--python requires an absolute path");
	if (options.direnv && (!path.isAbsolute(options.direnv) || process.platform === "win32"))
		throw new Error("--direnv requires an absolute path on a POSIX host");
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tool-latency-"));
	try {
		let searchPath = process.env.PATH ?? "";
		if (options.direnv) {
			await fs.access(options.direnv, fs.constants.X_OK);
			const bin = path.join(scratch, "bin");
			await fs.mkdir(bin);
			await fs.symlink(options.direnv, path.join(bin, "direnv"));
			searchPath = `${bin}${path.delimiter}${searchPath}`;
		}
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tool-latency/runner.ts"), ...args], {
			cwd: scratch,
			env: {
				PATH: searchPath,
				HOME: scratch,
				XDG_CONFIG_HOME: path.join(scratch, "config"),
				XDG_DATA_HOME: path.join(scratch, "data"),
				XDG_CACHE_HOME: path.join(scratch, "cache"),
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
