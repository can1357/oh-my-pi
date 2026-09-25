/** Session-scoped service supervision through the shared project broker. */
import * as path from "node:path";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonMonitorWatcher, DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { formatDuration, replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getDaemonRuntimeDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJobProgressDelivery } from "../async";
import { type DaemonBrokerClient, DaemonBrokerRejectedError, daemonClientForProject } from "./client";
import { canonicalProjectDir } from "./paths";
import { DAEMON_OUTPUT_MONITOR_CAPABILITY, type DaemonOperation, type DaemonRpcResult } from "./protocol";
import {
	beginLocalStop,
	bindCompletionOperation,
	DETACHED_MONITOR_ERROR,
	detachOutputSink,
	monitorStopReason,
	type OutputLease,
	registerCompletionSink,
	releaseCompletionDaemonAssociation,
	registerOutputSink,
} from "./service-monitor";
import { renderTerminalOutputIsolated } from "./terminal-output-worker-client";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";

import { cfgLaunchEnabled } from "../tools/settings";

export interface ServiceReady {
	log?: string;
	port?: number;
	host?: string;
	timeout?: number;
}
/** Live output delivery for a service monitor; `off` leaves (or makes) the service unmonitored. */
export type ServiceProgress = AsyncJobProgressDelivery | "off";

export interface ServiceStart {
	name: string;
	command: string;
	cwd?: string;
	pty?: boolean;
	env?: Record<string, string>;
	ready?: ServiceReady;
	/** Attach this session's live output monitor before launch; omitted or `off` starts unmonitored. */
	progress?: ServiceProgress;
}

const serviceStateKey = Symbol("ownedServices");
interface ServiceSession extends ToolSession {
	[serviceStateKey]?: {
		owned: Map<string, { id: string; startedAt: number }>;
		listeners: Set<() => void>;
	};
}
function serviceState(session: ToolSession): NonNullable<ServiceSession[typeof serviceStateKey]> {
	return ((session as ServiceSession)[serviceStateKey] ??= {
		owned: new Map(),
		listeners: new Set(),
	});
}

export function hasLiveOwnedService(session: ToolSession): boolean {
	return ((session as ServiceSession)[serviceStateKey]?.owned.size ?? 0) > 0;
}

export function waitForOwnedServiceCompletion(session: ToolSession, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || !hasLiveOwnedService(session)) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const pending = serviceState(session).listeners;
	const finish = (): void => {
		pending.delete(finish);
		signal?.removeEventListener("abort", finish);
		resolve();
	};
	pending.add(finish);
	signal?.addEventListener("abort", finish, { once: true });
	return promise;
}

function serviceOwner(session: ToolSession): string | null | undefined {
	return session.getSessionId?.() ?? session.getAgentId?.();
}

function track(session: ToolSession, daemon: DaemonSnapshot): void {
	const owner = serviceOwner(session);
	if (daemon.owner !== owner) return;
	const services = serviceState(session).owned;
	if (TERMINAL_STATES[daemon.state]) services.delete(daemon.name);
	else services.set(daemon.name, { id: daemon.id, startedAt: daemon.startedAt });
}

function subscribe(session: ToolSession, client: DaemonBrokerClient, epoch: number) {
	const owner = serviceOwner(session);
	if (!owner) return undefined;
	return registerCompletionSink(
		session,
		client,
		owner,
		epoch,
		notification => {
			const tracked = serviceState(session).owned.get(notification.daemon.name);
			if (tracked?.id === notification.daemon.id && tracked.startedAt === notification.daemon.startedAt) {
				track(session, notification.daemon);
				for (const listener of serviceState(session).listeners) listener();
			}
		},
		() => {
			serviceState(session).owned.clear();
			for (const listener of serviceState(session).listeners) listener();
		},
	);
}

function assertOperationEpoch(session: ToolSession, epoch: number): void {
	if (session.isDisposed?.() || (session.captureLaunchProgressEpoch?.() ?? 0) !== epoch) {
		throw new ToolError("The session context changed before the service operation settled");
	}
}

