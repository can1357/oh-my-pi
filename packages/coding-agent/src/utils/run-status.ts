/**
 * The agent's run status, published to every terminal surface that shows it:
 * the title's run-state separator, and the root record of the OSC 7501 Program
 * Status Protocol (https://mitchellh.com/writing/program-status-osc7501),
 * which tabs, multiplexers, and agent inboxes read from the PTY instead of
 * scraping the title.
 *
 * A report replaces the terminal's record whole, so each one carries `app` and
 * the full status. omp only writes the root record; teardown and opting out
 * send `state=clear` so no stale record outlives the session.
 */
import { writeTerminalSequence } from "@oh-my-pi/pi-tui";
import { truncateLineBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { APP_NAME, isTerminalHeadless, sanitizeText } from "@oh-my-pi/pi-utils";
import { setTerminalTitleState, type TerminalTitleState } from "./title-generator";

/** What a blocked run waits on: an approval prompt or an `ask` question. */
export type BlockedKind = "permission" | "question";

/**
 * The agent's run status, in OSC 7501 terms:
 * - `idle`: at the prompt waiting for an instruction, including after the user interrupts a run;
 * - `working`: running;
 * - `blocked`: waiting on the user; `msg` says for what;
 * - `done`: finished a turn whose result the user has not looked at yet;
 * - `error`: the turn failed; `msg` says why.
 */
export type RunStatus =
	| { readonly state: "idle" | "working" | "done" }
	| { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string }
	| { readonly state: "error"; readonly msg?: string };

const OSC_7501 = "\x1b]7501;";
const ST = "\x1b\\";
/** Removes every record on the terminal: the protocol has no id for the root alone. */
const CLEAR_REPORT = `${OSC_7501}state=clear${ST}`;
/** The protocol's decoded `msg` limit; its base64 form stays within the 2732-byte encoded limit. */
const MSG_MAX_BYTES = 2048;

const runtime: {
	status: RunStatus;
	/** `terminal.programStatus`; off removes the record and stops reporting. */
	enabled: boolean;
	/** Set at teardown so a late transition cannot leave a record in the parent
	 *  shell's terminal. Released only by {@link initProgramStatus}. */
	disposed: boolean;
	/** The report the terminal holds, so a repeated status writes nothing. */
	reported: string | undefined;
} = {
	status: { state: "idle" },
	enabled: true,
	disposed: false,
	reported: undefined,
};

function titleState(status: RunStatus): TerminalTitleState {
	if (status.state === "working") return "working";
	if (status.state === "blocked") return "attention";
	return "idle";
}

/**
 * Base64 of `text` as one line of control-free UTF-8 within the `msg` limit, or
 * undefined when nothing printable remains. A terminal discards the whole
 * report when decoded text holds a control character.
 */
function encodeMsg(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = sanitizeText(text).replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return Buffer.from(truncateLineBytes(line, MSG_MAX_BYTES).text).toString("base64");
}

function formatReport(status: RunStatus): string {
	let body = `state=${status.state}`;
	if (status.state === "blocked") body += `:kind=${status.kind}`;
	body += `:app=${APP_NAME}`;
	const msg = encodeMsg(status.state === "blocked" || status.state === "error" ? status.msg : undefined);
	if (msg) body += `:msg=${msg}`;
	return `${OSC_7501}${body}${ST}`;
}

function report(): void {
	if (runtime.disposed || !runtime.enabled) return;
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const next = formatReport(runtime.status);
	if (next === runtime.reported) return;
	writeTerminalSequence(next);
	runtime.reported = next;
}

function clear(): void {
	if (runtime.reported === undefined) return;
	runtime.reported = undefined;
	writeTerminalSequence(CLEAR_REPORT);
}

/**
 * Publish a run status transition from the interactive event flow: the title
 * separator (`tui.titleState`) and, unless `terminal.programStatus` is off, the
 * OSC 7501 root record.
 */
export function setRunStatus(status: RunStatus): void {
	runtime.status = status;
	setTerminalTitleState(titleState(status));
	report();
}

/** Turn OSC 7501 reporting on or off (`terminal.programStatus`); off removes the record. */
export function setProgramStatusEnabled(enabled: boolean): void {
	runtime.enabled = enabled;
	if (enabled) report();
	else clear();
}

/**
 * Re-send the record after resuming from a suspend: the shell prompt shown
 * meanwhile made the terminal drop `working` and `blocked` records. `done` and
 * `error` survive a prompt, so they are left alone rather than reported twice.
 */
export function resendProgramStatus(): void {
	if (runtime.status.state === "done" || runtime.status.state === "error") return;
	runtime.reported = undefined;
	report();
}

/**
 * Claim the terminal's status record when the UI takes over the terminal: the
 * counterpart to {@link disposeProgramStatus} and the only release of its latch.
 */
export function initProgramStatus(): void {
	runtime.disposed = false;
}

/**
 * Remove omp's record and latch reporting off at UI teardown, before the
 * terminal goes back to the shell. A `done` record would otherwise survive the
 * exit and advertise a result nobody is left to show.
 */
export function disposeProgramStatus(): void {
	clear();
	runtime.disposed = true;
}
