import { logger } from "@oh-my-pi/pi-utils";

/**
 * Narrow a value to a thenable so a rejection handler can be attached.
 *
 * Mirrors the local helper in `mcp/transports/stdio.ts` (kept separate because
 * that copy serves the FileSink stdin-write path and is battle-tested there).
 * This shared copy is the home for the IPC `send()` sites.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
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
		const result = proc.send(message);
		if (isThenable(result)) result.then(undefined, () => {});
	} catch (error) {
		logger.debug(`${label}: send to subprocess failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
