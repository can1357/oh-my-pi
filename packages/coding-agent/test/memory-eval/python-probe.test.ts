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

// A command that exits 0 without being Python (`true`, a Windows Store alias that prints nothing) must not be taken.
it.skipIf(pythonPath === undefined || process.platform === "win32")(
	"skips a candidate that exits 0 without printing the probe sentinel",
	async () => {
		using tmp = TempDir.createSync("@omp-memory-eval-python-probe-");
		const silent = tmp.join("silent");
		await Bun.write(silent, "#!/bin/sh\nexit 0\n");
		await fs.chmod(silent, 0o755);
		const noisy = tmp.join("noisy");
		await Bun.write(noisy, "#!/bin/sh\necho Python 3.13\nexit 0\n");
		await fs.chmod(noisy, 0o755);

		expect(findPython([silent])).toBeUndefined();
		expect(findPython([noisy])).toBeUndefined();
		expect(findPython([silent, noisy, pythonPath])).toBe(pythonPath);
	},
);
