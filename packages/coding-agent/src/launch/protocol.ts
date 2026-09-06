/**
 * Cross-process daemon broker protocol shared by the tool, client, and broker.
 */
import type { ProgressBatchKind, ProgressReminder } from "../async/progress-batcher";

/** Hidden CLI selector used to re-enter the daemon broker worker. */
export const DAEMON_BROKER_WORKER_ARG = "__omp_worker_daemon_broker";

/** Fixed dimensions negotiated with every supervised PTY. */
export const DAEMON_PTY_COLUMNS = 120;
export const DAEMON_PTY_ROWS = 40;

/** Environment key carrying the broker's canonical project or synthetic global scope directory. */
export const DAEMON_PROJECT_DIR_ENV = "OMP_DAEMON_PROJECT_DIR";

/** Environment key carrying the broker's private runtime directory. */
export const DAEMON_RUNTIME_DIR_ENV = "OMP_DAEMON_RUNTIME_DIR";

/** Optional environment key overriding last-client shutdown grace. */
export const DAEMON_IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";

/** Broker support for live output previews plus their recoverable raw capture. */
export const DAEMON_OUTPUT_MONITOR_CAPABILITY = "output-monitor-v4";

/** Stable lifecycle states exposed by the launch tool. */
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

/** Signals accepted by daemon input operations. */
export type DaemonSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";

/** Typed broker operation sent over the authenticated socket. */
export type DaemonOperation =
	| { op: "ping" }
	| { op: "start"; spec: DaemonSpec; owner?: string }
	| { op: "list" }
	| {
			op: "logs";
			name: string;
			lines: number;
			head: boolean;
			grep?: string;
			follow: boolean;
			cursor?: number;
			/** Ask an upgraded broker to replay PTY output; absent preserves legacy raw-text responses. */
			renderTerminalRows?: boolean;
			timeoutMs: number;
	  }
	| { op: "wait"; name: string; for: "ready" | "exit"; pattern?: string; timeoutMs: number }
	| { op: "send"; name: string; data?: string; signal?: DaemonSignal }
	| { op: "stop"; name: string; timeoutMs: number }
	| { op: "restart"; name: string }
	| { op: "describe"; name: string }
	| { op: "shutdown" };

/** Model-facing delivery mode a client attached to one output subscription. */
export type DaemonMonitorDelivery = "wake" | "ambient";

/** One live output monitor as the broker sees it; listed by `list` and `describe` so watchers are debuggable. */
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

/** Typed broker result decoded before it reaches tool code. */
export type DaemonRpcResult =
	| { op: "ping"; projectDir: string; capabilities?: string[] }
	| { op: "start"; daemon: DaemonSnapshot; readyTimedOut: boolean }
	| { op: "list"; daemons: DaemonSnapshot[]; monitors?: DaemonMonitorWatcher[] }
	| {
			op: "logs";
			name: string;
			text: string;
			/** Virtual PTY rows reconstructed by the broker for terminal display. */
			terminalRows?: string[];
			/** Raw PTY bytes returned by legacy brokers and to clients that did not request rendered rows. */
			terminalText?: string;
			cursor: number;
			timedOut: boolean;
			state: DaemonState;
	  }
	| { op: "wait"; daemon: DaemonSnapshot; matched?: string; timedOut: boolean }
	| { op: "send"; daemon: DaemonSnapshot }
	| { op: "stop"; daemon: DaemonSnapshot }
	| { op: "restart"; daemon: DaemonSnapshot }
	| { op: "describe"; daemon: DaemonSnapshot; spec: DaemonSpec; monitors?: DaemonMonitorWatcher[] }
	| { op: "shutdown" };

/** Authenticated request envelope used by socket clients. */
export interface DaemonWireRequest {
	id: string;
	token: string;
	owners?: string[];
	detachedOwners?: string[];
	completionEvents?: boolean;
	completionAcks?: string[];
	completionUnsubscribes?: string[];
	completionReplays?: string[];
	completionSubscriptionId?: string;
	outputSubscriptions?: DaemonOutputWireSubscription[];
	outputSubscriptionId?: string;
	operation: DaemonOperation;
}

