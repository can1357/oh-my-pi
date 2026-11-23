import { logger } from "@oh-my-pi/pi-utils";
import { PowerAssertion, type PowerAssertionOptions } from "@oh-my-pi/pi-natives";

/** A held sleep-prevention assertion; the session only needs to release it. */
export interface PowerAssertionHandle {
	stop(): void;
}

/**
 * Code prefix `PowerAssertion.start` puts on its error message on Linux when the
 * system D-Bus socket does not exist (crates/natives/src/power.rs,
 * `start_login1`), the "platform backend not present" case headless containers
 * hit by design. Refused or rejected connections do not carry it.
 */
const POWER_BACKEND_UNAVAILABLE_CODE = "PowerBackendUnavailable:";

/**
 * Code prefix `PowerAssertion.start` puts on its error message on Linux when a
 * D-Bus call (login1 `Inhibit`) times out: the service is hung, typically for
 * the rest of the process, and every retry would stall the caller for the full
 * native call timeout.
 */
const POWER_BACKEND_UNRESPONSIVE_CODE = "PowerBackendUnresponsive:";

/** Set once the backend is known absent or hung; both are treated as permanent, so stop retrying. */
let powerBackendUnavailable = false;

/**
 * Start a power assertion. A missing platform backend (headless container with
 * no D-Bus) is logged at debug once and never retried; a hung backend warns once
 * and is never retried; any other failure still warns.
 */
export function startPowerAssertion(
	options: PowerAssertionOptions,
	start: (options: PowerAssertionOptions) => PowerAssertionHandle = options => PowerAssertion.start(options),
): PowerAssertionHandle | undefined {
	if (powerBackendUnavailable) return undefined;
	try {
		return start(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith(POWER_BACKEND_UNAVAILABLE_CODE)) {
			powerBackendUnavailable = true;
			logger.debug("Power assertion backend unavailable; sleep prevention disabled", { error: message });
			return undefined;
		}
		if (message.startsWith(POWER_BACKEND_UNRESPONSIVE_CODE)) {
			powerBackendUnavailable = true;
			logger.warn("Power assertion backend unresponsive; sleep prevention disabled", { error: message });
			return undefined;
		}
		logger.warn("Failed to acquire power assertion", { error: String(error) });
		return undefined;
	}
}

/** Test hook: forget that the backend was found unavailable. */
export function resetPowerBackendUnavailableForTests(): void {
	powerBackendUnavailable = false;
}
