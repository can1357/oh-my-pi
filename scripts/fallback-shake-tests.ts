#!/usr/bin/env bun
/** Run shake contracts without probing the developer's real credentials or configuration. */
import { TempDir } from "@oh-my-pi/pi-utils";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Pass at least one shake contract test file");

const home = TempDir.createSync("@omp-fallback-shake-tests-");
try {
	const child = Bun.spawn([process.execPath, "test", ...files], {
		cwd: process.cwd(),
		env: { ...process.env, HOME: home.absolute() },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exitCode = await child.exited;
} finally {
	await home.remove();
}
