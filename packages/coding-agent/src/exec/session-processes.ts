/**
 * Processes a session's bash tool calls left running after the calls returned.
 *
 * Every bash tool run carries {@link BASH_SESSION_ENV}`=`{@link bashSessionTag}: the session
 * id plus the pid of the omp process that ran the call. Descendants inherit it across
 * reparenting and `setsid`, so the environment is the membership test (`cmd &`, `(cmd &)`,
 * `nohup cmd &`), together with the externals the session's shells hold (macOS hides the
 * environment of Apple-signed binaries). The pid decides ownership ({@link ownedTagged}):
 * another live omp opening the same session id (`omp render` on a copy of a live session, a
 * second resume) never sees, reminds about, or reaps the processes of the one running it,
 * while the orphans of an omp that is gone (crashed or killed before its session-end reap)
 * pass to the process resuming the session. Only roots are reported: a member whose parent is
 * not a member. Their descendants belong to them.
 */
import {
	type HeldProcess,
	killProcessFamily,
	listProcessesWithEnvPrefix,
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
 * Leftover roots of the processes tagged with `sessionId` that this omp process owns
 * ({@link ownedTagged}) plus `held` (externals the session's
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
	const procs = ownedTagged(sessionId, listProcessesWithEnvPrefix(BASH_SESSION_ENV, `${sessionId}@`));
	const seen = new Set(procs.map(proc => proc.pid));
	const unseen = held.filter(proc => !seen.has(proc.pid)).map(proc => proc.pid);
	if (unseen.length > 0) procs.push(...processInfo(unseen));
	const detached = new Set(held.filter(proc => proc.detached).map(proc => proc.pid));
	return leftoverRoots(procs, new Set(excludedPids), detached);
}

/**
 * The processes of `tagged` (scanned for `sessionId`'s tag prefix) this omp process owns: those
 * its own bash calls tagged, and those whose tagging omp is gone. A tag's owner is live while a
 * process holds its pid that started no later than the tagged process; one started after it took
 * a reused pid. `lookup` resolves the owner pids ({@link processInfo}).
 */
export function ownedTagged(
	sessionId: string,
	tagged: readonly TaggedProcess[],
	lookup: (pids: number[]) => TaggedProcess[] = processInfo,
): TaggedProcess[] {
	const prefix = `${sessionId}@`;
	const ownerOf = (proc: TaggedProcess): number | undefined => {
		const owner = proc.envValue?.startsWith(prefix) ? proc.envValue.slice(prefix.length) : "";
		return /^[1-9]\d*$/.test(owner) ? Number(owner) : undefined;
	};
	const foreign = new Set<number>();
	for (const proc of tagged) {
		const owner = ownerOf(proc);
		if (owner !== undefined && owner !== process.pid) foreign.add(owner);
	}
	const holders = new Map(foreign.size > 0 ? lookup([...foreign]).map(proc => [proc.pid, proc]) : []);
	return tagged.filter(proc => {
		const owner = ownerOf(proc);
		if (owner === undefined) return false;
		if (owner === process.pid) return true;
		const holder = holders.get(owner);
		return holder === undefined || holder.startedAt > proc.startedAt;
	});
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
	/** Real ppids for pids missing from `tagged` (macOS hides the env of Apple-signed binaries). */
	const realPpids = new Map<number, number>();
	const lookupPpid = (pid: number): number => {
		if (byPid.has(pid)) return byPid.get(pid)!.ppid;
		if (!realPpids.has(pid)) realPpids.set(pid, processInfo([pid])[0]?.ppid ?? 0);
		return realPpids.get(pid)!;
	};
	// The root above an excluded pid owns it: killing that root's family would take it down.
	const excludedRoots = new Set<number>();
	for (const pid of excluded) {
		let top: number | undefined;
		for (let cur = pid; cur > 1; cur = lookupPpid(cur)) {
			if (byPid.has(cur)) top = cur;
			if (lookupPpid(cur) === cur) break;
		}
		if (top !== undefined) excludedRoots.add(top);
	}
	const excludedSet = new Set(excluded);
	/** A tagged process is under an excluded pid when its real parent chain reaches one: the
	 * env scan misses Apple-signed intermediates (macOS), so the tagged chain alone is not enough. */
	const underExcluded = (proc: TaggedProcess): boolean => {
		for (let cur = proc.ppid; cur > 1; cur = lookupPpid(cur)) {
			if (excludedSet.has(cur) || lookupPpid(cur) === cur) return excludedSet.has(cur);
		}
		return false;
	};
	const roots: LeftoverProcess[] = [];
	for (const proc of tagged) {
		if (byPid.has(proc.ppid) || excludedRoots.has(proc.pid) || underExcluded(proc)) continue;
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
