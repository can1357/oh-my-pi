/**
 * Holds the terminal handoff on a pseudo-terminal nobody reads, then leaves
 * through the mode its first argument names: `exit` returns from the script,
 * so postmortem's exit cleanup drains the handoff; `signal` stays alive until
 * one arrives. A second argument queues that many bytes behind the handoff,
 * ending with `TAIL-END`. Reports `held` over IPC once the handoff is held.
 */
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { writeBehindTerminalHandoff } from "@oh-my-pi/pi-tui/terminal-handoff";

const mode = process.argv[2] ?? "exit";
const terminal = new ProcessTerminal();
terminal.start(
	() => {},
	() => {},
);
// More than the pseudo-terminal's buffer, so the pump cannot drain it.
terminal.write("x".repeat(8 * 1024 * 1024));
// Cannot drain, so the pump is held for the exit boundary instead of detached.
terminal.stop();
process.send?.(writeBehindTerminalHandoff("", 0) ? "held" : "not-held");
// A payload queued behind the handoff, so a terminal that is still reading can
// be seen to receive all of it: the end marker is its last byte.
const tailBytes = Number(process.argv[3] ?? 0);
if (tailBytes > 0) writeBehindTerminalHandoff(`${"t".repeat(tailBytes)}TAIL-END`, 0);
// Stay alive until a signal; postmortem's exit cleanup then drains the handoff.
if (mode === "signal") setInterval(() => {}, 1000);