/** One live process-output subscription advertised by a connected client. */
export interface DaemonOutputSubscription {
	id: string;
	name: string;
	owner: string;
	/** Session artifact written directly by the broker while the subscription is active. */
	artifactPath: string;
	/**
	 * Daemon incarnation already accepted by this client. On republish after
	 * broker-side registration expiry, the broker expires this subscription
	 * instead of silently binding it to a different same-name process.
	 */
	daemonId?: string;
	/** Client-managed cumulative ack: broker registration epoch of the last delivered output batch. */
	lastEpoch?: string;
	/** Client-managed cumulative ack: highest `seq` delivered for {@link lastEpoch}. */
	lastSeq?: number;
	/**
	 * Artifact size (bytes) behind the last output batch the client delivered.
	 * A fresh broker registration continues that capture by appending past it;
	 * without it the registration starts a new capture at `artifactPath`.
	 */
	artifactBytes?: number;
	/**
	 * True while this registration targets the next daemon started with
	 * {@link name}, rather than the current incarnation. The broker leaves it
	 * unbound until that new record exists and never replays a prior terminal
	 * record to it.
	 */
	startPending?: boolean;
	/** Delivery mode the client attached; reported by `list`/`describe` watcher rows. */
	delivery?: DaemonMonitorDelivery;
	/** Epoch milliseconds when the client registered this subscription. */
	since?: number;
	/** Session artifact id the client allocated for the raw capture at {@link artifactPath}. */
	artifactId?: string;
}

/** Wire form of a subscription, tagged by the exact client registration that advertised it. */
export interface DaemonOutputWireSubscription extends DaemonOutputSubscription {
	registrationId: string;
}

/** Response envelope kept raw until matched with its pending operation. */
export type DaemonWireResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** Unsolicited terminal completion sent to the socket that owns a daemon. */
export interface DaemonCompletionNotification {
	event: "daemon-completed";
	completionId: string;
	owner: string;
	daemon: DaemonSnapshot;
}

/** A live output batch for one monitored process. */
export interface DaemonOutputNotification {
	event: "daemon-output";
	monitorId: string;
	name: string;
	daemonId: string;
	/** Broker registration epoch; `seq` ordering and replay acks are scoped to it. */
	epoch?: string;
	seq: number;
	text: string;
	batchKind: ProgressBatchKind;
	suppressedEvents: number;
	reminder?: ProgressReminder;
	/** True when at least one model-facing line preview was clipped. */
	truncated?: boolean;
	/** Bytes readable in the registration's artifact once this batch is delivered. */
	artifactBytes?: number;
	/**
	 * Output batches the broker evicted from its bounded replay buffer before
	 * this client acknowledged them. Their raw text survives only in the
	 * artifact; a batch carrying this is also `truncated` and counts the
	 * evictions in {@link suppressedEvents}.
	 */
	replayGap?: number;
}

/** Socket form of monitored output, scoped to the exact advertised registration. */
export interface DaemonOutputWireNotification extends DaemonOutputNotification {
	registrationId: string;
}

/** Terminal process state for a registered output monitor. */
export interface DaemonMonitorCompletionNotification {
	event: "daemon-monitor-completed";
	monitorId: string;
	daemon: DaemonSnapshot;
	/**
	 * True when the broker emitted (or queued) a `daemon-completed`
	 * notification to the daemon's owner for this settlement. False when no
	 * owner completion covered it (e.g. the daemon was stopped by another
	 * client), so an owner-session monitor must synthesize its own terminal
	 * notification instead of waiting for one that will never arrive.
	 */
	ownerNotified?: boolean;
}

/** Socket form of monitor completion, scoped to the exact advertised registration. */
export interface DaemonMonitorCompletionWireNotification extends DaemonMonitorCompletionNotification {
	registrationId: string;
}

/** Terminal signal when a monitor is disabled and can no longer deliver output. */
export interface DaemonMonitorExpiredNotification {
	event: "daemon-monitor-expired";
	monitorId: string;
	name: string;
	daemonId: string;
}

/** Socket form of monitor expiry, scoped to the exact advertised registration. */
export interface DaemonMonitorExpiredWireNotification extends DaemonMonitorExpiredNotification {
	registrationId: string;
}

