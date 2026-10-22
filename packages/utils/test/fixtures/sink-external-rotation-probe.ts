/**
 * Rotation probe for inherited-descriptor writes. Runs in a PTY subprocess:
 * fd 1 is redirected onto the sink's active log, raw bytes are written past
 * the sink (as an inherited child descriptor would), and the next sink record
 * must rotate the oversized file and re-point fd 1 at the new one.
 */
import * as fs from "node:fs";
import { RotatingFileSink } from "../../src/logger/rotating-file";
import { setStderrRedirectTarget } from "../../src/stderr-guard";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";

const directory = process.argv[2];
const state = process.argv[3] ?? "/tmp/sink-probe-state.txt";
const note = (line: string) => fs.appendFileSync(state, line + "\n");
const sink = new RotatingFileSink({
	directory,
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	maxBytes: 4096,
	maxFiles: 5,
	onRotate: setStderrRedirectTarget,
});
sink.openForExternalWrites();

sink.write(JSON.stringify({ message: "startup record" }));
const isolated = suppressTerminalOutput() !== null;
// Bypass the sink entirely: 8 KiB straight through fd 1, like a spawned child.
fs.writeSync(1, "x".repeat(8192) + "\n");
// External growth is sampled at the batching cadence, not per record: the
// rotation happens on the first record after the window passes.
await Bun.sleep(1_100);
sink.write(JSON.stringify({ message: "post-junk record" }));
fs.writeSync(1, "post-rotation-stdout-marker\n");
sink.flush();
restoreTerminalOutput();
sink.close();
note(`isolated=${isolated}`);
