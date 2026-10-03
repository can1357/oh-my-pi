import * as path from "node:path";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { DaemonSnapshot, DaemonSpec, DaemonState } from "../tools/daemon";

/** One broker scope: a project runtime dir or a machine-global service dir. */
export interface PsScope {
	kind: "project" | "global";
	runtimeDir: string;
	/** Canonical project dir when known; used to connect and displayed as the scope label. */
	projectDir?: string;
	/** Global service name (`kind === "global"`). */
	service?: string;
	/** Live broker PID; undefined when no broker owns the scope. */
	brokerPid?: number;
}

/** One process snapshot and its table display metadata. */
export interface PsDaemonRow {
	snapshot: DaemonSnapshot;
	/** Launch command from the persisted spec, when readable. */
	command?: string;
	cwd?: string;
	/** False when the snapshot came from disk with no live broker supervising it. */
	supervised: boolean;
}

/** Process rows grouped under their owning broker scope. */
export interface PsScopeReport {
	scope: PsScope;
	daemons: PsDaemonRow[];
}

/** Scope selector shared by every ps action: current project, `--dir`, or `--global`. */
export interface PsTarget {
	dir?: string;
	global?: string;
}

/** Process states without a running process or live uptime. */
export const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

/** Combine an executable and its arguments for display. */
export function formatCommand(spec: DaemonSpec | undefined): string | undefined {
	return spec ? [spec.application, ...spec.args].join(" ") : undefined;
}

/** Collapse a launch command to one display line (inline scripts embed newlines/tabs). */
export function collapseCommand(command: string | undefined): string {
	return command ? command.replaceAll(/\s+/gu, " ").trim() : "";
}

/** One-line daemon summary used by action results and detail views. */
export function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit}`;
}

/** Colored STATE cell, e.g. `ready`, `exited(143)`. */
export function stateCell(row: PsDaemonRow): string {
	const { snapshot } = row;
	let text: string = snapshot.state;
	if (TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined) text += `(${snapshot.exitCode})`;
	const paint =
		snapshot.state === "ready" || snapshot.state === "running"
			? chalk.green
			: snapshot.state === "failed"
				? chalk.red
				: TERMINAL_STATES[snapshot.state]
					? chalk.dim
					: chalk.yellow;
	return paint(text);
}

/** Display persistence and supervision flags for a process row. */
export function flagsCell(row: PsDaemonRow): string {
	const parts: string[] = [];
	if (row.snapshot.detached) parts.push("detached");
	else if (row.snapshot.persist) parts.push("persist");
	if (!row.supervised && !TERMINAL_STATES[row.snapshot.state]) parts.push("unsupervised");
	return parts.join(",");
}

/** Display elapsed runtime, or a dash for a terminal process. */
export function uptimeCell(snapshot: DaemonSnapshot): string {
	if (TERMINAL_STATES[snapshot.state]) return "-";
	return formatDuration(Date.now() - snapshot.startedAt);
}

/** Labels aligned with the process table's display cells. */
export const TABLE_HEADER = ["NAME", "STATE", "PID", "UPTIME", "RESTARTS", "FLAGS", "COMMAND"];

/** Raw (possibly colored) cells for one daemon row, aligned with {@link TABLE_HEADER}. */
export function tableCells(row: PsDaemonRow): string[] {
	return [
		row.snapshot.name,
		stateCell(row),
		row.snapshot.pid !== undefined && !TERMINAL_STATES[row.snapshot.state] ? String(row.snapshot.pid) : "-",
		uptimeCell(row.snapshot),
		String(row.snapshot.restartCount),
		flagsCell(row),
		collapseCommand(row.command),
	];
}

/** Scope heading, e.g. `project /work/pi — broker pid 1234`. */
export function scopeHeader(scope: PsScope): string {
	const label =
		scope.kind === "global"
			? `global ${chalk.bold(scope.service ?? path.basename(scope.runtimeDir))}`
			: `project ${chalk.bold(scope.projectDir ?? path.basename(scope.runtimeDir))}`;
	const broker =
		scope.brokerPid !== undefined ? chalk.green(`broker pid ${scope.brokerPid}`) : chalk.dim("broker not running");
	return `${label} ${chalk.dim("—")} ${broker}`;
}