export type DaemonMonitorNotification =
	| DaemonOutputNotification
	| DaemonMonitorCompletionNotification
	| DaemonMonitorExpiredNotification;
export type DaemonMonitorWireNotification =
	| DaemonOutputWireNotification
	| DaemonMonitorCompletionWireNotification
	| DaemonMonitorExpiredWireNotification;
export type DaemonWireMessage = DaemonWireResponse | DaemonCompletionNotification | DaemonMonitorWireNotification;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function rawString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return stringValue(value, label);
}

function optionalRawString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return rawString(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function progressBatchKind(value: unknown): ProgressBatchKind {
	const kind = stringValue(value, "output.batchKind");
	if (kind === "progress" || kind === "artifact-only" || kind === "suppression-summary") return kind;
	throw new Error(`Unknown progress batch kind: ${kind}`);
}

function progressReminder(value: unknown): ProgressReminder | undefined {
	if (value === undefined) return undefined;
	const reminder = stringValue(value, "output.reminder");
	if (reminder === "chatty-monitor") return reminder;
	throw new Error(`Unknown progress reminder: ${reminder}`);
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	const parsed = numberValue(value, label);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
	return parsed;
}

function optionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	return numberValue(value, label);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
	const result: string[] = [];
	for (const item of value) result.push(rawString(item, `${label} item`));
	return result;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const source = record(value, label);
	const result: Record<string, string> = {};
	for (const key in source) result[key] = rawString(source[key], `${label}.${key}`);
	return result;
}

function outputSubscriptions(value: unknown): DaemonOutputWireSubscription[] {
	if (!Array.isArray(value)) throw new Error("request.outputSubscriptions must be an array");
	return value.map((item, index) => {
		const source = record(item, `request.outputSubscriptions[${index}]`);
		return {
			id: stringValue(source.id, `request.outputSubscriptions[${index}].id`),
			name: stringValue(source.name, `request.outputSubscriptions[${index}].name`),
			owner: stringValue(source.owner, `request.outputSubscriptions[${index}].owner`),
			artifactPath: stringValue(source.artifactPath, `request.outputSubscriptions[${index}].artifactPath`),
			registrationId: stringValue(source.registrationId, `request.outputSubscriptions[${index}].registrationId`),
			daemonId: optionalString(source.daemonId, `request.outputSubscriptions[${index}].daemonId`),
			lastEpoch: optionalString(source.lastEpoch, `request.outputSubscriptions[${index}].lastEpoch`),
			lastSeq:
				source.lastSeq === undefined
					? undefined
					: nonNegativeInteger(source.lastSeq, `request.outputSubscriptions[${index}].lastSeq`),
			artifactBytes:
				source.artifactBytes === undefined
					? undefined
					: nonNegativeInteger(source.artifactBytes, `request.outputSubscriptions[${index}].artifactBytes`),
			startPending:
				source.startPending === undefined
					? undefined
					: booleanValue(source.startPending, `request.outputSubscriptions[${index}].startPending`),
			delivery: optionalMonitorDelivery(source.delivery, `request.outputSubscriptions[${index}].delivery`),
			since:
				source.since === undefined
					? undefined
					: nonNegativeInteger(source.since, `request.outputSubscriptions[${index}].since`),
			artifactId: optionalString(source.artifactId, `request.outputSubscriptions[${index}].artifactId`),
		};
	});
}

function optionalMonitorDelivery(value: unknown, label: string): DaemonMonitorDelivery | undefined {
	if (value === undefined) return undefined;
	const delivery = stringValue(value, label);
	if (delivery === "wake" || delivery === "ambient") return delivery;
	throw new Error(`Unknown monitor delivery: ${delivery}`);
}

function optionalMonitorWatchers(value: unknown): DaemonMonitorWatcher[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("result.monitors must be an array");
	return value.map((item, index) => {
		const label = `result.monitors[${index}]`;
		const source = record(item, label);
		return {
			name: stringValue(source.name, `${label}.name`),
			id: stringValue(source.id, `${label}.id`),
			owner: stringValue(source.owner, `${label}.owner`),
			delivery: optionalMonitorDelivery(source.delivery, `${label}.delivery`),
			since: source.since === undefined ? undefined : nonNegativeInteger(source.since, `${label}.since`),
			artifactId: optionalString(source.artifactId, `${label}.artifactId`),
			daemonId: optionalString(source.daemonId, `${label}.daemonId`),
			connected: booleanValue(source.connected, `${label}.connected`),
		};
	});
}

