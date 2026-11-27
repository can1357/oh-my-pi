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

/** Options of {@link writeTerminalSequence}. */
export interface TerminalSequenceOptions {
	/** Resolve whether the bytes reached a terminal (the running driver's output, or stdout's write callback). */
	readonly awaitDelivery?: boolean;
	/** Without a running driver, write only to a TTY stdout (a redirected stdout resolves false). */
	readonly ttyOnly?: boolean;
}

/**
 * Write an out-of-band escape sequence: through the running driver, else
 * straight to stdout (best-effort; a closed stdout never throws into the
 * caller). A worker thread cannot reach the main thread's driver and would
 * write around its frames, so off the main thread nothing is written.
 *
 * With `awaitDelivery` it resolves true once the bytes reached the running
 * driver's output, or once stdout's write callback reports no error. It
 * resolves false off the main thread, when stdout is closed or fails, and,
 * with `ttyOnly`, when stdout is not a TTY. Delivery is not the terminal
 * acting on the bytes. `ttyOnly` never bypasses a running driver.
 */
export function writeTerminalSequence(data: string): void;
export function writeTerminalSequence(
	data: string,
	options: TerminalSequenceOptions & { readonly awaitDelivery: true },
): Promise<boolean>;
export function writeTerminalSequence(data: string, options?: TerminalSequenceOptions): void | Promise<boolean>;
export function writeTerminalSequence(data: string, options?: TerminalSequenceOptions): void | Promise<boolean> {
	const awaited = options?.awaitDelivery === true;
	if (!Bun.isMainThread) return awaited ? Promise.resolve(false) : undefined;
	if (active) {
		if (!awaited) {
			active.writeRaw(data);
			return;
		}
		try {
			return Promise.resolve(active.writeRaw(data));
		} catch {
			return Promise.resolve(false);
		}
	}
	if (options?.ttyOnly && !process.stdout.isTTY) return awaited ? Promise.resolve(false) : undefined;
	// An `error` listener keeps EPIPE/EIO on a closed stdout from crashing the process.
	if (!stdoutErrorsHandled) {
		stdoutErrorsHandled = true;
		process.stdout.on("error", () => {});
	}
	if (!awaited) {
		try {
			process.stdout.write(data);
		} catch {
			// Best-effort.
		}
		return;
	}
	const { promise, resolve } = Promise.withResolvers<boolean>();
	// A failed write reports through its callback, the stream's `error` event, or both.
	const onError = (): void => {
		process.stdout.off("error", onError);
		resolve(false);
	};
	process.stdout.on("error", onError);
	try {
		process.stdout.write(data, error => {
			process.stdout.off("error", onError);
			resolve(!error);
		});
	} catch {
		process.stdout.off("error", onError);
		resolve(false);
	}
	return promise;
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
