import { ptree } from "@oh-my-pi/pi-utils";

/**
 * Wall-clock ceiling for a best-effort host probe.
 *
 * WSL→Windows interop can wedge indefinitely (issue #8402). A probe only ever
 * augments the result with an extra candidate — the host home, or the Windows
 * path an opener needs — so a few hundred milliseconds is a generous ceiling:
 * past it the host counts as unavailable and the caller falls back to the
 * Linux paths.
 */
const PROBE_TIMEOUT_MS = 500;

/**
 * Run a best-effort probe and return its trimmed stdout, or `undefined` when
 * the command fails, produces no output, or exceeds the timeout.
 *
 * `ptree.exec` owns the wall-clock bound: at the deadline it kills the whole
 * process group and cancels the pending pipe readers, so neither a wedged
 * interop pipe nor a descendant that inherited stdout can hold the read open
 * past `timeoutMs` (issue #8402). The killed/non-zero/blank outcomes all report
 * "unavailable", and the caller falls back to the Linux candidates.
 *
 * This is the single entry point for startup probes — the host-discovery
 * probes in `discovery/agents.ts` and the WSL path conversion in
 * `utils/open.ts` share it instead of forking their own spawn/timeout logic.
 */
export async function runBoundedProbe(cmd: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
	try {
		const result = await ptree.exec(cmd, {
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: true,
		});
		if (!result.ok || result.exitError?.aborted) return undefined;
		const stdout = result.stdout.trim();
		return stdout.length > 0 ? stdout : undefined;
	} catch {
		return undefined;
	}
}