function daemonState(value: unknown): DaemonState {
	const state = stringValue(value, "daemon state");
	if (state === "starting" || state === "running" || state === "ready" || state === "restarting") return state;
	if (state === "stopping" || state === "exited" || state === "failed") return state;
	throw new Error(`Unknown daemon state: ${state}`);
}

function restartPolicy(value: unknown): DaemonRestartPolicy {
	const policy = stringValue(value, "restart policy");
	if (policy === "no" || policy === "on-failure" || policy === "always") return policy;
	throw new Error(`Unknown restart policy: ${policy}`);
}

function daemonSignal(value: unknown): DaemonSignal {
	const signal = stringValue(value, "signal");
	if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") return signal;
	if (signal === "SIGQUIT" || signal === "SIGKILL") return signal;
	throw new Error(`Unknown daemon signal: ${signal}`);
}

function readyPendingList(value: unknown): ("log" | "port")[] {
	if (!Array.isArray(value)) throw new Error("daemon.readyPending must be an array");
	const result: ("log" | "port")[] = [];
	for (const item of value) {
		if (item !== "log" && item !== "port") throw new Error(`Unknown readiness condition: ${String(item)}`);
		result.push(item);
	}
	return result;
}

function readySpec(value: unknown): DaemonReadySpec {
	const source = record(value, "ready");
	const log = optionalString(source.log, "ready.log");
	const port = optionalNumber(source.port, "ready.port");
	const host = optionalString(source.host, "ready.host");
	const timeoutMs = numberValue(source.timeoutMs, "ready.timeoutMs");
	if (!log && port === undefined) throw new Error("ready requires log or port");
	return { log, port, host, timeoutMs };
}

/** Decode and validate a daemon launch specification. */
export function parseDaemonSpec(value: unknown): DaemonSpec {
	const source = record(value, "daemon spec");
	const detached = source.detached === undefined ? false : booleanValue(source.detached, "spec.detached");
	return {
		name: stringValue(source.name, "spec.name"),
		application: stringValue(source.application, "spec.application"),
		args: stringArray(source.args, "spec.args"),
		env: stringRecord(source.env, "spec.env"),
		cwd: stringValue(source.cwd, "spec.cwd"),
		pty: booleanValue(source.pty, "spec.pty"),
		ready: source.ready === undefined ? undefined : readySpec(source.ready),
		restart: restartPolicy(source.restart),
		persist: booleanValue(source.persist, "spec.persist") || detached,
		detached,
	};
}

/** Decode and validate one daemon snapshot. */
export function parseDaemonSnapshot(value: unknown): DaemonSnapshot {
	const source = record(value, "daemon snapshot");
	return {
		name: stringValue(source.name, "daemon.name"),
		id: stringValue(source.id, "daemon.id"),
		state: daemonState(source.state),
		pid: optionalNumber(source.pid, "daemon.pid"),
		createdAt: numberValue(source.createdAt, "daemon.createdAt"),
		startedAt: numberValue(source.startedAt, "daemon.startedAt"),
		readyAt: optionalNumber(source.readyAt, "daemon.readyAt"),
		exitedAt: optionalNumber(source.exitedAt, "daemon.exitedAt"),
		exitCode: optionalNumber(source.exitCode, "daemon.exitCode"),
		exitReason: optionalString(source.exitReason, "daemon.exitReason"),
		restartCount: numberValue(source.restartCount, "daemon.restartCount"),
		outputBytes: numberValue(source.outputBytes, "daemon.outputBytes"),
		owner: optionalString(source.owner, "daemon.owner"),
		readyMatch: optionalRawString(source.readyMatch, "daemon.readyMatch"),
		readyPending: source.readyPending === undefined ? undefined : readyPendingList(source.readyPending),
		persist: booleanValue(source.persist, "daemon.persist"),
		detached: source.detached === undefined ? false : booleanValue(source.detached, "daemon.detached"),
	};
}

