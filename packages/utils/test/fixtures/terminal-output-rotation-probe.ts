/**
 * Drives terminal output isolation against a rotating sink. Runs in a PTY
 * subprocess: fd 1/2 are redirected while the fixed-date preload supplies
 * the clock via `OMP_LOGGER_TEST_NOW`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "../../src/dirs";
import { RotatingFileSink } from "../../src/logger/rotating-file";
import { setStderrRedirectTarget } from "../../src/stderr-guard";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";

const directory = process.argv[2];
const nextDay = process.argv[3];
const thirdDay = process.argv[4];

const sink = new RotatingFileSink({
	directory,
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	maxBytes: 10 * 1024 * 1024,
	maxFiles: 5,
	onRotate: setStderrRedirectTarget,
});
sink.openForExternalWrites();

sink.write(JSON.stringify({ message: "startup-day record" }));
const startupFile = fs.readdirSync(directory).find(name => name.endsWith(".log"))!;
// Resolved on the startup day: it must name the file the sink just opened.
const logPathBasename = path.basename(getLogPath(new Date(), process.pid));

// Adopt the sink's active file; never derive a second date-based destination.
const isolated = suppressTerminalOutput() !== null;
fs.writeSync(1, "startup-stdout-marker\n");
fs.writeSync(2, "startup-day-marker\n");

process.env.OMP_LOGGER_TEST_NOW = nextDay;
sink.write(JSON.stringify({ message: "next-day record" }));
const currentFile = fs.readdirSync(directory).find(name => name.endsWith(".log") && name !== startupFile);
fs.writeSync(2, "next-day-marker\n");
fs.writeSync(1, "next-stdout-marker\n");

restoreTerminalOutput();
// Rotation after release must not redirect either descriptor again.
process.env.OMP_LOGGER_TEST_NOW = thirdDay;
sink.write(JSON.stringify({ message: "third-day record" }));
fs.writeSync(2, "stderr-restored\n");
fs.writeSync(1, "stdout-restored\n");
sink.close();

process.stdout.write(
	JSON.stringify({
		isolated,
		logPathBasename,
		startupFile,
		currentFile,
		startupBody: fs.readFileSync(path.join(directory, startupFile), "utf8"),
		currentBody: currentFile ? fs.readFileSync(path.join(directory, currentFile), "utf8") : "",
	}),
);
