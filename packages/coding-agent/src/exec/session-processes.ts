/**
 * Processes a session's bash tool calls left running after the calls returned.
 *
 * Every bash tool run carries {@link BASH_SESSION_ENV}`=`{@link bashSessionTag}: the session
 * id plus the pid of the omp process that ran the call. Descendants inherit it across
 * reparenting and `setsid`, so the environment is the membership test (`cmd &`, `(cmd &)`,
 * `nohup cmd &`), together with the externals the session's shells hold (macOS hides the
 * environment of Apple-signed binaries). The pid keeps the test to this process: another omp
 * opening the same session id (`omp render` on a copy of a live session, a second resume)
 * never sees, reminds about, or reaps the processes of the one running it. Only roots are
 * reported: a member whose parent is not a member. Their descendants belong to them.
 */
import {
	type HeldProcess,
	killProcessFamily,
	listProcessesWithEnv,
	processInfo,
	type TaggedProcess,
} from "@oh-my-pi/pi-natives";

/** Environment variable naming the agent session whose bash tool call started a process. */
export const BASH_SESSION_ENV = "OMP_BASH_SESSION";

/**
 * {@link BASH_SESSION_ENV} value for the processes this omp process's bash calls start under
 * `sessionId`; empty when there is no session.
 */
export function bashSessionTag(sessionId: string): string {
	return sessionId ? `${sessionId}@${process.pid}` : "";
}

/** A leftover root: `nohup` when it ignores SIGHUP, else `&`. */
export interface LeftoverProcess {
	pid: number;
	command: string;
	/** ms since the epoch */
	startedAt: number;
	kind: "&" | "nohup";
}

/**
 * Leftover roots of the processes this omp process's bash calls tagged with `sessionId`
 * ({@link bashSessionTag}) plus `held` (externals the session's
 * shells hold: macOS hides the env of platform binaries, so the tag scan misses
 * `/bin/sleep 9 &`), minus the roots holding one of `excludedPids` (running bash calls,
 * service units) in their tree. A held process the shell's `nohup` started is `nohup` even
 * though that `nohup` leaves SIGHUP unmasked.
 */
export function listLeftoverProcesses(
	sessionId: string,
	held: readonly HeldProcess[],
	excludedPids: Iterable<number>,
): LeftoverProcess[] {
	if (!sessionId) return [];
	const procs = listProcessesWithEnv(BASH_SESSION_ENV, bashSessionTag(sessionId));
	const seen = new Set(procs.map(proc => proc.pid));
	const unseen = held.filter(proc => !seen.has(proc.pid)).map(proc => proc.pid);
	if (unseen.length > 0) procs.push(...processInfo(unseen));
	const detached = new Set(held.filter(proc => proc.detached).map(proc => proc.pid));
	return leftoverRoots(procs, new Set(excludedPids), detached);
}

/**
 * Tagged roots of `tagged` neither in `excluded` nor descended (within `tagged`) from it; a
 * root is `nohup` when it ignores SIGHUP or is in `detached`.
 */
export function leftoverRoots(
	tagged: readonly TaggedProcess[],
	excluded: ReadonlySet<number>,
	detached: ReadonlySet<number> = new Set(),
): LeftoverProcess[] {
	const byPid = new Map(tagged.map(proc => [proc.pid, proc]));
	// The root above an excluded pid owns it: killing that root's family would take it down.
	const excludedRoots = new Set<number>();
	for (const pid of excluded) {
		let proc = byPid.get(pid);
		for (let parent = proc && byPid.get(proc.ppid); parent; parent = byPid.get(parent.ppid)) proc = parent;
		if (proc) excludedRoots.add(proc.pid);
	}
	const roots: LeftoverProcess[] = [];
	for (const proc of tagged) {
		if (byPid.has(proc.ppid) || excludedRoots.has(proc.pid)) continue;
		roots.push({
			pid: proc.pid,
			command: proc.command,
			startedAt: proc.startedAt,
			kind: proc.ignoresHangup || detached.has(proc.pid) ? "nohup" : "&",
		});
	}
	return roots;
}

/**
 * SIGKILLs the families of the `&` leftovers; `nohup`'d processes and everything under them
 * survive. Returns the number of processes signalled.
 */
export function killLeftoverProcesses(leftovers: readonly LeftoverProcess[]): number {
	const pids = leftovers.filter(proc => proc.kind === "&").map(proc => proc.pid);
	if (pids.length === 0) return 0;
	return killProcessFamily(pids, { spareHangupIgnoring: true });
}
