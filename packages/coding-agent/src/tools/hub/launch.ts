/**
 * Hub launch half — supervision of project-scoped long-running processes
 * (dev servers, watchers, debuggers, REPLs) through the shared daemon broker.
 * Hub ops map 1:1 onto broker operations; the hub's `ps` op is the broker's
 * `list`, and `send`/`wait` route here when they carry a process `name`.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { type DaemonBrokerClient, DaemonBrokerRejectedError, daemonClientForProject } from "../../launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot, DaemonSpec, DaemonState } from "../../launch/protocol";
import { renderTerminalOutputIsolated } from "../../launch/terminal-output-worker-client";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../../tui";
import type { ToolSession } from "..";
import { resolveToCwd } from "../path-utils";
import {
	capPreviewLines,
	createCachedComponent,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	pluralize,
	previewLine,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render-utils";
import { styleTerminalRow } from "../terminal-output";
import { ToolError } from "../tool-errors";

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

/** Broker-facing launch parameters; the hub adapts its `ps` op to `list` before calling in. */
export interface LaunchParams {
	op: "start" | "list" | "logs" | "wait" | "send" | "stop" | "restart" | "describe";
	name?: string;
	application?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	pty?: boolean;
	ready?: { log?: string; port?: number; host?: string; timeout?: number };
	restart?: "no" | "on-failure" | "always";
	persist?: boolean;
	detached?: boolean;
	lines?: number;
	head?: boolean;
	grep?: string;
	follow?: boolean;
	cursor?: number;
	for?: "ready" | "exit";
	pattern?: string;
	text?: string;
	enter?: boolean;
	keys?: string[];
	signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";
	timeout?: number;
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

/** Terminal daemon lifecycle states — the process is no longer running. */
const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

/** Structured launch state retained for compact TUI rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	cursor?: number;
	timedOut?: boolean;
	/** logs: daemon lifecycle state at read time. */
	state?: DaemonState;
	/** logs: virtual terminal rows for display; model-facing content remains sanitized text. */
	terminalRows?: string[];
	/** wait: output line that satisfied the pattern. */
	matched?: string;
	/** describe: immutable launch spec backing the command/cwd detail lines. */
	spec?: DaemonSpec;
}

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

/**
 * Human sentences for the readiness conditions still unmet, e.g.
 * `port 5173 on 127.0.0.1 never accepted connections`. `ready` (from the start
 * params) adds the concrete pattern/port; absent it falls back to generic labels.
 */
function readyPendingSummary(daemon: DaemonSnapshot, ready?: LaunchParams["ready"]): string[] {
	const parts: string[] = [];
	for (const condition of daemon.readyPending ?? []) {
		if (condition === "log") {
			parts.push(ready?.log ? `log pattern /${ready.log}/ never matched` : "the log pattern never matched");
		} else {
			parts.push(
				ready?.port !== undefined
					? `port ${ready.port} on ${ready.host ?? "127.0.0.1"} never accepted connections`
					: "the port never accepted connections",
			);
		}
	}
	return parts;
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
				const pending = readyPendingSummary(result.daemon);
				lines.push(`Wait timed out${pending.length > 0 ? ` (still waiting on: ${pending.join("; ")})` : ""}.`);
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

// =============================================================================
// TUI Renderer (launch half)
// =============================================================================

/** Args shape visible to the renderer, possibly mid-stream (every field optional). */
export type LaunchRenderArgs = Partial<Omit<LaunchParams, "op">> & { op?: string };

function stateColor(state: DaemonState): ThemeColor {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "failed":
			return "error";
		case "exited":
			return "muted";
		default:
			return "warning";
	}
}

/** Compact `state · pid · uptime` fragments for the status-line meta slot. */
function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const meta = [theme.fg(stateColor(daemon.state), daemon.state)];
	if (daemon.readyPending?.length) meta.push(theme.fg("warning", `waiting on ${daemon.readyPending.join("+")}`));
	if (daemon.exitCode !== undefined) {
		meta.push(theme.fg(daemon.exitCode === 0 ? "muted" : "error", `exit ${daemon.exitCode}`));
	} else if (daemon.pid !== undefined) {
		meta.push(`pid ${daemon.pid}`);
	}
	const lifespan = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	meta.push(daemon.exitedAt === undefined ? `up ${lifespan}` : `ran ${lifespan}`);
	if (daemon.restartCount > 0) meta.push(`restarts ${daemon.restartCount}`);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
}

/** Op-specific call context (command line, log filters, wait condition, send payload). */
function callMeta(args: LaunchRenderArgs): string[] {
	const meta: string[] = [];
	switch (args.op) {
		case "start":
			if (args.application) meta.push([args.application, ...(args.args ?? [])].join(" "));
			break;
		case "logs":
			if (args.follow) meta.push("follow");
			if (args.grep) meta.push(`grep /${args.grep}/`);
			break;
		case "wait":
			meta.push(args.pattern ? `for /${args.pattern}/` : `for ${args.for ?? "exit"}`);
			break;
		case "send":
			if (args.signal) meta.push(args.signal);
			else if (args.text) meta.push(args.text);
			if (args.keys?.length) meta.push(args.keys.join(" "));
			break;
	}
	return meta.map(entry => previewLine(replaceTabs(entry), TRUNCATE_LENGTHS.SHORT));
}

