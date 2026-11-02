import { logger } from "@oh-my-pi/pi-utils";

/**
 * Attach `onRejected` to `value` when it is a thenable. `then` is read once: the
 * value can come from any code, and a getter can return a method to one read and
 * anything else to the next. A `then` getter that throws throws here.
 */
export function catchRejection(value: unknown, onRejected: (reason: unknown) => void): void {
	if (value == null || (typeof value !== "object" && typeof value !== "function")) return;
	const then: unknown = Reflect.get(value, "then");
	if (typeof then === "function") then.call(value, undefined, onRejected);
}

/**
 * Send a message to a Bun subprocess over IPC, neutralizing both the
 * synchronous throw ("cannot be used after the process has exited") and any
 * asynchronous rejection (EPIPE from a pipe that broke between exit being
 * observed and the next `send()`). The dead worker is detected separately via
 * `onExit`/`onError` and respawned or disabled by the owning client; an
 * un-awaited EPIPE rejection must not escape as a fatal unhandled rejection
 * that takes down the whole session. See issue #2997.
 *
 * `label` prefixes the debug log on synchronous failure (e.g. "tts").
 */
export function safeSend(proc: { send(message: unknown): unknown }, message: unknown, label: string): void {
	try {
		catchRejection(proc.send(message), () => {});
	} catch (error) {
		logger.debug(`${label}: send to subprocess failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
