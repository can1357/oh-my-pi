import { logger, sleepLong } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

/**
 * macOS wakes a lid-closed machine briefly for Power Nap and maintenance
 * ("DarkWake") with CPU and network but no graphics. Requests sent then stall
 * once the machine sleeps again, and each retry re-writes the prompt cache.
 * `pmset -g systemstate` lists the current capabilities; a full wake includes
 * `Graphics`.
 */
const CAPABILITIES_PREFIX = "Current System Capabilities are:";

/** How often a held retry rechecks for a full wake. */
export const DARK_WAKE_POLL_MS = 30_000;

/** True when `pmset -g systemstate` output describes a wake without graphics. */
export function isDarkWakeSystemState(output: string): boolean {
	const line = output.split("\n").find(entry => entry.startsWith(CAPABILITIES_PREFIX));
	if (line === undefined) return false;
	const capabilities = line.slice(CAPABILITIES_PREFIX.length).trim().split(/\s+/);
	return capabilities.includes("CPU") && !capabilities.includes("Graphics");
}

/** Whether the machine is in a macOS dark wake now. Any other platform, or a failed read, reads as awake. */
export async function isDarkWake(): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	const result = await $`pmset -g systemstate`.quiet().nothrow();
	if (result.exitCode !== 0) return false;
	return isDarkWakeSystemState(result.text());
}

/**
 * Resolves once the machine is not in a dark wake, rechecking every `pollMs`.
 * Rejects when `signal` aborts.
 */
export async function waitForFullWake(
	signal: AbortSignal,
	probe: () => Promise<boolean> = isDarkWake,
	pollMs = DARK_WAKE_POLL_MS,
): Promise<void> {
	signal.throwIfAborted();
	if (!(await probe())) return;
	logger.info("Holding the retry until the system fully wakes from a dark wake");
	do {
		await sleepLong(pollMs, signal);
	} while (await probe());
}
