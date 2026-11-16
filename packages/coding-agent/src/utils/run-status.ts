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
import { setPromptZonesEnabled } from "@oh-my-pi/pi-tui/chat/user-message";
import { truncateLineBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { APP_NAME, isTerminalHeadless, sanitizeText } from "@oh-my-pi/pi-utils";
import { setTerminalTitleState, type TerminalTitleState } from "./title-generator";

/** What a blocked run waits on: an approval (`permission`) or an answer (`question`). */
export type BlockedKind = "permission" | "question";

/** A dialog waiting on the user; `msg` says for what. */
export type BlockedStatus = { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string };

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
	| BlockedStatus
	| { readonly state: "error"; readonly msg?: string };

/** The run's own status, as the event flow reports it; `blocked` comes only from open dialogs. */
export type RunFlowStatus = Exclude<RunStatus, BlockedStatus>;

const OSC_7501 = "\x1b]7501;";
const ST = "\x1b\\";
/** Removes every record on the terminal: the protocol has no id for the root alone. */
const CLEAR_REPORT = `${OSC_7501}state=clear${ST}`;
/** The protocol's decoded `msg` limit; its base64 form stays within the 2732-byte encoded limit. */
const MSG_MAX_BYTES = 2048;

const runtime: {
	/** The event flow's status, set by {@link setRunStatus}. */
	status: RunFlowStatus;
	/** Open dialogs' holds from {@link holdBlockedStatus}, newest last. */
	dialogs: BlockedStatus[];
	/** `terminal.programStatus`; off removes the record and stops reporting. */
	enabled: boolean;
	/** True only after a terminal confirms OSC 7501 with a feature-query reply. */
	supported: boolean;
	/** Set at teardown so a late transition cannot leave a record in the parent
	 *  shell's terminal. Released only by {@link initProgramStatus}. */
	disposed: boolean;
	/** The report the terminal holds, so a repeated status writes nothing. */
	reported: string | undefined;
	/** The `working` status a command-line prompt holds from startup until its run reports. */
	startup: RunFlowStatus | undefined;
} = {
	status: { state: "idle" },
	dialogs: [],
	enabled: true,
	supported: false,
	disposed: false,
	reported: undefined,
	startup: undefined,
};

/** What every surface shows: the newest open dialog, else the event flow's status. */
function shownStatus(): RunStatus {
	return runtime.dialogs.at(-1) ?? runtime.status;
}

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
	const next = formatReport(shownStatus());
	if (next === runtime.reported) return;
	writeTerminalSequence(next);
	runtime.reported = next;
}

function publish(): void {
	setTerminalTitleState(titleState(shownStatus()));
	report();
	syncPromptZones();
}

function clear(): void {
	if (runtime.reported === undefined) return;
	runtime.reported = undefined;
	writeTerminalSequence(CLEAR_REPORT);
}

/**
 * Keep OSC 133 prompt marks off the screen while a confirmed OSC 7501 receiver
 * holds a `working` or `blocked` record: a mark drops it on every redraw
 * (#17307). Unknown terminals keep their prompt navigation.
 */
function syncPromptZones(): void {
	const { state } = shownStatus();
	const hasDroppableRecord =
		runtime.reported !== undefined && runtime.supported && (state === "working" || state === "blocked");
	setPromptZonesEnabled(!hasDroppableRecord);
}

/**
 * Publish a run status transition from the interactive event flow: the title
 * separator (`tui.titleState`) and, unless `terminal.programStatus` is off, the
 * OSC 7501 root record. While a dialog is open, it shows instead.
 */
export function setRunStatus(status: RunFlowStatus): void {
	runtime.status = status;
	publish();
}

/**
 * Show the run as `blocked` while a dialog waits on the user, whatever the event
 * flow reports meanwhile: a run that ends under an open dialog still waits on
 * the user. The returned release drops the hold, and the surfaces show the next
 * open dialog, else the event flow's current status.
 */
export function holdBlockedStatus(status: BlockedStatus): () => void {
	const hold = { ...status };
	runtime.dialogs.push(hold);
	publish();
	return () => {
		const index = runtime.dialogs.indexOf(hold);
		if (index === -1) return;
		runtime.dialogs.splice(index, 1);
		publish();
	};
}

/** Turn OSC 7501 reporting on or off (`terminal.programStatus`); off removes the record. */
export function setProgramStatusEnabled(enabled: boolean): void {
	runtime.enabled = enabled;
	if (enabled) report();
	else clear();
	syncPromptZones();
}

/** Update prompt-zone rendering when the terminal's OSC 7501 probe resolves. */
export function setProgramStatusSupported(supported: boolean): void {
	runtime.supported = supported;
	syncPromptZones();
}

/**
 * Re-send the record after resuming from a suspend: the shell prompt shown
 * meanwhile made the terminal drop `working` and `blocked` records. `done` and
 * `error` survive a prompt, so they are left alone rather than reported twice.
 */
export function resendProgramStatus(): void {
	const { state } = shownStatus();
	if (state === "done" || state === "error") return;
	runtime.reported = undefined;
	report();
}

/**
 * Claim the terminal's status record when the UI takes over the terminal: the
 * counterpart to {@link disposeProgramStatus} and the only release of its latch.
 * A UI starts with no dialog open, so holds left by a previous one are dropped.
 *
 * `startupRun` marks a command-line prompt that runs once startup ends: the
 * first report is then `working`, not the `idle` that a supervisor waiting on
 * this terminal would take as "finished" before the prompt even starts.
 * {@link settleStartupRun} ends that hold.
 */
export function initProgramStatus(options?: { startupRun?: boolean }): void {
	runtime.disposed = false;
	runtime.dialogs.length = 0;
	runtime.startup = undefined;
	runtime.supported = false;
	if (options?.startupRun) {
		runtime.startup = { state: "working" };
		runtime.status = runtime.startup;
		// Not `setRunStatus`: the record waits for `setProgramStatusEnabled`, but the title follows now.
		setTerminalTitleState(titleState(shownStatus()));
	}
	syncPromptZones();
}

/**
 * End the startup hold once the command-line prompts are dispatched. A prompt
 * that ran reported its own status, which stays; one that failed or ran no turn
 * leaves the startup `working`, which goes back to `idle`.
 */
export function settleStartupRun(): void {
	const startup = runtime.startup;
	runtime.startup = undefined;
	if (startup && runtime.status === startup) setRunStatus({ state: "idle" });
}

/**
 * Remove omp's record and latch reporting off at UI teardown, before the
 * terminal goes back to the shell. A `done` record would otherwise survive the
 * exit and advertise a result nobody is left to show.
 */
export function disposeProgramStatus(): void {
	clear();
	runtime.disposed = true;
	runtime.supported = false;
	syncPromptZones();
}
