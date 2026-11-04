/**
 * A process for session-exit-context.test.ts whose exit-context reader is
 * terminated inside a board instruction, holding a word no one else knows
 * about. `./session-exit-context-board-pause` parks the reader there; this
 * process kills it, then asks a second, untouched reader for the exit context
 * twice over the same board.
 *
 * A board behind a lock loses the word here: the dead reader never releases it,
 * the next reader's wait for it times out, and a protocol that reads a timeout
 * as "nothing is recorded" deletes the only copy of the word. A board published
 * by compare-exchange has nothing to release.
 *
 * Prints one JSON line: `{ parked, duringPause, heldAnswered, first, second,
 * files }`, where `parked` names the instruction the dead reader stopped at (or
 * `null` when it ran to the end instead), `duringPause` is the directory while
 * it was stopped, `heldAnswered` is whether it ever answered, and `first` and
 * `second` are what the two later exits record.
 *
 * Usage: <intent dir> publish|reserve
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	EXIT_CONTEXT_RESULT_OFFSET,
	type ExitContextIoRequest,
	type ExitContextIoResult,
	createExitContextBoard,
} from "@oh-my-pi/pi-coding-agent/session/exit-context-protocol";

const [dir, trigger] = process.argv.slice(2);
if (!dir || (trigger !== "publish" && trigger !== "reserve")) {
	throw new Error("usage: <intent dir> publish|reserve");
}
fs.mkdirSync(dir, { recursive: true });

const RESULT_BYTES = EXIT_CONTEXT_RESULT_OFFSET + 1024;
const HELD_READER = path.join(import.meta.dir, "session-exit-context-board-reader.ts");
const READER = path.join(import.meta.dir, "../../src/session/exit-context-worker.ts");

const pid = process.pid;
const intentPath = path.join(dir, String(pid));
fs.writeFileSync(intentPath, "restart\n");
const request: Omit<ExitContextIoRequest, "state"> = {
	pid,
	cgroupFile: path.join(dir, "no-cgroup"),
	cgroupRoot: dir,
	intentDir: dir,
	processStartMs: 0,
	board: createExitContextBoard(0),
};

/** The answer in `state`, once the reader has written one. */
function answerIn(state: SharedArrayBuffer): ExitContextIoResult | undefined {
	const header = new Int32Array(state, 0, 2);
	if (Atomics.load(header, 0) !== 1) return undefined;
	const bytes = new Uint8Array(state, EXIT_CONTEXT_RESULT_OFFSET, Atomics.load(header, 1));
	return JSON.parse(new TextDecoder().decode(bytes)) as ExitContextIoResult;
}

async function ask(reader: Worker): Promise<ExitContextIoResult> {
	const state = new SharedArrayBuffer(RESULT_BYTES);
	reader.postMessage({ ...request, state } satisfies ExitContextIoRequest);
	const deadline = Date.now() + 60_000;
	for (;;) {
		const answer = answerIn(state);
		if (answer) return answer;
		if (Date.now() > deadline) throw new Error("the reader never answered");
		await Bun.sleep(5);
	}
}

const held = new Worker(HELD_READER, { type: "module", argv: [intentPath, trigger] });
const parked = Promise.withResolvers<{ parked: string }>();
held.addEventListener("message", event => parked.resolve((event as MessageEvent).data as { parked: string }));
const closed = Promise.withResolvers<void>();
held.addEventListener("close", () => closed.resolve());
const heldState = new SharedArrayBuffer(RESULT_BYTES);
held.postMessage({ ...request, state: heldState } satisfies ExitContextIoRequest);

// It parks at the instruction it was told to, or — where that instruction is
// not one this board uses — runs the whole claim instead.
const stopped = await Promise.race([
	parked.promise,
	(async () => {
		const deadline = Date.now() + 30_000;
		while (!answerIn(heldState) && Date.now() < deadline) await Bun.sleep(5);
		return undefined;
	})(),
]);
const duringPause = fs.readdirSync(dir);
held.terminate();
await closed.promise;

const reader = new Worker(READER, { type: "module" });
const first = await ask(reader);
const second = await ask(reader);
reader.terminate();

process.stdout.write(
	`${JSON.stringify({
		parked: stopped?.parked ?? null,
		duringPause,
		heldAnswered: Atomics.load(new Int32Array(heldState), 0) === 1,
		first,
		second,
		files: fs.readdirSync(dir),
	})}\n`,
);
process.exit(0);
