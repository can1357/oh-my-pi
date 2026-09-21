import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import {
	type LaunchParams,
	type LaunchToolDetails,
	readyPendingSummary,
	waitPendingSummary,
} from "@oh-my-pi/pi-tui/tools/hub";
/**
 * Hub launch half — supervision of project-scoped long-running processes
 * (dev servers, watchers, debuggers, REPLs) through the shared daemon broker.
 * Hub ops map 1:1 onto broker operations; the hub's `ps` op is the broker's
 * `list`, and `send`/`wait` route here when they carry a process `name`.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

import { sanitizeText } from "@oh-my-pi/pi-utils";

import { type DaemonBrokerClient, DaemonBrokerRejectedError, daemonClientForProject } from "../../launch/client";
import type { DaemonOperation, DaemonRpcResult } from "../../launch/protocol";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/hub";
import { renderTerminalOutputIsolated } from "../../launch/terminal-output-worker-client";

import type { ToolSession } from "..";
import { resolveToCwd } from "../path-utils";
import { formatDuration, replaceTabs, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

interface CompletionRegistration {
	inFlight: number;
	retained: boolean;
	active: boolean;
	cleanup: (preservePending?: boolean) => void;
}

interface CompletionLease {
	retain: () => void;
	reject: (preservePending?: boolean) => void;
	hasConcurrentRequest: () => boolean;
}

const completionRegistrations = new WeakMap<
	ToolSession,
	Map<DaemonBrokerClient, Map<string, CompletionRegistration>>
>();

function registerCompletionSink(
	session: ToolSession,
	client: DaemonBrokerClient,
	owner: string,
): CompletionLease | undefined {
	if (!session.queueLaunchCompletion) return undefined;
	let clients = completionRegistrations.get(session);
	if (!clients) {
		clients = new Map();
		completionRegistrations.set(session, clients);
	}
	let owners = clients.get(client);
	if (!owners) {
		owners = new Map();
		clients.set(client, owners);
	}
	let registration = owners.get(owner);
	if (!registration) {
		const unregister = client.onCompletion(owner, notification => {
			if (session.isDisposed?.()) throw new Error("Session disposed before launch completion delivery");
			const delivery = session.queueLaunchCompletion?.(notification);
			if (!delivery) throw new Error("Session cannot accept launch completion delivery");
			return delivery;
		});
		// oxlint-disable-next-line prefer-const -- read by the cleanup closure before assignment
		let unregisterDispose: (() => void) | void;
		// oxlint-disable-next-line prefer-const -- read by the cleanup closure before assignment
		let unregisterSessionChange: (() => void) | void;
		const cleanup = (preservePending = false): void => {
			if (!registration?.active) return;
			registration.active = false;
			unregister({ preservePending });
			unregisterDispose?.();
			unregisterSessionChange?.();
			owners.delete(owner);
			if (owners.size === 0) clients.delete(client);
			if (clients.size === 0) completionRegistrations.delete(session);
		};
		registration = { inFlight: 0, retained: false, active: true, cleanup };
		owners.set(owner, registration);
		unregisterDispose = session.registerDisposeCallback?.(() => cleanup(true));
		unregisterSessionChange = session.registerSessionChangeCallback?.(() => cleanup(true));
	}
	registration.inFlight++;
	let settled = false;
	const settle = (retain: boolean, preservePending = false): void => {
		if (settled || !registration.active) return;
		settled = true;
		registration.inFlight--;
		if (retain) registration.retained = true;
		if (!registration.retained && registration.inFlight === 0) registration.cleanup(preservePending);
	};
	return {
		retain: () => settle(true),
		hasConcurrentRequest: () => registration.active && registration.inFlight > 1,
		reject: preservePending => settle(false, preservePending),
	};
}

const KEY_INPUT: Record<string, string> = {
	ENTER: "\r",
	TAB: "\t",
	ESCAPE: "\u001b",
	CTRL_C: "\u0003",
	CTRL_D: "\u0004",
	UP: "\u001b[A",
	DOWN: "\u001b[B",
	RIGHT: "\u001b[C",
	LEFT: "\u001b[D",
};

function requiredName(params: LaunchParams): string {
	if (!params.name) throw new ToolError(`${params.op} requires name`);
	return params.name;
}

function timeoutMs(value: number | undefined, fallbackSeconds: number): number {
	const seconds = Math.max(0.05, Math.min(3_600, value ?? fallbackSeconds));
	return Math.round(seconds * 1_000);
}

function commandSpec(params: LaunchParams, session: ToolSession): DaemonSpec {
	const name = requiredName(params);
	if (!params.application) throw new ToolError("start requires application");
	const ready = params.ready;
	const detached = params.detached ?? false;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535)) {
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	}
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	return {
		name,
		application: params.application,
		args: params.args ?? [],
		env: params.env ?? {},
		cwd: resolveToCwd(params.cwd ?? session.cwd, session.cwd),
		pty: detached ? false : (params.pty ?? true),
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: timeoutMs(ready.timeout, 30),
				}
			: undefined,
		restart: params.restart ?? "no",
		persist: (params.persist ?? false) || detached,
		detached,
	};
}

function sendData(params: LaunchParams): string | undefined {
	let data = params.text ?? "";
	if (params.text && (params.enter ?? true)) data += KEY_INPUT.ENTER;
	for (const rawKey of params.keys ?? []) {
		const key = rawKey.trim().toUpperCase();
		const input = KEY_INPUT[key];
		if (input === undefined) throw new ToolError(`Unsupported launch key ${rawKey}`);
		data += input;
	}
	return data || undefined;
}

function operationFor(params: LaunchParams, session: ToolSession): DaemonOperation {
	switch (params.op) {
		case "start":
			return { op: "start", spec: commandSpec(params, session), owner: session.getSessionId?.() ?? undefined };
		case "list":
			return { op: "list" };
		case "logs":
			return {
				op: "logs",
				name: requiredName(params),
				lines: Math.min(1_000, Math.floor(params.lines ?? 100)),
				head: params.head ?? false,
				grep: params.grep,
				follow: params.follow ?? false,
				cursor: params.cursor,
				renderTerminalRows: true,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "wait":
			return {
				op: "wait",
				name: requiredName(params),
				for: params.for ?? "exit",
				pattern: params.pattern,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "send":
			return {
				op: "send",
				name: requiredName(params),
				data: sendData(params),
				signal: params.signal,
			};
		case "stop":
			return { op: "stop", name: requiredName(params), timeoutMs: timeoutMs(params.timeout, 5) };
		case "restart":
			return { op: "restart", name: requiredName(params) };
		case "describe":
			return { op: "describe", name: requiredName(params) };
	}
}

function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit} uptime=${formatDuration(
		(daemon.exitedAt ?? Date.now()) - daemon.startedAt,
	)} restarts=${daemon.restartCount}${daemon.detached ? " detached" : daemon.persist ? " persistent" : ""}`;
}

function toolContent(result: DaemonRpcResult, params: LaunchParams): string {
	switch (result.op) {
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
		case "start": {
			const daemon = result.daemon;
			const lines = [`${daemon.state === "failed" ? "Failed to launch" : "Started"} ${daemonLabel(daemon)}`];
			if (daemon.state === "failed" && daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			if (daemon.readyMatch) lines.push(`Ready log matched: ${daemon.readyMatch}`);
			if (result.readyTimedOut) {
				const pending = readyPendingSummary(daemon, params.ready);
				const cause = pending.length > 0 ? `: ${pending.join("; ")}` : "";
				lines.push(
					`NOT ready — readiness timed out after ${params.ready?.timeout ?? 30}s${cause}. The process is still running (state: ${daemon.state}); follow its logs or stop it.`,
				);
			} else if (params.ready && daemon.readyAt === undefined && TERMINAL_STATES[daemon.state]) {
				lines.push("Process exited before readiness was observed.");
			}
			return lines.join("\n");
		}
		case "list":
			return result.daemons.length
				? result.daemons.map(daemon => `- ${daemonLabel(daemon)}`).join("\n")
				: "No daemons.";
		case "logs": {
			const text = sanitizeText(result.text);
			return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[${result.name}: ${result.state}; cursor=${result.cursor}${result.timedOut ? "; follow timed out" : ""}]`;
		}
		case "wait": {
			const lines = [daemonLabel(result.daemon)];
			if (result.matched) lines.push(`Matched: ${result.matched}`);
			if (result.timedOut) {
				lines.push(`Wait timed out (still waiting on: ${waitPendingSummary(result.daemon, params).join("; ")}).`);
			} else if (params.pattern && result.matched === undefined) {
				lines.push(`Process exited before output pattern /${params.pattern}/ matched.`);
			}
			return lines.join("\n");
		}
		case "send":
			return `Sent input to ${daemonLabel(result.daemon)}`;
		case "stop":
			return `Stopped ${daemonLabel(result.daemon)}`;
		case "restart":
			return `Restarted ${daemonLabel(result.daemon)}`;
		case "describe":
			return [
				daemonLabel(result.daemon),
				`Command: ${[result.spec.application, ...result.spec.args].join(" ")}`,
				`Cwd: ${shortenPath(result.spec.cwd)}`,
				`PTY: ${result.spec.pty}; restart=${result.spec.restart}; persist=${result.spec.persist}; detached=${result.spec.detached}`,
			].join("\n");
	}
}

/** Resolve display rows while keeping legacy raw replay outside the client process. */
export async function renderLaunchLogTerminalRows(
	result: Extract<DaemonRpcResult, { op: "logs" }>,
	params: Pick<LaunchParams, "head" | "lines">,
): Promise<string[] | undefined> {
	if (result.terminalRows !== undefined) return result.terminalRows;
	if (result.terminalText === undefined) return undefined;
	return renderTerminalOutputIsolated(result.terminalText, {
		head: params.head ?? false,
		maxRows: Math.min(1_000, Math.floor(params.lines ?? 100)),
	});
}

