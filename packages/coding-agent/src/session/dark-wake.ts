/**
 * macOS wakes a lid-closed machine briefly for Power Nap and maintenance
 * ("DarkWake") with CPU and network but no graphics. Requests sent then stall
 * once the machine sleeps again, and each retry re-writes the prompt cache.
 * `pmset -g systemstate` lists the current capabilities; a full wake includes
 * `Graphics`.
 */
import { logger, sleepLong } from "@oh-my-pi/pi-utils";

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

/**
 * Whether the machine is in a macOS dark wake now. Any other platform, or a failed
 * or slow read, reads as awake. Timeout and abort kill `pmset`, so no probe outlives its wait.
 */
async function isDarkWake(signal: AbortSignal): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		const child = Bun.spawn(["pmset", "-g", "systemstate"], {
			stdout: "pipe",
			stderr: "ignore",
			timeout: PMSET_TIMEOUT_MS,
			signal,
		});
		const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return exitCode === 0 && isDarkWakeSystemState(output);
	} catch {
		return false;
	}
}

export interface FullWakeWaitDeps {
	probe: (signal: AbortSignal) => Promise<boolean>;
	pollMs: number;
}

/** Settles with `probe`, or rejects as soon as `signal` aborts even while the probe is pending. */
async function probeUnlessAborted(deps: FullWakeWaitDeps, signal: AbortSignal): Promise<boolean> {
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([deps.probe(signal), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

const SYSTEM_DEPS: FullWakeWaitDeps = { probe: isDarkWake, pollMs: DARK_WAKE_POLL_MS };

/**
 * Resolves once the machine is not in a dark wake, rechecking every `pollMs`.
 * Rejects when `signal` aborts, including during a probe.
 */
export async function waitForFullWake(signal: AbortSignal, deps: FullWakeWaitDeps = SYSTEM_DEPS): Promise<void> {
	signal.throwIfAborted();
	for (let held = false; ; held = true) {
		const dark = await probeUnlessAborted(deps, signal);
		if (!dark) {
			if (held) logger.warn("System fully woke; resuming the held retry");
			return;
		}
		if (!held) logger.warn("Holding the retry until the system fully wakes from a dark wake");
		await sleepLong(deps.pollMs, signal);
	}
}
