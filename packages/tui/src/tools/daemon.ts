/** Daemon unit types shared by the daemon, its clients, `proc://`, and `omp ps`. */

/** Stable lifecycle states of a unit. */
export type DaemonState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";

/** Restart behavior applied after an unexpected unit exit. */
export type DaemonRestartPolicy = "no" | "on-failure" | "always";

/** Readiness conditions; every configured condition must pass. */
export interface DaemonReadySpec {
	log?: string;
	port?: number;
	host?: string;
	timeoutMs: number;
}

/** Where a unit belongs on the board. Scope is a label on the unit, never a separate daemon. */
export type UnitScope = { kind: "global" } | { kind: "project"; dir: string } | { kind: "session"; id: string };

/**
 * What keeps a unit alive and what happens when nothing does.
 *
 * The idle timer runs while the unit has no lease and reports no in-flight work.
 */
export interface UnitPolicy {
	/** `leases`: lives while a client holds a lease (plus `idleMs`); `persist`: until stopped; `detached`: until stopped, in its own session. */
	hold: "leases" | "persist" | "detached";
	/** Grace after the last lease and in-flight request end; 0 stops immediately. Ignored unless `hold` is `leases`. */
	idleMs: number;
	/** `flush-stop` lets the unit save state before it is stopped. */
	onIdle: "stop" | "flush-stop";
	/** Most live units of this kind per scope; the least recently used unleased one is evicted. */
	cap?: number;
	restart: DaemonRestartPolicy;
	/**
	 * How the unit crosses a daemon restart. `exec`: stdio is raw fds the daemon
	 * keeps across an in-place re-exec (dies with a daemon crash). `detached`:
	 * output goes to its log file and it is re-adopted by pid after a crash too.
	 * `none`: stopped before the daemon is replaced.
	 */
	survive: "exec" | "detached" | "none";
}

/** Launch specification of a process unit, retained for restart and inspection. */
export interface ProcSpec {
	application: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pty: boolean;
	ready?: DaemonReadySpec;
	/** Regex; the daemon reports each matching output line to the owner while the unit runs. */
	notify?: string;
}

/** Serializable unit state: one row of the board. */
export interface UnitSnapshot {
	/** Daemon-assigned id, stable for the unit's lifetime across restarts of its process. */
	id: string;
	/** `proc` for supervised commands, a module kind (`lsp`, `disasm`, `blob`, `infer`, `speech`, `predict`), or `external` for registered session children. */
	kind: string;
	scope: UnitScope;
	/** Identity within `(kind, scope)`; the service name for `proc` units. */
	key: string;
	/** Human label for the board. */
	label: string;
	/** Changes on every (re)launch; lets `stop` target one generation. */
	generation: string;
	state: DaemonState;
	/** Every process the unit owns, main one first. */
	pids: number[];
	createdAt: number;
	startedAt: number;
	readyAt?: number;
	exitedAt?: number;
	exitCode?: number;
	exitReason?: string;
	restartCount: number;
	outputBytes: number;
	owner?: string;
	readyMatch?: string;
	/** Readiness conditions still unmet while `state` is `starting`. */
	readyPending?: ("log" | "port")[];
	/** Leases currently held on the unit. */
	leases: number;
	/** When the idle policy will stop the unit; absent while leased, busy, or not lease-held. */
	idleAt?: number;
	policy: UnitPolicy;
	/** Launch command for display; absent for units without a process. */
	command?: string;
	cwd?: string;
	/** False for `external` units and re-adopted detached units the daemon cannot wait on. */
	supervised: boolean;
}

/**
 * A service snapshot of the launch broker the daemon replaced: what `launch-completion` messages
 * and `proc://` results persisted in sessions written before {@link UnitSnapshot}.
 */
export interface BrokerSnapshot {
	name: string;
	id: string;
	state: DaemonState;
	pid?: number;
	createdAt: number;
	startedAt: number;
	exitedAt?: number;
	exitCode?: number;
	persist: boolean;
	detached: boolean;
}

/** A service snapshot read back from session history, written by either generation. */
export type PersistedSnapshot = UnitSnapshot | BrokerSnapshot;

/** What transcript renderers show of a supervised service; see {@link serviceView}. */
export interface ServiceView {
	/** The service name, as `proc://` takes it. */
	name: string;
	state: DaemonState;
	/** Main process id, when the snapshot has one. */
	pid?: number;
	startedAt: number;
	exitedAt?: number;
	exitCode?: number;
	hold: UnitPolicy["hold"];
}

/** The renderable facts of a persisted service snapshot, whichever generation wrote it. */
export function serviceView(snapshot: PersistedSnapshot): ServiceView {
	const { state, startedAt, exitedAt, exitCode } = snapshot;
	if ("key" in snapshot) {
		return {
			name: snapshot.key,
			state,
			pid: snapshot.pids[0],
			startedAt,
			exitedAt,
			exitCode,
			hold: snapshot.policy.hold,
		};
	}
	const hold = snapshot.detached ? "detached" : snapshot.persist ? "persist" : "leases";
	return { name: snapshot.name, state, pid: snapshot.pid, startedAt, exitedAt, exitCode, hold };
}
