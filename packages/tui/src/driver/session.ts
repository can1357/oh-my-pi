/**
 * The process's terminal, for code that has no driver in hand: out-of-band
 * escape sequences (title, OSC 52 clipboard, shell integration), desktop
 * notifications, identity/capability lookups, and the crash-path restore.
 *
 * A started {@link ProcessTerminalDriver} claims the terminal until it stops.
 * While one does, sequences take its ordered output path, so they can never
 * land inside a frame's escape sequence; without one they go straight to
 * stdout and identity comes from the environment.
 */
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { restoreTerminalStderr } from "@oh-my-pi/pi-utils/stderr-guard";
import { type DetectedTerminal, detectTerminal } from "./caps/detect";
import type { TerminalCapabilities } from "./contract";
import type { ProcessTerminalDriver } from "./index";
import type { TerminalIdentity } from "./io";
import { sendNotification, type TerminalNotification } from "./notify";

let active: ProcessTerminalDriver | null = null;
let restore: (() => Promise<void>) | undefined;
let restoreRegistered = false;
let detected: DetectedTerminal | undefined;
let stdoutErrorsHandled = false;

/** Record `driver` as the terminal's owner (its `start`). */
export function claimTerminal(driver: ProcessTerminalDriver, restoreOwner: () => Promise<void>): void {
	active = driver;
	restore = restoreOwner;
	if (restoreRegistered) return;
	restoreRegistered = true;
	// Only the actual exit event cannot await replies. Signals and fatal errors
	// still have an event loop: hand the terminal back before printing the report.
	postmortem.register("terminal-restore", reason =>
		reason === postmortem.Reason.EXIT ? emergencyTerminalRestore() : restore?.(),
	);
}

/** Release ownership if `driver` holds it (its `stop`). */
export function releaseTerminal(driver: ProcessTerminalDriver): void {
	if (active === driver) {
		active = null;
		restore = undefined;
	}
}

/** The started driver that owns the terminal in this thread, if any. */
export function activeTerminalDriver(): ProcessTerminalDriver | null {
	return active;
}

function environmentTerminal(): DetectedTerminal {
	detected ??= detectTerminal(Bun.env, { platform: process.platform });
	return detected;
}

/** The terminal's identity: the running driver's (probes included), else what the environment says. */
export function terminalIdentity(): TerminalIdentity {
	return active?.identity ?? environmentTerminal().identity;
}

/** The terminal's capabilities: the running driver's, else the environment's pre-probe defaults. */
export function terminalCapabilities(): TerminalCapabilities {
	return active?.capabilities ?? environmentTerminal().capabilities;
}

/**
 * Write an out-of-band escape sequence: through the running driver, else
 * straight to stdout (best-effort; a closed stdout never throws into the
 * caller). A worker thread cannot reach the main thread's driver and would
 * write around its frames, so off the main thread nothing is written.
 */
export function writeTerminalSequence(data: string): void {
	if (!Bun.isMainThread) return;
	if (active) {
		active.writeRaw(data);
		return;
	}
	// An `error` listener keeps EPIPE/EIO on a closed stdout from crashing the process.
	if (!stdoutErrorsHandled) {
		stdoutErrorsHandled = true;
		process.stdout.on("error", () => {});
	}
	try {
		process.stdout.write(data);
	} catch {
		// Best-effort.
	}
}

/** Raise a desktop notification through the terminal (see `notify.ts`). */
export function notifyTerminal(message: string | TerminalNotification): void {
	if (active) {
		active.notify(message);
		return;
	}
	const { notify, richNotifications } = environmentTerminal().identity;
	sendNotification(message, { protocol: notify, rich: richNotifications, env: Bun.env, write: writeTerminalSequence });
}

/**
 * Hand the terminal back from a crash or hard-exit path without awaiting
 * anything: stderr goes back to the terminal (fatal reports must show), and
 * the running driver restores screen, cursor, input modes and raw mode.
 * Registered with postmortem once a driver has started.
 */
export function emergencyTerminalRestore(): void {
	try {
		active?.restoreNow();
	} catch {
		// The terminal may already be gone.
	} finally {
		restoreTerminalStderr();
	}
}