/** Decode a socket request before the broker acts on it. */
export function parseDaemonWireRequest(value: unknown): DaemonWireRequest {
	const source = record(value, "daemon request");
	return {
		id: stringValue(source.id, "request.id"),
		token: stringValue(source.token, "request.token"),
		owners: source.owners === undefined ? undefined : stringArray(source.owners, "request.owners"),
		detachedOwners:
			source.detachedOwners === undefined ? undefined : stringArray(source.detachedOwners, "request.detachedOwners"),
		completionEvents:
			source.completionEvents === undefined
				? undefined
				: booleanValue(source.completionEvents, "request.completionEvents"),
		completionAcks:
			source.completionAcks === undefined ? undefined : stringArray(source.completionAcks, "request.completionAcks"),
		completionUnsubscribes:
			source.completionUnsubscribes === undefined
				? undefined
				: stringArray(source.completionUnsubscribes, "request.completionUnsubscribes"),
		completionReplays:
			source.completionReplays === undefined
				? undefined
				: stringArray(source.completionReplays, "request.completionReplays"),
		completionSubscriptionId:
			source.completionSubscriptionId === undefined
				? undefined
				: stringValue(source.completionSubscriptionId, "request.completionSubscriptionId"),
		outputSubscriptions:
			source.outputSubscriptions === undefined ? undefined : outputSubscriptions(source.outputSubscriptions),
		outputSubscriptionId:
			source.outputSubscriptionId === undefined
				? undefined
				: stringValue(source.outputSubscriptionId, "request.outputSubscriptionId"),
		operation: parseDaemonOperation(source.operation),
	};
}

/** Decode a socket response envelope before resolving a pending call. */
export function parseDaemonWireResponse(value: unknown): DaemonWireResponse {
	const source = record(value, "daemon response");
	const id = stringValue(source.id, "response.id");
	if (source.ok === true) return { id, ok: true, result: source.result };
	if (source.ok === false) return { id, ok: false, error: stringValue(source.error, "response.error") };
	throw new Error("response.ok must be a boolean");
}

/** Decode one broker response or unsolicited completion notification. */
export function parseDaemonWireMessage(value: unknown): DaemonWireMessage {
	const source = record(value, "daemon message");
	if (source.event === "daemon-completed") {
		return {
			event: "daemon-completed",
			completionId: stringValue(source.completionId, "completion.id"),
			owner: stringValue(source.owner, "completion.owner"),
			daemon: parseDaemonSnapshot(source.daemon),
		};
	}
	if (source.event === "daemon-output") {
		return {
			event: "daemon-output",
			monitorId: stringValue(source.monitorId, "output.monitorId"),
			registrationId: stringValue(source.registrationId, "output.registrationId"),
			name: stringValue(source.name, "output.name"),
			daemonId: stringValue(source.daemonId, "output.daemonId"),
			epoch: optionalString(source.epoch, "output.epoch"),
			seq: nonNegativeInteger(source.seq, "output.seq"),
			text: rawString(source.text, "output.text"),
			batchKind: progressBatchKind(source.batchKind),
			suppressedEvents: nonNegativeInteger(source.suppressedEvents, "output.suppressedEvents"),
			reminder: progressReminder(source.reminder),
			truncated: source.truncated === undefined ? undefined : booleanValue(source.truncated, "output.truncated"),
			artifactBytes:
				source.artifactBytes === undefined
					? undefined
					: nonNegativeInteger(source.artifactBytes, "output.artifactBytes"),
			replayGap:
				source.replayGap === undefined ? undefined : nonNegativeInteger(source.replayGap, "output.replayGap"),
		};
	}
	if (source.event === "daemon-monitor-completed") {
		return {
			event: "daemon-monitor-completed",
			monitorId: stringValue(source.monitorId, "monitor completion.monitorId"),
			registrationId: stringValue(source.registrationId, "monitor completion.registrationId"),
			daemon: parseDaemonSnapshot(source.daemon),
			ownerNotified:
				source.ownerNotified === undefined
					? undefined
					: booleanValue(source.ownerNotified, "monitor completion.ownerNotified"),
		};
	}
	if (source.event === "daemon-monitor-expired") {
		return {
			event: "daemon-monitor-expired",
			monitorId: stringValue(source.monitorId, "monitor expiry.monitorId"),
			registrationId: stringValue(source.registrationId, "monitor expiry.registrationId"),
			name: stringValue(source.name, "monitor expiry.name"),
			daemonId: stringValue(source.daemonId, "monitor expiry.daemonId"),
		};
	}
	return parseDaemonWireResponse(value);
}

