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
