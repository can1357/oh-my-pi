/**
 * Child of `terminal-output-backlog.test.ts`. Run under a real pty, so stdout
 * is a TTY and `ProcessTerminal` owns a live `TtyWriter` — the pump `bun test`
 * never builds in-process. Writes one frame and reports how its backlog reads
 * once the pty consumer has taken it.
 */
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";

const terminal = new ProcessTerminal();
terminal.start(
	() => {},
	() => {},
);
// Large enough that the writer still holds it when the enqueue returns, and
// under the 256 KiB level the render gate and the stall watchdog act on.
terminal.write(`\x1b[?1049l${"dismissal".repeat(20_000)}`);
const started = Date.now();
let pending = terminal.pendingOutputBytes;
const enqueued = pending;
while (pending > 0 && Date.now() - started < 1_000) {
	await Bun.sleep(5);
	pending = terminal.pendingOutputBytes;
}
const elapsed = Date.now() - started;
terminal.stop();
process.stdout.write(`\nPROBE enqueued=${enqueued} pending=${pending} ms=${elapsed}\n`);
