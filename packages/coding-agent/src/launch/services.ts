/** Session-scoped service supervision through the shared project broker. */
import * as path from "node:path";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { formatDuration, replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getDaemonRuntimeDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerClient, daemonClientForProject } from "./client";
import { canonicalProjectDir } from "./paths";
import type { DaemonOperation, DaemonRpcResult } from "./protocol";
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
export interface ServiceStart {
	name: string;
	command: string;
	cwd?: string;
	pty?: boolean;
	env?: Record<string, string>;
	ready?: ServiceReady;
}

const serviceStateKey = Symbol("ownedServices");
interface ServiceSession extends ToolSession {
	[serviceStateKey]?: {
		owned: Map<string, { id: string; startedAt: number }>;
		listeners: Set<() => void>;
		subscribed: Set<DaemonBrokerClient>;
	};
}
function serviceState(session: ToolSession): NonNullable<ServiceSession[typeof serviceStateKey]> {
	return ((session as ServiceSession)[serviceStateKey] ??= {
		owned: new Map(),
		listeners: new Set(),
		subscribed: new Set(),
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

function subscribe(session: ToolSession, client: DaemonBrokerClient): void {
	const owner = serviceOwner(session);
	if (!owner) return;
	const clients = serviceState(session).subscribed;
	if (clients.has(client)) return;
	clients.add(client);
	const unsubscribe = client.onCompletion(owner, notification => {
		const tracked = serviceState(session).owned.get(notification.daemon.name);
		if (tracked?.id === notification.daemon.id && tracked.startedAt === notification.daemon.startedAt) {
			track(session, notification.daemon);
			for (const listener of serviceState(session).listeners) listener();
		}
		return session.queueLaunchCompletion?.(notification);
	});
	session.registerDisposeCallback?.(() => {
		unsubscribe({ preservePending: true });
		clients.delete(client);
		serviceState(session).owned.clear();
		for (const listener of serviceState(session).listeners) listener();
	});
	session.registerSessionChangeCallback?.(() => {
		// The previous session stays resumable (`/resume`, fork parent), so keep its
		// completions queued in the broker for replay when that session id re-subscribes.
		unsubscribe({ preservePending: true });
		clients.delete(client);
		serviceState(session).owned.clear();
		for (const listener of serviceState(session).listeners) listener();
	});
}

async function request(
	session: ToolSession,
	operation: DaemonOperation,
	signal?: AbortSignal,
): Promise<DaemonRpcResult> {
	const client = await daemonClientForProject(session.cwd);
	subscribe(session, client);
	const result = await client.request(operation, signal);
	if (result.op === "list") {
		const owner = serviceOwner(session);
		serviceState(session).owned.clear();
		for (const daemon of result.daemons) if (daemon.owner === owner) track(session, daemon);
	} else if ("daemon" in result) track(session, result.daemon);
	return result;
}

export async function listServices(session: ToolSession, signal?: AbortSignal): Promise<DaemonSnapshot[]> {
	const result = await request(session, { op: "list" }, signal);
	if (result.op !== "list") throw new Error("Unexpected daemon list response");
	return result.daemons;
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
	const result = await request(
		session,
		{ op: "start", spec, owner: serviceOwner(session) ?? undefined, replace: true },
		signal,
	);
	if (result.op !== "start") throw new Error("Unexpected daemon start response");
	return {
		daemon: result.daemon,
		readyTimedOut: result.readyTimedOut,
		log: await serviceLogs(session, params.name, signal),
	};
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
	const result = await request(session, { op: "stop", name, timeoutMs: 5_000 }, signal);
	if (result.op !== "stop") throw new Error("Unexpected daemon stop response");
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
