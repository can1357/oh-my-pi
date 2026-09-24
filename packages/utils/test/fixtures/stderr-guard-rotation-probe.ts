/**
 * Drives the production wiring of the macOS stderr guard against a rotating
 * sink: the guard adopts the sink's active file, and the sink's `onRotate`
 * hook re-points fd 2 when a local-day rotation moves the active file.
 *
 * Runs in a subprocess — it mutates fd 2 — with the fixed-date preload
 * supplying the clock via `OMP_LOGGER_TEST_NOW`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "../../src/dirs";
import { RotatingFileSink } from "../../src/logger/rotating-file";
import { restoreTerminalStderr, setStderrRedirectTarget, suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const nextDay = process.argv[3];
const thirdDay = process.argv[4];

const sink = new RotatingFileSink({
	directory,
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	auditFile: path.join(directory, `.omp.${process.pid}-audit.json`),
	maxBytes: 10 * 1024 * 1024,
	maxFiles: 5,
	onRotate: setStderrRedirectTarget,
});

sink.write(JSON.stringify({ message: "startup-day record" }));
const startupFile = fs.readdirSync(directory).find(name => name.endsWith(".log"))!;
// Resolved on the startup day: it must name the file the sink just opened.
const logPathBasename = path.basename(getLogPath(new Date(), process.pid));

// No explicit redirectPath: the guard must adopt the file the sink reported.
const forced = suppressTerminalStderr({ force: true });
fs.writeSync(2, "startup-day-marker\n");

process.env.OMP_LOGGER_TEST_NOW = nextDay;
sink.write(JSON.stringify({ message: "next-day record" }));
const currentFile = fs.readdirSync(directory).find(name => name.endsWith(".log") && name !== startupFile);
fs.writeSync(2, "next-day-marker\n");

restoreTerminalStderr();
// Terminal ownership is back with the shell: a rotation must only record the
// new path, never dup2 it over the restored fd 2.
process.env.OMP_LOGGER_TEST_NOW = thirdDay;
sink.write(JSON.stringify({ message: "third-day record" }));
fs.writeSync(2, "restored\n");
sink.close();

process.stdout.write(
	JSON.stringify({
		forced,
		logPathBasename,
		startupFile,
		currentFile,
		startupBody: fs.readFileSync(path.join(directory, startupFile), "utf8"),
		currentBody: currentFile ? fs.readFileSync(path.join(directory, currentFile), "utf8") : "",
	}),
);
