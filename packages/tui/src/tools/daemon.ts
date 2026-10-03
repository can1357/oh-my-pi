/** Launch-broker daemon types shared by services, `proc://`, and `omp ps`. */

/** Stable lifecycle states exposed by the launch broker. */
export type DaemonState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";

/** Restart behavior applied after an unexpected daemon exit. */
export type DaemonRestartPolicy = "no" | "on-failure" | "always";

/** Readiness conditions; every configured condition must pass. */
export interface DaemonReadySpec {
	log?: string;
	port?: number;
	host?: string;
	timeoutMs: number;
}

/** Immutable launch specification retained for restart and inspection. */
export interface DaemonSpec {
	name: string;
	application: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pty: boolean;
	ready?: DaemonReadySpec;
	restart: DaemonRestartPolicy;
	persist: boolean;
	detached: boolean;
}

/** Serializable daemon state visible to every client in one broker scope. */
export interface DaemonSnapshot {
	name: string;
	id: string;
	state: DaemonState;
	pid?: number;
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
	/** Readiness conditions still unmet while `state` is `starting`; absent once ready or without a ready spec. */
	readyPending?: ("log" | "port")[];
	persist: boolean;
	detached: boolean;
}
