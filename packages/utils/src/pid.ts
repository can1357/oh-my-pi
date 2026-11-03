import { $ } from "bun";

/**
 * Signal-0 liveness probe: true unless the OS reports the pid as gone
 * (`ESRCH`) or invalid (`EINVAL`). Any other failure, notably `EPERM` (alive
 * but owned by another user), reads as alive, so callers never reclaim a
 * resource a live process may still hold. Unlike `procmgr.isPidRunning`, this
 * does not consult the process table's run state.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

/**
 * Boot-stable start-time token for `pid`, or `null` when the process is gone or
 * the platform cannot report it. Read from the same source on write and
 * validate so an exact string compare rejects a recycled pid.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot); other Unixes shell out to `ps -o lstart`. Platforms that report
 * neither (e.g. Windows) yield `null`, degrading to a pid-only liveness check.
 */
export async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may embed spaces and parens, so parse the numeric
		// fields after the final ')'. `starttime` is field 22 overall, i.e. the
		// 20th token once `pid` and `(comm)` are dropped.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}
