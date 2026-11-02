import * as fs from "node:fs";
import * as path from "node:path";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Windows `kill()` is TerminateProcess on the `cmd.exe` launcher, which leaves
 * the Bun child running and holding inherited stdio. Exit with the launcher so
 * a stub never outlives the process its caller killed. Unref'd: scripts that
 * finish on their own are not kept alive by the watch.
 */
const EXIT_WITH_LAUNCHER = `if (process.platform === "win32") {
	const launcher = process.ppid;
	setInterval(() => {
		try {
			process.kill(launcher, 0);
		} catch {
			process.exit(0);
		}
	}, 50).unref();
}
`;

/**
 * Write a stub executable `name` into `dir` that runs the JavaScript `source`
 * under the current Bun binary, forwarding every argument (`process.argv[2]`
 * is the first one). Returns the path to invoke.
 *
 * POSIX gets an `exec` shell launcher, so signals reach the script itself.
 * Windows cannot run shebang scripts and gets `<name>.cmd` instead, which both
 * `Bun.spawn` and `Bun.which` resolve. Bun refuses to pass arguments holding
 * cmd.exe metacharacters (`%`, `&`, ...) to a `.cmd`; use
 * {@link compileFakeExecutable} when the caller under test sends those.
 */
export function writeFakeExecutable(dir: string, name: string, source: string): string {
	const script = path.join(dir, `${name}.fake.js`);
	fs.writeFileSync(script, `${EXIT_WITH_LAUNCHER}${source}`);
	if (process.platform === "win32") {
		const launcher = path.join(dir, `${name}.cmd`);
		fs.writeFileSync(launcher, `@"${process.execPath}" "${script}" %*\r\n`);
		return launcher;
	}
	const launcher = path.join(dir, name);
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
	fs.chmodSync(launcher, 0o755);
	return launcher;
}

/**
 * Like {@link writeFakeExecutable}, but on Windows compiles `source` into a
 * standalone `<name>.exe` so arguments reach it verbatim instead of through
 * cmd.exe. Costs a few hundred milliseconds and a full Bun-sized binary, so
 * reserve it for argv the `.cmd` launcher cannot carry. In the compiled stub
 * `process.argv[2]` is still the first forwarded argument.
 */
export async function compileFakeExecutable(dir: string, name: string, source: string): Promise<string> {
	if (process.platform !== "win32") return writeFakeExecutable(dir, name, source);
	const script = path.join(dir, `${name}.fake.js`);
	const executable = path.join(dir, `${name}.exe`);
	fs.writeFileSync(script, source);
	const build = Bun.spawn([process.execPath, "build", "--compile", script, "--outfile", executable], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
	if (exitCode !== 0) throw new Error(`bun build --compile failed for ${name}: ${stderr.trim()}`);
	return executable;
}
