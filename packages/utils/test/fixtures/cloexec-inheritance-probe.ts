/**
 * CLOEXEC probe. Runs in a PTY subprocess: while the unified guard is
 * suppressing output, an exec'd child scans its inherited descriptors.
 * Saved/render descriptors for the real terminal must NOT be inherited —
 * dup() clears FD_CLOEXEC, so without an explicit re-mark the child gets a
 * writable fd straight to the terminal and bypasses the isolation.
 */
import * as fs from "node:fs";
import {
	duplicateTerminalOutput,
	restoreTerminalOutput,
	suppressTerminalOutput,
} from "../../src/terminal-output-guard";

const state = process.argv[2];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const saved = suppressTerminalOutput();
if (saved === null) {
	note("suppressed=false");
} else {
	try {
		// The private render stream ProcessTerminal would own.
		const renderFd = duplicateTerminalOutput();
		fs.closeSync(renderFd);
		const scan = Bun.spawnSync([
			process.execPath,
			"-e",
			'const fs = require("node:fs");\n' +
				"const leaked = [];\n" +
				'for (const name of fs.readdirSync("/proc/self/fd")) {\n' +
				"  const fd = Number(name);\n" +
				"  if (fd < 3) continue;\n" +
				"  try {\n" +
				'    const target = fs.readlinkSync("/proc/self/fd/" + name);\n' +
				'    if (target.includes("/dev/pts/") || target.includes("/dev/tty") || target.includes("/dev/ptmx")) leaked.push(target);\n' +
				"  } catch {}\n" +
				"}\n" +
				"console.log(JSON.stringify(leaked));",
		]);
		const stdout = scan.stdout ? scan.stdout.toString().trim() : "";
		let leakedCount = -1;
		try {
			leakedCount = (JSON.parse(stdout) as string[]).length;
		} catch {
			note(`scan-error exit=${scan.exitCode} stdout=${JSON.stringify(stdout.slice(0, 200))}`);
		}
		if (leakedCount >= 0) note(`suppressed=true leaked=${leakedCount}`);
	} catch (err) {
		note(`probe-error=${String(err).slice(0, 300)}`);
	} finally {
		restoreTerminalOutput();
	}
}
