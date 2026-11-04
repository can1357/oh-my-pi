/**
 * Parks this thread, forever, at one board instruction of the exit-context
 * reader, so `session-exit-context-board-death.ts` can terminate the reader
 * exactly there. Imported before the reader module by
 * `session-exit-context-board-reader.ts`, which is the only reason it is a
 * module of its own: the patch has to be in place before the reader registers
 * its handler.
 *
 * `process.argv` ends with the intent path and the instruction to park at. The
 * reader's only shared memory besides the board is the buffer it writes its
 * answer into, which it only stores to, so every `Atomics.compareExchange` and
 * every `Atomics.add` on this thread is a board instruction. Both triggers wait
 * for the intent file to be gone first, which is the point in a pass where the
 * reader holds a word that only it knows about:
 *
 * - `publish`: park just after the first such exchange. On a board published by
 *   compare-exchange the word is on it and the copy it came from is not yet
 *   deleted; on a board behind a lock the dead thread is holding the lock.
 * - `reserve`: park just before the first such add, which is the record's bytes
 *   being reserved — after the word was read and before anything is published.
 */
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";

const [intentPath, trigger] = process.argv.slice(-2);
if (!intentPath || (trigger !== "publish" && trigger !== "reserve")) {
	throw new Error(`session-exit-context-board-pause: bad argv ${process.argv.join(" ")}`);
}

let parked = false;

/** Park unless the file is still at the intent path, or this thread has parked already. */
function park(): void {
	if (parked || fs.existsSync(intentPath)) return;
	parked = true;
	parentPort?.postMessage({ parked: trigger });
	// Nothing ever notifies this buffer: the thread stays here until it is terminated.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (trigger === "publish") {
	const exchange = Atomics.compareExchange;
	Atomics.compareExchange = ((...args: unknown[]) => {
		const previous: unknown = Reflect.apply(exchange, Atomics, args);
		park();
		return previous;
	}) as typeof Atomics.compareExchange;
} else {
	const add = Atomics.add;
	Atomics.add = ((...args: unknown[]) => {
		park();
		return Reflect.apply(add, Atomics, args) as number;
	}) as typeof Atomics.add;
}
