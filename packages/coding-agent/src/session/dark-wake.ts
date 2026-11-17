/**
 * macOS wakes a lid-closed machine briefly for Power Nap and maintenance
 * ("DarkWake") with CPU and network but no graphics. Requests sent then stall
 * once the machine sleeps again, and each retry re-writes the prompt cache.
 * `pmset -g systemstate` lists the current capabilities; a full wake includes
 * `Graphics`.
 */
import { logger, sleepLong, withTimeout } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

/** Line of `pmset -g systemstate` that lists the current capabilities. */
const CAPABILITIES_PREFIX = "Current System Capabilities are:";
const PMSET_TIMEOUT_MS = 5_000;
const DARK_WAKE_POLL_MS = 5_000;

/** True when `pmset -g systemstate` output describes a wake without graphics. */
export function isDarkWakeSystemState(output: string): boolean {
	const line = output.split("\n").find(entry => entry.startsWith(CAPABILITIES_PREFIX));
	if (line === undefined) return false;
	const capabilities = line.slice(CAPABILITIES_PREFIX.length).trim().split(/\s+/);
	return capabilities.includes("CPU") && !capabilities.includes("Graphics");
}

/** Whether the machine is in a macOS dark wake now. Any other platform, or a failed or slow read, reads as awake. */
async function isDarkWake(): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		const result = await withTimeout($`pmset -g systemstate`.quiet().nothrow(), PMSET_TIMEOUT_MS, "pmset timed out");
		return result.exitCode === 0 && isDarkWakeSystemState(result.text());
	} catch {
		return false;
	}
}

export interface FullWakeWaitDeps {
	probe: () => Promise<boolean>;
	pollMs: number;
}

const SYSTEM_DEPS: FullWakeWaitDeps = { probe: isDarkWake, pollMs: DARK_WAKE_POLL_MS };

/**
 * Resolves once the machine is not in a dark wake, rechecking every `pollMs`.
 * Rejects when `signal` aborts, including during a probe.
 */
export async function waitForFullWake(signal: AbortSignal, deps: FullWakeWaitDeps = SYSTEM_DEPS): Promise<void> {
	signal.throwIfAborted();
	for (let held = false; ; held = true) {
		const dark = await deps.probe();
		signal.throwIfAborted();
		if (!dark) {
			if (held) logger.warn("System fully woke; resuming the held retry");
			return;
		}
		if (!held) logger.warn("Holding the retry until the system fully wakes from a dark wake");
		await sleepLong(deps.pollMs, signal);
	}
}