function parseDaemonOperation(value: unknown): DaemonOperation {
	const source = record(value, "daemon operation");
	const op = stringValue(source.op, "operation.op");
	switch (op) {
		case "ping":
		case "list":
		case "shutdown":
			return { op };
		case "start":
			return {
				op,
				spec: parseDaemonSpec(source.spec),
				owner: optionalString(source.owner, "operation.owner"),
			};
		case "logs":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				lines: numberValue(source.lines, "operation.lines"),
				head: booleanValue(source.head, "operation.head"),
				grep: optionalString(source.grep, "operation.grep"),
				follow: booleanValue(source.follow, "operation.follow"),
				cursor: optionalNumber(source.cursor, "operation.cursor"),
				renderTerminalRows:
					source.renderTerminalRows === undefined
						? undefined
						: booleanValue(source.renderTerminalRows, "operation.renderTerminalRows"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		case "wait": {
			const target = stringValue(source.for, "operation.for");
			if (target !== "ready" && target !== "exit") throw new Error("operation.for must be ready or exit");
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				for: target,
				pattern: optionalString(source.pattern, "operation.pattern"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		}
		case "send":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				data: optionalString(source.data, "operation.data"),
				signal: source.signal === undefined ? undefined : daemonSignal(source.signal),
			};
		case "stop":
			return {
				op,
				name: stringValue(source.name, "operation.name"),
				timeoutMs: numberValue(source.timeoutMs, "operation.timeoutMs"),
			};
		case "restart":
		case "describe":
			return { op, name: stringValue(source.name, "operation.name") };
		default:
			throw new Error(`Unknown daemon operation: ${op}`);
	}
}

/** Decode a broker result using its pending operation as the discriminator. */
export function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult {
	const source = record(value, `${operation.op} result`);
	switch (operation.op) {
		case "ping":
			return {
				op: "ping",
				projectDir: stringValue(source.projectDir, "result.projectDir"),
				capabilities:
					source.capabilities === undefined ? undefined : stringArray(source.capabilities, "result.capabilities"),
			};
		case "start":
			return {
				op: "start",
				daemon: parseDaemonSnapshot(source.daemon),
				readyTimedOut: booleanValue(source.readyTimedOut, "result.readyTimedOut"),
			};
		case "list": {
			if (!Array.isArray(source.daemons)) throw new Error("result.daemons must be an array");
			return {
				op: "list",
				daemons: source.daemons.map(parseDaemonSnapshot),
				monitors: optionalMonitorWatchers(source.monitors),
			};
		}
		case "logs":
			return {
				op: "logs",
				name: stringValue(source.name, "result.name"),
				text: typeof source.text === "string" ? source.text : "",
				terminalRows:
					source.terminalRows === undefined ? undefined : stringArray(source.terminalRows, "result.terminalRows"),
				terminalText:
					source.terminalText === undefined ? undefined : rawString(source.terminalText, "result.terminalText"),
				cursor: numberValue(source.cursor, "result.cursor"),
				timedOut: booleanValue(source.timedOut, "result.timedOut"),
				state: daemonState(source.state),
			};
		case "wait":
			return {
				op: "wait",
				daemon: parseDaemonSnapshot(source.daemon),
				matched: optionalRawString(source.matched, "result.matched"),
				timedOut: booleanValue(source.timedOut, "result.timedOut"),
			};
		case "send":
			return { op: "send", daemon: parseDaemonSnapshot(source.daemon) };
		case "stop":
			return { op: "stop", daemon: parseDaemonSnapshot(source.daemon) };
		case "restart":
			return { op: "restart", daemon: parseDaemonSnapshot(source.daemon) };
		case "describe":
			return {
				op: "describe",
				daemon: parseDaemonSnapshot(source.daemon),
				spec: parseDaemonSpec(source.spec),
				monitors: optionalMonitorWatchers(source.monitors),
			};
		case "shutdown":
			return { op: "shutdown" };
	}
}
