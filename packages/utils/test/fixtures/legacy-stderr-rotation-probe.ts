/**
 * Legacy-suppression rotation probe. Runs in a PTY subprocess with only the
 * 16.5.1 stderr guard active (no unified guard). When the rotating sink
 * rotates the active log, fd 2 must follow the new file — the logger wires
 * onRotate through the package's redirect setters, and a legacy-only
 * consumer must not keep writing into the file retention is about to prune.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RotatingFileSink } from "../../src/logger/rotating-file";
import { setStderrRedirectTarget } from "../../src/stderr-guard";
import { restoreTerminalStderr, suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);
const sink = new RotatingFileSink({
	directory,
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	maxBytes: 4096,
	maxFiles: 5,
	onRotate: setStderrRedirectTarget,
});
sink.openForExternalWrites();

sink.write(JSON.stringify({ message: "first record" }));
sink.flush();
const active = fs.readdirSync(directory).find(name => name.endsWith(".log"));
note(`has-active=${Boolean(active)}`);
note(`suppressed=${suppressTerminalStderr({ redirectPath: active ? path.join(directory, active) : undefined })}`);

// Grow the active file past the cap through fd 2 (the redirected descriptor),
// then let the sink observe the size and rotate on its next write.
fs.writeSync(2, "x".repeat(8192));
sink.write(JSON.stringify({ message: "rotation trigger" }));
sink.flush();

// Whichever file the sink now writes must also receive fd 2 diagnostics.
fs.writeSync(2, "post-rotation-stderr-marker\n");
sink.flush();
const files = fs
	.readdirSync(directory)
	.filter(name => name.startsWith("omp."))
	.sort();
const current = files.length > 0 ? fs.readFileSync(path.join(directory, files[files.length - 1]), "utf8") : "";
note(`marker-followed-rotation=${current.includes("post-rotation-stderr-marker")}`);
restoreTerminalStderr();
sink.close();