async function toolDetails(result: DaemonRpcResult, params: LaunchParams): Promise<LaunchToolDetails> {
	switch (result.op) {
		case "start":
			return { op: "start", daemon: result.daemon, timedOut: result.readyTimedOut };
		case "list":
			return { op: "list", daemons: result.daemons };
		case "logs":
			return {
				op: "logs",
				cursor: result.cursor,
				timedOut: result.timedOut,
				state: result.state,
				terminalRows: await renderLaunchLogTerminalRows(result, params).catch(() => undefined),
			};
		case "wait":
			return { op: "wait", daemon: result.daemon, timedOut: result.timedOut, matched: result.matched };
		case "send":
			return { op: "send", daemon: result.daemon };
		case "stop":
			return { op: "stop", daemon: result.daemon };
		case "restart":
			return { op: "restart", daemon: result.daemon };
		case "describe":
			return { op: "describe", daemon: result.daemon, spec: result.spec };
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
	}
}

/** Run one broker operation for the calling session's project. */
export async function executeLaunch(
	session: ToolSession,
	params: LaunchParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<LaunchToolDetails>> {
	const client = await daemonClientForProject(session.cwd);
	const operation = operationFor(params, session);
	const owner = operation.op === "start" ? operation.owner : undefined;
	const resumedOwner = params.op !== "start" ? (session.getSessionId?.() ?? undefined) : undefined;
	const completionLease = owner
		? registerCompletionSink(session, client, owner)
		: resumedOwner
			? registerCompletionSink(session, client, resumedOwner)
			: undefined;
	try {
		const result = await client.request(operation, signal);
		const sessionOwner = session.getSessionId?.();
		let resumedDaemonFound = false;
		const daemons =
			result.op === "list" ? result.daemons : "daemon" in result && result.daemon ? [result.daemon] : [];
		for (const daemon of daemons) {
			if (!daemon.owner || daemon.owner !== sessionOwner || TERMINAL_STATES[daemon.state]) continue;
			resumedDaemonFound = true;
			if (daemon.owner !== resumedOwner) registerCompletionSink(session, client, daemon.owner)?.retain();
		}
		if (params.op === "list" && resumedOwner && !resumedDaemonFound) completionLease?.reject(true);
		else completionLease?.retain();
		return {
			content: [{ type: "text", text: replaceTabs(toolContent(result, params)) }],
			details: await toolDetails(result, params),
		};
	} catch (error) {
		if (error instanceof DaemonBrokerRejectedError && owner) {
			if (completionLease?.hasConcurrentRequest()) {
				completionLease.reject();
			} else {
				try {
					const listed = await client.request({ op: "list" }, signal);
					const ownerStillRunning =
						listed.op === "list" &&
						listed.daemons.some(daemon => daemon.owner === owner && !TERMINAL_STATES[daemon.state]);
					if (ownerStillRunning) completionLease?.retain();
					else completionLease?.reject(true);
				} catch {
					completionLease?.retain();
				}
			}
		} else {
			completionLease?.retain();
		}
		throw error;
	}
}
