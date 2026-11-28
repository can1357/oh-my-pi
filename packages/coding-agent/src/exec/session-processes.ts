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
	const excluded = new Set(excludedPids);
	// Real ppids for pids the env scan misses (macOS hides the env of Apple-signed binaries),
	// resolved in batched snapshots so the walk costs a couple of scans, not one per ancestor.
	const realPpids = new Map<number, number>();
	if (excluded.size > 0) {
		const known = new Map(procs.map(proc => [proc.pid, proc.ppid]));
		const attempted = new Set<number>();
		let frontier = new Set<number>(excluded);
		for (const ppid of known.values()) if (ppid > 1 && !known.has(ppid)) frontier.add(ppid);
		while (frontier.size > 0) {
			frontier = new Set([...frontier].filter(pid => !attempted.has(pid)));
			for (const pid of frontier) attempted.add(pid);
			for (const proc of processInfo([...frontier])) {
				known.set(proc.pid, proc.ppid);
				realPpids.set(proc.pid, proc.ppid);
				if (proc.ppid > 1 && proc.ppid !== proc.pid && !known.has(proc.ppid)) frontier.add(proc.ppid);
			}
		}
	}
	return leftoverRoots(procs, excluded, detached, realPpids);
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
 * root is `nohup` when it ignores SIGHUP or is in `detached`. `realPpids` carries ppids for
 * pids missing from `tagged` (macOS hides the env of Apple-signed binaries); without it the
 * excluded-ancestor checks only see the tagged chain. Pure: all lookups happen up front.
 */
export function leftoverRoots(
	tagged: readonly TaggedProcess[],
	excluded: ReadonlySet<number>,
	detached: ReadonlySet<number> = new Set(),
	realPpids: ReadonlyMap<number, number> = new Map(),
): LeftoverProcess[] {
	const byPid = new Map(tagged.map(proc => [proc.pid, proc]));
	/** Real ppid of `pid`: the tagged entry when present, else the pre-resolved snapshot. */
	const ppidOf = (pid: number): number => byPid.get(pid)?.ppid ?? realPpids.get(pid) ?? 0;
	const roots: LeftoverProcess[] = [];
	if (excluded.size === 0) {
		for (const proc of tagged) {
			if (byPid.has(proc.ppid)) continue;
			roots.push({
				pid: proc.pid,
				command: proc.command,
				startedAt: proc.startedAt,
				kind: proc.ignoresHangup || detached.has(proc.pid) ? "nohup" : "&",
			});
		}
		return roots;
	}
	// The root above an excluded pid owns it: killing that root's family would take it down.
	const excludedRoots = new Set<number>();
	for (const pid of excluded) {
		let top: number | undefined;
		for (let cur = pid; cur > 1; cur = ppidOf(cur)) {
			if (byPid.has(cur)) top = cur;
			if (ppidOf(cur) === cur) break;
		}
		if (top !== undefined) excludedRoots.add(top);
	}
	/** A tagged process is under an excluded pid when its real parent chain reaches one: the
	 * env scan misses Apple-signed intermediates (macOS), so the tagged chain alone is not enough. */
	const underExcluded = (proc: TaggedProcess): boolean => {
		for (let cur = proc.ppid; cur > 1; cur = ppidOf(cur)) {
			if (excluded.has(cur) || ppidOf(cur) === cur) return excluded.has(cur);
		}
		return false;
	};
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