async function request(
	session: ToolSession,
	operation: DaemonOperation,
	signal?: AbortSignal,
	brokerClient?: DaemonBrokerClient,
	epoch = session.captureLaunchProgressEpoch?.() ?? 0,
	onDispatch?: (state: "written") => void,
): Promise<DaemonRpcResult> {
	const client = brokerClient ?? (await daemonClientForProject(session.cwd));
	assertOperationEpoch(session, epoch);
	const registration = subscribe(session, client, epoch);
	const result = await client.request(operation, signal, onDispatch);
	if ((session.captureLaunchProgressEpoch?.() ?? 0) !== epoch || session.isDisposed?.() || registration?.active === false) {
		return result;
	}
	if (result.op === "list") serviceState(session).owned.clear();
	const daemons = result.op === "list" ? result.daemons : "daemon" in result ? [result.daemon] : [];
	for (const daemon of daemons) {
		track(session, daemon);
		if (registration && result.op !== "start" && daemon.owner === serviceOwner(session) && !TERMINAL_STATES[daemon.state]) {
			if (!registration.daemonEpochs.has(daemon.id)) {
				registration.daemonEpochs.set(daemon.id, registration.fallbackEpoch);
			}
			registration.daemonNames.set(daemon.id, daemon.name);
		}
	}
	return result;
}

export async function listServices(session: ToolSession, signal?: AbortSignal): Promise<DaemonSnapshot[]> {
	return (await listServicesWithMonitors(session, signal)).daemons;
}

/** Services plus every live output monitor; `monitors` is absent from brokers that predate watcher reporting. */
export async function listServicesWithMonitors(
	session: ToolSession,
	signal?: AbortSignal,
): Promise<{ daemons: DaemonSnapshot[]; monitors?: DaemonMonitorWatcher[] }> {
	const result = await request(session, { op: "list" }, signal);
	if (result.op !== "list") throw new Error("Unexpected daemon list response");
	return { daemons: result.daemons, ...(result.monitors ? { monitors: result.monitors } : {}) };
}

export async function findService(
	session: ToolSession,
	name: string,
	signal?: AbortSignal,
): Promise<DaemonSnapshot | undefined> {
	return (await listServices(session, signal)).find(daemon => daemon.name === name);
}

export async function serviceLogPath(session: ToolSession, name: string): Promise<string> {
	const canonical = await canonicalProjectDir(session.cwd);
	return path.join(getDaemonRuntimeDir(canonical), "daemons", name, "output.log");
}

/** Render legacy broker PTY bytes outside the client process. */
export async function renderServiceLogTerminalRows(
	result: Extract<DaemonRpcResult, { op: "logs" }>,
	lines = 1_000,
): Promise<string[] | undefined> {
	if (result.terminalRows !== undefined) return result.terminalRows;
	if (result.terminalText === undefined) return undefined;
	return renderTerminalOutputIsolated(result.terminalText, { head: false, maxRows: lines });
}

export async function serviceLogsWithRows(
	session: ToolSession,
	name: string,
	signal?: AbortSignal,
): Promise<{ text: string; terminalRows?: string[] }> {
	const result = await request(
		session,
		{
			op: "logs",
			name,
			lines: 1_000,
			head: false,
			follow: false,
			timeoutMs: 1_000,
			renderTerminalRows: true,
		},
		signal,
	);
	if (result.op !== "logs") throw new Error("Unexpected daemon logs response");
	const rows = await renderServiceLogTerminalRows(result).catch(() => undefined);
	return {
		text: replaceTabs(sanitizeText(rows?.join("\n") ?? result.text)),
		...(rows ? { terminalRows: rows } : {}),
	};
}

export async function serviceLogs(session: ToolSession, name: string, signal?: AbortSignal): Promise<string> {
	return (await serviceLogsWithRows(session, name, signal)).text;
}

