import { formatDuration, SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { DaemonState, ProcSpec, UnitScope, UnitSnapshot } from "../daemon/daemon-types";

/** The daemon answering the board, absent when the board was read from its store offline. */
export interface PsDaemonInfo {
	pid: number;
	build: string;
	startedAt: number;
}

/** Units grouped under one scope. */
export interface PsScopeReport {
	scope: UnitScope;
	units: UnitSnapshot[];
}

/** The whole board: every selected unit, grouped global → projects → sessions. */
export interface PsBoard {
	daemon?: PsDaemonInfo;
	reports: PsScopeReport[];
}

/** Project selector shared by every ps action: the current project or `--dir`. */
export interface PsTarget {
	dir?: string;
}

/** Unit states without a running process or live uptime. */
export const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

/** Combine an executable and its arguments for display; a shell process shows as the command it runs. */
export function formatCommand(spec: ProcSpec | undefined): string | undefined {
	if (!spec) return undefined;
	if (spec.args.includes(SHELL_PROCESS_SELECTOR)) return spec.args.at(-1);
	return [spec.application, ...spec.args].join(" ");
}

/** Collapse a launch command to one display line (inline scripts embed newlines/tabs). */
export function collapseCommand(command: string | undefined): string {
	return command ? command.replaceAll(/\s+/gu, " ").trim() : "";
}

/** Display name of a unit: its label, else its key. */
export function unitName(unit: UnitSnapshot): string {
	return unit.label || unit.key;
}

/** One-line unit summary used by action results and detail views. */
export function unitLabel(unit: UnitSnapshot): string {
	const pid = unit.pids.length === 0 || TERMINAL_STATES[unit.state] ? "" : ` pid=${unit.pids.join(",")}`;
	const exit = unit.exitCode === undefined ? "" : ` exit=${unit.exitCode}`;
	return `${unit.kind} ${unitName(unit)}: ${unit.state}${pid}${exit}`;
}

/** Colored STATE cell, e.g. `ready`, `exited(143)`. */
export function stateCell(unit: UnitSnapshot): string {
	let text: string = unit.state;
	if (TERMINAL_STATES[unit.state] && unit.exitCode !== undefined) text += `(${unit.exitCode})`;
	const paint =
		unit.state === "ready" || unit.state === "running"
			? chalk.green
			: unit.state === "failed"
				? chalk.red
				: TERMINAL_STATES[unit.state]
					? chalk.dim
					: chalk.yellow;
	return paint(text);
}

/** Display lifetime and supervision flags for a unit. */
export function flagsCell(unit: UnitSnapshot): string {
	const parts: string[] = [];
	if (unit.policy.hold !== "leases") parts.push(unit.policy.hold);
	if (!unit.supervised && !TERMINAL_STATES[unit.state]) parts.push("unsupervised");
	return parts.join(",");
}

/** Display elapsed runtime, or a dash for a terminal unit. */
export function uptimeCell(unit: UnitSnapshot): string {
	if (TERMINAL_STATES[unit.state]) return "-";
	return formatDuration(Date.now() - unit.startedAt);
}

/** Countdown to the idle policy stopping the unit, or a dash while it is held. */
export function idleCell(unit: UnitSnapshot): string {
	if (unit.idleAt === undefined || TERMINAL_STATES[unit.state]) return "-";
	return `in ${formatDuration(Math.max(0, unit.idleAt - Date.now()))}`;
}

/** Process ids of a live unit, or a dash. */
export function pidsCell(unit: UnitSnapshot): string {
	return unit.pids.length > 0 && !TERMINAL_STATES[unit.state] ? unit.pids.join(",") : "-";
}

/** Labels aligned with the board table's display cells. */
export const TABLE_HEADER = [
	"KIND",
	"NAME",
	"STATE",
	"PID",
	"UPTIME",
	"LEASES",
	"IDLE",
	"RESTARTS",
	"FLAGS",
	"COMMAND",
];

/** Raw (possibly colored) cells for one unit, aligned with {@link TABLE_HEADER}. */
export function tableCells(unit: UnitSnapshot): string[] {
	return [
		unit.kind,
		unitName(unit),
		stateCell(unit),
		pidsCell(unit),
		uptimeCell(unit),
		String(unit.leases),
		idleCell(unit),
		String(unit.restartCount),
		flagsCell(unit),
		collapseCommand(unit.command),
	];
}

/** Stable text form of a scope (matches `scopeKey` on the daemon wire). */
export function scopeId(scope: UnitScope): string {
	if (scope.kind === "global") return "global";
	return scope.kind === "project" ? `project:${scope.dir}` : `session:${scope.id}`;
}

/** Plain scope label, e.g. `project /work/pi`. */
export function scopeTitle(scope: UnitScope): { kind: string; name: string } {
	if (scope.kind === "global") return { kind: "global", name: "" };
	return scope.kind === "project" ? { kind: "project", name: scope.dir } : { kind: "session", name: scope.id };
}

/** Scope heading, e.g. `project /work/pi`. */
export function scopeHeader(scope: UnitScope): string {
	const { kind, name } = scopeTitle(scope);
	return name ? `${kind} ${chalk.bold(name)}` : chalk.bold(kind);
}

/** Board heading naming the daemon, or that the rows come from its store. */
export function daemonHeader(daemon: PsDaemonInfo | undefined): string {
	if (!daemon) return chalk.dim("daemon not running — showing stored units");
	return `${chalk.green(`daemon pid ${daemon.pid}`)} ${chalk.dim(`· ${daemon.build}`)}`;
}

const SCOPE_ORDER: Record<UnitScope["kind"], number> = { global: 0, project: 1, session: 2 };

function compareUnits(a: UnitSnapshot, b: UnitSnapshot): number {
	const aTerminal = TERMINAL_STATES[a.state] === true;
	const bTerminal = TERMINAL_STATES[b.state] === true;
	if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
	return a.kind.localeCompare(b.kind) || unitName(a).localeCompare(unitName(b));
}

/** Group units by scope: global first, then projects, then sessions; live units before exited ones. */
export function groupUnits(units: readonly UnitSnapshot[]): PsScopeReport[] {
	const groups = new Map<string, PsScopeReport>();
	for (const unit of units) {
		const id = scopeId(unit.scope);
		let group = groups.get(id);
		if (!group) {
			group = { scope: unit.scope, units: [] };
			groups.set(id, group);
		}
		group.units.push(unit);
	}
	const reports = [...groups.values()];
	for (const report of reports) report.units.sort(compareUnits);
	return reports.sort(
		(a, b) =>
			SCOPE_ORDER[a.scope.kind] - SCOPE_ORDER[b.scope.kind] || scopeId(a.scope).localeCompare(scopeId(b.scope)),
	);
}
