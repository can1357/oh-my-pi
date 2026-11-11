import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { findPython, pythonPath } from "./python";

// The helpers need 3.10+, so an older interpreter must be skipped rather than picked and then fail at import.
// A shell script is not executable on Windows, so the fake interpreter is POSIX-only.
it.skipIf(pythonPath === undefined || process.platform === "win32")(
	"skips a Python 3.9 candidate and takes the next one",
	async () => {
		using tmp = TempDir.createSync("@omp-memory-eval-python-probe-");
		const fake39 = tmp.join("python3.9");
		// Runs the probe under the real interpreter with its reported version replaced (a tuple that still has `.major`).
		const version = 'collections.namedtuple("V", "major minor micro releaselevel serial")(3, 9, 18, "final", 0)';
		await Bun.write(
			fake39,
			`#!/bin/sh\nexec "${pythonPath}" -c 'import sys, collections; sys.version_info = ${version}; exec(sys.argv[1])' "$2"\n`,
		);
		await fs.chmod(fake39, 0o755);

		expect(findPython([fake39])).toBeUndefined();
		expect(findPython([fake39, pythonPath])).toBe(pythonPath);
	},
);