export async function startService(
	session: ToolSession,
	params: ServiceStart,
	signal?: AbortSignal,
): Promise<{
	daemon: DaemonSnapshot;
	readyTimedOut: boolean;
	log: string;
	monitorStopped?: string;
}> {
	if (!cfgLaunchEnabled.get(session.settings)) throw new ToolError("Service launch is disabled in this session.");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(params.name))
		throw new ToolError("Service name must be 1-48 letters, numbers, dots, underscores, or hyphens");
	const ready = params.ready;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535))
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	if (ready?.log) {
		try {
			new RegExp(ready.log, "u");
		} catch (error) {
			throw new ToolError(`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const shell = session.settings.getShellConfig();
	const spec: DaemonSpec = {
		name: params.name,
		application: shell.shell,
		args: [...shell.args, `${shell.prefix ? `${shell.prefix} ` : ""}${params.command}`],
		env: { ...shell.env, ...params.env },
		cwd: resolveToCwd(params.cwd ?? session.cwd, session.cwd),
		pty: params.pty ?? true,
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: Math.round(Math.max(0.05, Math.min(3_600, ready.timeout ?? 30)) * 1_000),
				}
			: undefined,
		restart: "no",
		persist: false,
		detached: false,
	};
	const delivery = params.progress === "off" ? undefined : params.progress;
	if (delivery && session.processProgressMode !== "session") {
		throw new ToolError("Live process progress monitoring is unavailable in this tool session");
	}
	const owner = serviceOwner(session) ?? undefined;
	if (delivery && !owner) throw new ToolError("Live progress monitoring requires a session owner");
	const epoch = session.captureLaunchProgressEpoch?.() ?? 0;
	const client = await daemonClientForProject(session.cwd);
	assertOperationEpoch(session, epoch);
	const completion = bindCompletionOperation(subscribe(session, client, epoch), params.name, epoch);
	const dispatch: { state: "local" | "written" } = { state: "local" };
	let lease: OutputLease | undefined;
	let result: DaemonRpcResult;
	try {
		if (delivery && owner) {
			await requireOutputMonitor(client, signal);
			// Advertise the start-pending subscription after all local and broker
			// validation, but before the launch request, so early output cannot be lost.
			lease = await registerOutputSink(session, client, params.name, owner, delivery, true, epoch);
			if (!lease) throw new ToolError("This session cannot accept service progress delivery");
		}
		result = await request(session, { op: "start", spec, owner, replace: true }, signal, client, epoch, state => {
			dispatch.state = state;
		});
		if (result.op !== "start") throw new Error("Unexpected daemon start response");
		completion?.accept(result.daemon.id);
		if (lease) {
			lease.bindDaemon(result.daemon.id);
			lease.registration.startedAt = result.daemon.startedAt;
			await lease.retain();
		}
	} catch (error) {
		if (dispatch.state === "written" && !(error instanceof DaemonBrokerRejectedError)) completion?.preserve();
		else completion?.reject();
		await rollbackMonitorLease(lease, params.name);
		throw error;
	}
	return {
		daemon: result.daemon,
		readyTimedOut: result.readyTimedOut,
		log: (session.captureLaunchProgressEpoch?.() ?? 0) === epoch && !session.isDisposed?.()
			? await serviceLogs(session, params.name, signal)
			: "",
		...(lease ? { monitorStopped: monitorStopReason(lease.registration) } : {}),
	};
}

/**
 * Attach, retune, or detach this session's live output monitor on a running
 * service. Monitoring starts at the current output cursor (it never replays
 * logs) and never changes the service's lifecycle. `detached` reports whether
 * an `off` request actually removed a monitor.
 */
export async function monitorService(
	session: ToolSession,
	name: string,
	progress: ServiceProgress,
	signal?: AbortSignal,
): Promise<{ daemon: DaemonSnapshot; detached?: boolean }> {
	if (!cfgLaunchEnabled.get(session.settings)) throw new ToolError("Service launch is disabled in this session.");
	const delivery = progress === "off" ? undefined : progress;
	if (delivery && session.processProgressMode !== "session") {
		throw new ToolError("Live process progress monitoring is unavailable in this tool session");
	}
	const owner = serviceOwner(session) ?? undefined;
	if (delivery && !owner) throw new ToolError("Live progress monitoring requires a session owner");
	const epoch = session.captureLaunchProgressEpoch?.() ?? 0;
	const client = await daemonClientForProject(session.cwd);
	assertOperationEpoch(session, epoch);
	const registration = subscribe(session, client, epoch);
	const completion = delivery ? bindCompletionOperation(registration, name, epoch) : undefined;
	let lease: OutputLease | undefined;
	let daemon: DaemonSnapshot;
	try {
		if (delivery) await requireOutputMonitor(client, signal);
		const result = await request(session, { op: "describe", name }, signal, client, epoch);
		if (result.op !== "describe") throw new Error("Unexpected daemon describe response");
		daemon = result.daemon;
		assertOperationEpoch(session, epoch);
		if (!delivery || !owner) return { daemon, detached: await detachOutputSink(session, client, name) };
		if (daemon.detached) throw new ToolError(DETACHED_MONITOR_ERROR);
		if (TERMINAL_STATES[daemon.state]) throw new ToolError(`Cannot monitor ${name}: service is ${daemon.state}`);
		lease = await registerOutputSink(session, client, name, owner, delivery, false, epoch, daemon.id);
		if (!lease) throw new ToolError("This session cannot accept service progress delivery");
		lease.bindDaemon(daemon.id);
		lease.registration.startedAt = daemon.startedAt;
		completion?.accept(daemon.id);
		await lease.retain();
		const stopped = monitorStopReason(lease.registration);
		if (stopped !== undefined) throw new ToolError(`Cannot monitor ${name}: ${stopped}`);
	} catch (error) {
		completion?.reject();
		await rollbackMonitorLease(lease, name);
		throw error;
	}
	return { daemon };
}

async function requireOutputMonitor(client: DaemonBrokerClient, signal?: AbortSignal): Promise<void> {
	const ping = await client.request({ op: "ping" }, signal);
	if (ping.op !== "ping" || !ping.capabilities?.includes(DAEMON_OUTPUT_MONITOR_CAPABILITY)) {
		throw new ToolError("The running daemon broker cannot monitor output; restart it with this omp build");
	}
}

/** Undo a monitor lease whose operation failed; a rollback failure must not mask the operation's error. */
async function rollbackMonitorLease(lease: OutputLease | undefined, name: string): Promise<void> {
	try {
		await lease?.reject();
	} catch (error) {
		logger.warn("Service monitor lease rollback failed", {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function sendService(
	session: ToolSession,
	name: string,
	content: string,
	signal?: AbortSignal,
): Promise<DaemonSnapshot> {
	const data = /[\r\n]$/.test(content) ? content : `${content}\r`;
	const result = await request(session, { op: "send", name, data }, signal);
	if (result.op !== "send") throw new Error("Unexpected daemon send response");
	return result.daemon;
}

export async function stopService(session: ToolSession, name: string, signal?: AbortSignal): Promise<DaemonSnapshot> {
	const epoch = session.captureLaunchProgressEpoch?.() ?? 0;
	const client = await daemonClientForProject(session.cwd);
	assertOperationEpoch(session, epoch);
	// A terminal stop response is this session's completion surface; a monitor
	// notification racing it must not synthesize a second one.
	const localStop = beginLocalStop(session, client, name);
	let result: DaemonRpcResult;
	try {
		result = await request(session, { op: "stop", name, timeoutMs: 5_000 }, signal, client, epoch);
		if (result.op !== "stop") throw new Error("Unexpected daemon stop response");
	} catch (error) {
		localStop?.settle("failed");
		throw error;
	}
	localStop?.settle(TERMINAL_STATES[result.daemon.state] ? "terminal" : "non-terminal");
	const owner = serviceOwner(session);
	if (owner && TERMINAL_STATES[result.daemon.state] && (session.captureLaunchProgressEpoch?.() ?? 0) === epoch) {
		releaseCompletionDaemonAssociation(session, client, owner, result.daemon.id);
	}
	return result.daemon;
}

export async function modeService(
	session: ToolSession,
	name: string,
	mode: "persist" | "session" | "detached",
	signal?: AbortSignal,
): Promise<DaemonSnapshot> {
	const result = await request(session, { op: "mode", name, mode }, signal);
	if (result.op !== "mode") throw new Error("Unexpected daemon mode response");
	return result.daemon;
}

export function serviceStatus(daemon: DaemonSnapshot): string {
	const age = formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt));
	return `${daemon.name} [service] — ${daemon.state} — up ${age}${daemon.pid === undefined ? "" : ` — pid ${daemon.pid}`}${daemon.persist ? " — persistent" : ""}${daemon.detached ? " — detached" : ""}`;
}
