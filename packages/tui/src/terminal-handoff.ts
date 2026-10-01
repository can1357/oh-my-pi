/**
 * Output a stopped terminal could not deliver yet, and the writes that must
 * reach the terminal after it.
 *
 * When `ProcessTerminal.stop()` cannot drain its output pump (the terminal
 * stopped reading), the pump keeps running here instead of detaching. The
 * resume hint, the exit-time restore and the stopped terminal's own writes
 * queue behind its bytes instead of reaching the terminal ahead of them,
 * where their late alternate-screen exit would erase them. Each waits up to
 * {@link STOP_DRAIN_MS}; the exit boundary ({@link drainTerminalHandoff})
 * waits until the terminal has taken everything.
 */
import { stderrSharesStdoutTerminal } from "@oh-my-pi/pi-utils/stderr-guard";
import type { OutputPump, ProcessTerminal } from "./terminal";

/** How long a handoff settle waits for the output backlog to drain before dropping it. */
export const STOP_DRAIN_MS = 1000;

let terminalHandoff: { pump: OutputPump; owner: ProcessTerminal } | undefined;

/** Keep `pump`, which still holds undelivered bytes, running for `owner`'s later writes. */
export function holdTerminalHandoff(pump: OutputPump, owner: ProcessTerminal): void {
	releaseTerminalHandoff();
	terminalHandoff = { pump, owner };
}

/** Stop the held pump: joined once drained, else left to exit when its queue drains. */
export function releaseTerminalHandoff(): void {
	const held = terminalHandoff;
	if (!held) return;
	terminalHandoff = undefined;
	held.pump.stop(0);
}

/**
 * Queue `text` behind the held pump's undelivered bytes, then wait up to
 * `waitMs` for the terminal to take them. With `owner`, only that terminal's
 * held pump takes the text. Returns false when no such bytes are pending; the
 * caller then writes directly.
 */
export function writeBehindTerminalHandoff(text: string, waitMs = STOP_DRAIN_MS, owner?: ProcessTerminal): boolean {
	const held = terminalHandoff;
	if (!held || (owner !== undefined && held.owner !== owner)) return false;
	const { pump } = held;
	if (pump.dead || pump.pending() === 0) {
		releaseTerminalHandoff();
		return false;
	}
	pump.write(text.isWellFormed() ? text : text.toWellFormed());
	if (pump.flushSync(waitMs)) releaseTerminalHandoff();
	return true;
}

/**
 * Write `text` to stderr after the output a stopped terminal still holds, when
 * stderr is that terminal; otherwise straight to stderr.
 */
export function writeStderrBehindTerminal(text: string): void {
	if (!terminalHandoff || !stderrSharesStdoutTerminal() || !writeBehindTerminalHandoff(text)) {
		process.stderr.write(text);
	}
}

/**
 * The exit boundary: wait, with no time bound, until the held pump has
 * delivered everything queued on it, so the process never exits with the
 * terminal-mode restore or the resume hint still undelivered. A terminal that
 * never reads again holds the exit.
 */
export function drainTerminalHandoff(): void {
	const pump = terminalHandoff?.pump;
	if (!pump) return;
	while (!pump.flushSync(STOP_DRAIN_MS) && !pump.dead) {
		// Still stalled: the next wait starts where this one ran out.
	}
	releaseTerminalHandoff();
}