/** Pending-call frame for launch ops; consumes the spinner while the broker call is live. */
export function launchRenderCall(args: LaunchRenderArgs, options: RenderResultOptions, theme: Theme): Component {
	const target = args.name ?? args.application;
	const header = renderStatusLine(
		{
			icon: options.spinnerFrame !== undefined ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: `Launch ${args.op ?? "…"}`,
			description: target ? replaceTabs(target) : undefined,
			meta: callMeta(args),
		},
		theme,
	);
	return new Text(header, 0, 0);
}

/** Result frame: one status header per op, meta from structured details, capped body lines. */
export function launchRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: LaunchToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: LaunchRenderArgs,
): Component {
	const details = result.details;
	const params = args ?? {};
	const op = details?.op ?? params.op;
	const isError = result.isError === true;
	const daemon = details?.daemon;
	const failed = isError || daemon?.state === "failed";
	const text =
		result.content
			?.filter(item => item.type === "text")
			.map(item => item.text ?? "")
			.join("\n") ?? "";

	const meta: string[] = [];
	const body: string[] = [];
	let description = params.name ?? daemon?.name;

	if (isError) {
		for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("error", line));
	} else {
		switch (op) {
			case "start": {
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (daemon?.readyMatch) body.push(theme.fg("dim", `log matched: ${replaceTabs(daemon.readyMatch)}`));
				if (daemon?.state === "failed" && daemon.exitReason)
					body.push(theme.fg("error", replaceTabs(daemon.exitReason)));
				if (details?.timedOut) {
					const pending = daemon ? readyPendingSummary(daemon, params.ready) : [];
					body.push(
						theme.fg(
							"warning",
							pending.length > 0
								? `Not ready — ${pending.join("; ")}. Still running.`
								: "Readiness timed out; the process is still running.",
						),
					);
				} else if (params.ready && daemon && daemon.readyAt === undefined && TERMINAL_STATES[daemon.state]) {
					body.push(theme.fg("warning", "Process exited before readiness was observed."));
				}
				break;
			}
			case "send":
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "stop":
			case "restart":
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "wait": {
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (details?.matched) body.push(theme.fg("dim", `matched: ${replaceTabs(details.matched)}`));
				if (details?.timedOut) {
					const pending = daemon ? readyPendingSummary(daemon) : [];
					body.push(
						theme.fg(
							"warning",
							pending.length > 0
								? `Wait timed out — still waiting on ${pending.join("; ")}.`
								: "Wait timed out.",
						),
					);
				}
				break;
			}
			case "list": {
				const daemons = details?.daemons ?? [];
				description = `${daemons.length || "no"} ${pluralize("process", daemons.length)}`;
				for (const item of daemons) {
					body.push(
						`${theme.fg("accent", replaceTabs(item.name))} ${theme.fg("dim", daemonMeta(item, theme).join(theme.sep.dot))}`,
					);
				}
				break;
			}
			case "logs": {
				if (details?.state) meta.push(theme.fg(stateColor(details.state), details.state));
				if (details?.cursor !== undefined) meta.push(`cursor ${details.cursor}`);
				if (details?.timedOut) meta.push(theme.fg("warning", "follow timed out"));
				// Strip the trailing `[name: state; cursor=N]` status suffix `toolContent` appends.
				const logText = text.replace(/\n?\[[^\n]*\]$/, "").trimEnd();
				const terminalRows = details?.terminalRows;
				if (terminalRows) {
					for (const row of terminalRows) body.push(styleTerminalRow(row, theme.getFgAnsi("toolOutput")));
				} else if (logText) {
					for (const line of logText.split("\n")) body.push(theme.fg("toolOutput", replaceTabs(line)));
				}
				break;
			}
			case "describe": {
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				const spec = details?.spec;
				if (spec) {
					body.push(theme.fg("toolOutput", replaceTabs([spec.application, ...spec.args].join(" "))));
					body.push(theme.fg("dim", `cwd ${shortenPath(spec.cwd)}`));
					const flags = [`pty ${spec.pty}`, `restart ${spec.restart}`];
					if (spec.detached) flags.push("detached");
					else if (spec.persist) flags.push("persistent");
					body.push(theme.fg("dim", flags.join(theme.sep.dot)));
				}
				break;
			}
			default:
				if (text.trim()) {
					for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("toolOutput", line));
				}
		}
	}

	const header = renderStatusLine(
		{
			...(failed
				? { icon: "error" as const }
				: options.isPartial
					? { icon: "pending" as const }
					: { iconOverride: theme.styledSymbol("tool.launch", "accent") }),
			title: `Launch ${op ?? ""}`.trimEnd(),
			description: description ? replaceTabs(description) : undefined,
			meta,
		},
		theme,
	);

	if (op === "logs") {
		return framedBlock(theme, width => {
			const innerWidth = outputBlockContentWidth(width);
			const rows = body.map(line => truncateToWidth(line, innerWidth));
			return {
				header,
				state: options.isPartial ? "pending" : failed ? "error" : "success",
				sections: [
					{
						label: theme.fg("toolTitle", "Output"),
						lines: capPreviewLines(rows, theme, {
							expanded: options.expanded,
							max: DEFAULT_TERMINAL_PREVIEW_LINES,
						}),
					},
				],
				width,
			};
		});
	}

	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			let visible = body;
			if (!expanded && op === "list" && body.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
				const remaining = body.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
				visible = [
					...body.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS),
					theme.fg("dim", `${formatMoreItems(remaining, "process")} ${formatExpandHint(theme, false, true)}`),
				];
			}
			return [header, ...visible].map(line => truncateToWidth(line, width));
		},
	);
}
