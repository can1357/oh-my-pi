import { sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenEmbeddedPaths } from "../render/render-utils";

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

/** Model-facing delivery mode a client attached to one output subscription. */
export type DaemonMonitorDelivery = "wake" | "ambient";

/** One live output monitor as the broker sees it; listed with services so watchers are debuggable. */
export interface DaemonMonitorWatcher {
	/** Process name the monitor targets. */
	name: string;
	/** Client-scoped subscription id. */
	id: string;
	/** Session that registered the monitor. */
	owner: string;
	/** Delivery mode advertised by the client; absent for clients that predate the field. */
	delivery?: DaemonMonitorDelivery;
	/** Epoch milliseconds when the client registered the monitor; absent for older clients. */
	since?: number;
	/** Session artifact id receiving the raw capture; absent for older clients. */
	artifactId?: string;
	/** Daemon incarnation the monitor is bound to; absent while it waits for a start. */
	daemonId?: string;
	/** False while the registering client is disconnected inside the reconnect grace. */
	connected: boolean;
}

/** Maximum sanitized diagnostic text retained in daemon snapshots and display. */
const MAX_EXIT_REASON_LENGTH = 1_024;

/**
 * Mirrors the coding-agent launch exit-reason normalization without importing
 * that package. Durable normalization bounds runtime text; display also hides
 * the home directory.
 */
export function normalizeDaemonExitReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const normalized = sanitizeText(reason).replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > MAX_EXIT_REASON_LENGTH
		? `${normalized.slice(0, MAX_EXIT_REASON_LENGTH - 1)}…`
		: normalized;
}

export function displayDaemonExitReason(reason: string | undefined): string | undefined {
	const normalized = normalizeDaemonExitReason(reason);
	return normalized ? shortenEmbeddedPaths(normalized) : undefined;
}
