/**
 * Bound-writer probe. Runs in a PTY subprocess: an extension-style consumer
 * caches `process.stdout.write.bind(process.stdout)` before the guard starts.
 * Writes through that cached bound function during suppression must land in
 * the redirect target, not paint the viewport.
 */
import * as fs from "node:fs";
import {
	restoreTerminalOutput,
	setTerminalOutputRedirectTarget,
	suppressTerminalOutput,
} from "../../src/terminal-output-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

type WriteArgs = [chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void];
const cachedBoundWrite = process.stdout.write.bind(process.stdout) as (...args: WriteArgs) => boolean;

const target = `${directory}/bound-writer.log`;
fs.writeFileSync(target, "");
setTerminalOutputRedirectTarget(target);
const suppressed = suppressTerminalOutput() !== null;
cachedBoundWrite("bound-write-marker\n");
restoreTerminalOutput();
note(`suppressed=${suppressed}`);
