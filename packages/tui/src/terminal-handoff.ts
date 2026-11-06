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

/**
 * How long {@link drainTerminalHandoff} keeps waiting without the backlog
 * getting smaller. Every byte the terminal takes starts it again. A terminal that stays open but never reads again — a hung
 * SSH session before TCP keepalive gives up, a frozen emulator, a pane nobody
 * drains — never errors a write, so `pump.dead` never flips and an unbounded
 * wait would hold the process open for good. The wait is synchronous, so it
 * also blocks postmortem's own deadline timers and a second signal, leaving
 * only SIGKILL. Measured against progress, not elapsed time, so a terminal
 * reading slowly keeps every byte while a stalled one costs one wait.
 */
export const HANDOFF_DRAIN_IDLE_MS = 5000;

/**
 * Backstop on {@link drainTerminalHandoff}'s total wait, for a terminal that
 * reads just fast enough to look alive. It ends a drain that is still making
 * progress, so a slow enough reader loses the rest: measured, one taking about
 * 4 KiB every 500 ms had 229,007 of 262,144 bytes when it ended. Past either
 * bound the handoff is released and its bytes abandoned, exactly as a stop
 * that could not drain did before the handoff existed.
 */
export const HANDOFF_DRAIN_DEADLINE_MS = 30_000;

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
 * The exit boundary: wait until the held pump has delivered everything queued
 * on it, so the process does not exit with the terminal-mode restore or the
 * resume hint still undelivered. Bounded by
 * {@link HANDOFF_DRAIN_DEADLINE_MS}: a terminal that never reads again costs
 * that long and no more, and then the exit proceeds without those bytes.
 */
export function drainTerminalHandoff(): void {
	const pump = terminalHandoff?.pump;
	if (!pump) return;
	const deadline = Date.now() + HANDOFF_DRAIN_DEADLINE_MS;
	let idleDeadline = Date.now() + HANDOFF_DRAIN_IDLE_MS;
	let pending = pump.pending();
	// Released whatever the waits do: a throw here would otherwise leave the
	// handoff held, and every later write would queue behind a pump nothing
	// will drain.
	try {
		for (;;) {
			const left = Math.min(idleDeadline, deadline) - Date.now();
			if (left <= 0 || pump.flushSync(Math.min(STOP_DRAIN_MS, left)) || pump.dead) break;
			// Bytes still queued. A terminal that took some of them is alive and
			// keeps the rest: its idle window starts again. One that took none
			// spends what is left of that window and then loses them.
			const remaining = pump.pending();
			if (remaining < pending) {
				pending = remaining;
				idleDeadline = Date.now() + HANDOFF_DRAIN_IDLE_MS;
			}
		}
	} finally {
		releaseTerminalHandoff();
	}
}
