/**
 * Wire protocol and client surface of the single per-user omp daemon.
 *
 * One daemon owns every background process omp shares between sessions. It
 * listens on one endpoint (Unix socket / named pipe, or TCP when
 * {@link DAEMON_TCP_ENV} is set). Every connection starts in control mode:
 * LF-delimited JSON, first line a {@link DaemonHello}. A successful `attach`
 * turns that connection into a raw byte tunnel to one unit.
 *
 * Implementations: `server.ts` (daemon), `client.ts` ({@link DaemonClient}).
 */
import type { DaemonRestartPolicy, ProcSpec, UnitPolicy, UnitScope, UnitSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

export type { DaemonRestartPolicy, ProcSpec, UnitPolicy, UnitScope, UnitSnapshot };

/** Bumped only for incompatible control-protocol changes; ops are otherwise additive. */
export const DAEMON_PROTOCOL_VERSION = 1;
/** Hidden CLI selector that runs the daemon. */
export const DAEMON_WORKER_ARG = "__omp_worker_daemon";
/** `host:port`; makes the daemon listen on, and clients dial, loopback TCP instead of the local IPC endpoint. */
export const DAEMON_TCP_ENV = "OMP_DAEMON_TCP";
/** Runtime directory override, for smoke tests and isolated consumers. */
export const DAEMON_DIR_ENV = "OMP_DAEMON_DIR";
/** Set by a re-exec'ing daemon for its successor: path of nothing, presence means "restore from the store". */
export const DAEMON_RESUME_ENV = "OMP_DAEMON_RESUME";
/** Fixed dimensions negotiated with every supervised PTY. */
export const DAEMON_PTY_COLUMNS = 120;
export const DAEMON_PTY_ROWS = 40;
/** Readiness and wait regexes match line anchors within accumulated output. */
export const DAEMON_OUTPUT_PATTERN_FLAGS = "mu";
/** How long restored units wait for their clients to reconnect before idle timers resume. */
export const DAEMON_RESUME_LEASE_GRACE_MS = 15_000;
/** Env var overriding {@link DAEMON_RESUME_LEASE_GRACE_MS} (milliseconds) in the daemon; for tests. */
export const DAEMON_RESUME_LEASE_GRACE_ENV = "OMP_DAEMON_RESUME_LEASE_GRACE_MS";

export type DaemonSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";

/** A unit by id, or by its identity triple. */
export type UnitRef = string | { kind: string; scope: UnitScope; key: string };

/** First line of every connection. */
export interface DaemonHello {
	v: number;
	token: string;
	client: {
		pid: number;
		/** omp `VERSION` of the client. */
		build: string;
		/** Command that re-enters the client's build (`resolveCliEntryCmd()`); the daemon re-execs it on `upgrade`. */
		exe: string[];
		session?: string;
		project?: string;
	};
}

/** Reply to {@link DaemonHello}. */
export interface DaemonWelcome {
	v: number;
	daemon: { pid: number; build: string; startedAt: number };
	/** Module kind -> module protocol version. */
	caps: Record<string, number>;
}

/** Find-or-start request. `(kind, scope, key)` is the identity; concurrent opens converge on one unit. */
export interface OpenRequest {
	kind: string;
	scope: UnitScope;
	key: string;
	label?: string;
	/** `proc` units: the command. Module kinds ignore it. */
	proc?: ProcSpec;
	/** Module-specific launch parameters, read only when the unit is created. */
	params?: unknown;
	/** Overrides of the kind's default policy. */
	policy?: Partial<UnitPolicy>;
	owner?: string;
	/** Stop a live unit with this identity and start a new one. */
	replace?: boolean;
	/** `false` answers once the unit launches; follow with `wait`. Default true. */
	awaitReady?: boolean;
	/** Take a connection-bound lease. Default true; released by `release` or when the connection closes. */
	lease?: boolean;
}

export interface OpenResult {
	unit: UnitSnapshot;
	/** Present when a lease was taken. */
	lease?: string;
	/** The request created the unit rather than adopting a live one. */
	created: boolean;
}

/** Control-mode operations. */
export type DaemonOp =
	| { op: "ping" }
	| { op: "list"; scope?: UnitScope; kind?: string }
	| { op: "describe"; unit: UnitRef }
	/** Subscribe this connection to {@link DaemonUnitEvent}s. */
	| { op: "watch" }
	| ({ op: "open" } & OpenRequest)
	| { op: "release"; lease: string }
	| { op: "stop"; unit: UnitRef; timeoutMs: number; generation?: string }
	| { op: "restart"; unit: UnitRef }
	| { op: "mode"; unit: UnitRef; mode: "persist" | "session" | "detached" }
	| {
			op: "logs";
			unit: UnitRef;
			lines: number;
			head: boolean;
			grep?: string;
			follow: boolean;
			cursor?: number;
			timeoutMs: number;
	  }
	| { op: "wait"; unit: UnitRef; for: "ready" | "exit"; pattern?: string; timeoutMs: number }
	| { op: "send"; unit: UnitRef; data?: string; signal?: DaemonSignal }
	/** Abort this connection's in-flight `wait`/follow-`logs` request. */
	| { op: "cancel"; requestId: string }
	/** Module RPC that needs no byte stream. */
	| { op: "call"; module: string; method: string; params?: unknown; unit?: UnitRef }
	/** On success the connection leaves control mode: every later byte is tunnelled to the unit. */
	| { op: "attach"; unit: UnitRef; channel?: string }
	/** List a process this client owns on the board; removed when the connection closes. */
	| { op: "register"; kind: string; scope: UnitScope; key: string; label: string; pid: number }
	/**
	 * Remove a unit this connection `register`ed. An unknown unit resolves with `removed: false`;
	 * any other unit, including another connection's registration, is refused.
	 */
	| { op: "unregister"; unit: UnitRef }
	/** Subscribe to completion/notify events for services owned by `owners`. */
	| {
			op: "subscribe";
			subscriptionId: string;
			owners: string[];
			detachedOwners?: string[];
			acks?: string[];
			replays?: string[];
			unsubscribes?: string[];
	  }
	/** Re-exec the daemon into the client's newer build, keeping its `survive: "exec"` units. */
	| { op: "upgrade" }
	| { op: "shutdown" };

export interface DaemonLogs {
	text: string;
	/** PTY output replayed into rendered terminal rows; empty for non-PTY units. */
	terminalOutput: string;
	cursor: number;
	unit: UnitSnapshot;
}

/** Result of each operation, keyed by `op`. */
export interface DaemonResults {
	ping: { pid: number; build: string };
	list: { units: UnitSnapshot[] };
	describe: { unit: UnitSnapshot; proc?: ProcSpec };
	watch: Record<string, never>;
	open: OpenResult;
	release: Record<string, never>;
	stop: { unit: UnitSnapshot };
	restart: { unit: UnitSnapshot };
	mode: { unit: UnitSnapshot };
	logs: DaemonLogs;
	wait: { unit: UnitSnapshot; matched: boolean; match?: string };
	send: { unit: UnitSnapshot };
	cancel: { cancelled: boolean };
	call: { result: unknown };
	attach: { unit: UnitSnapshot };
	register: { unit: UnitSnapshot };
	unregister: { removed: boolean };
	subscribe: Record<string, never>;
	upgrade: { reexec: boolean };
	shutdown: Record<string, never>;
}

export type DaemonResult<O extends DaemonOp["op"]> = DaemonResults[O];

/** Control request line. */
export type DaemonRequest = { id: string } & DaemonOp;
/** Control response line. */
export type DaemonResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** Sent to `watch`ing connections on every unit transition. */
export interface DaemonUnitEvent {
	ev: "unit";
	unit: UnitSnapshot;
	/** The unit left the board. */
	removed?: boolean;
}

/** Terminal completion of an owned service; redelivered until acked through `subscribe`. */
export interface DaemonCompletionEvent {
	ev: "completed";
	completionId: string;
	owner: string;
	unit: UnitSnapshot;
}

/** Output lines matching an owned service's `notify` regex. Best effort, never replayed. */
export interface DaemonNotifyEvent {
	ev: "notify";
	owner: string;
	unit: UnitSnapshot;
	pattern: string;
	lines: string[];
	omitted: number;
	/** The unit matched too often: last report until it is started again. */
	stopped: boolean;
}

export type DaemonEvent = DaemonUnitEvent | DaemonCompletionEvent | DaemonNotifyEvent;

/** Raw byte stream to one unit, after `attach`. */
export interface DaemonTunnel {
	readonly unit: UnitSnapshot;
	/** False once more than 1 MiB is unwritten; await {@link drained}. */
	send(data: string | Uint8Array): boolean;
	drained(): Promise<void>;
	/** Call once; chunks received earlier are buffered. */
	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void;
	close(): void;
	/** Keep the event loop alive while open (default). */
	ref(): void;
	/** Let the process exit while this tunnel is open and idle. */
	unref(): void;
}

export interface DaemonCompletionUnregisterOptions {
	/** Detach this process without deleting daemon-persisted pending notifications. */
	preservePending?: boolean;
}

/**
 * Process-wide connection to the daemon, from `daemonClient()` in `client.ts`.
 * It spawns the daemon when none answers, asks an older daemon to `upgrade`,
 * and reconnects (re-opening nothing: leases are the caller's to retake) when
 * the daemon restarts.
 */
export interface DaemonClient {
	readonly welcome: DaemonWelcome;
	request<O extends DaemonOp>(operation: O, signal?: AbortSignal): Promise<DaemonResult<O["op"]>>;
	/** Find-or-start; the returned lease dies with this client's connection. */
	open(request: OpenRequest, signal?: AbortSignal): Promise<OpenResult>;
	release(lease: string): Promise<void>;
	call<T>(
		module: string,
		method: string,
		params?: unknown,
		options?: { unit?: UnitRef; signal?: AbortSignal },
	): Promise<T>;
	/** Dial a second connection and turn it into a tunnel to `unit`. */
	attach(unit: UnitRef, channel?: string, signal?: AbortSignal): Promise<DaemonTunnel>;
	onCompletion(
		owner: string,
		sink: (event: DaemonCompletionEvent) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void;
	onNotify(owner: string, sink: (event: DaemonNotifyEvent) => void): () => void;
	/** Board subscription; sends `watch` on first use. */
	onUnit(sink: (event: DaemonUnitEvent) => void): () => void;
	/** Fires after the connection was re-established to a (possibly new) daemon; leases are gone. */
	onReconnect(sink: () => void): () => void;
	close(): void;
}

/** Scope of the project containing `dir`; `dir` must already be canonical (`canonicalProjectDir`). */
export function projectScope(dir: string): UnitScope {
	return { kind: "project", dir };
}

export const GLOBAL_SCOPE: UnitScope = { kind: "global" };

/** Split a build identity `VERSION+<stamp>` (see `build.ts`); a missing or malformed stamp is 0. */
export function parseDaemonBuild(build: string): { version: string; stamp: number } {
	const plus = build.indexOf("+");
	if (plus < 0) return { version: build, stamp: 0 };
	const stamp = Number(build.slice(plus + 1));
	return { version: build.slice(0, plus), stamp: Number.isSafeInteger(stamp) && stamp > 0 ? stamp : 0 };
}

/** Order two build identities: `VERSION` by semver first, then the stamp. Positive when `left` is newer. */
export function compareDaemonBuilds(left: string, right: string): number {
	const a = parseDaemonBuild(left);
	const b = parseDaemonBuild(right);
	const byVersion = Bun.semver.order(a.version, b.version);
	if (byVersion !== 0) return byVersion;
	return Math.sign(a.stamp - b.stamp);
}

/** Stable text form of a scope, for keys and display. */
export function scopeKey(scope: UnitScope): string {
	if (scope.kind === "global") return "global";
	return scope.kind === "project" ? `project:${scope.dir}` : `session:${scope.id}`;
}
