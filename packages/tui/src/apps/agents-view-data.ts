/**
 * Pure model of the `omp agents` view: row identity, status groups and their
 * order, relative activity times, and the attention transitions (a session
 * newly waiting for input or newly failed) that ring the terminal bell.
 *
 * No TUI instance or theme state is needed, so the CLI's plain listing and
 * the tests share it with the interactive app.
 */
import { sanitizeDisplayLine } from "../overlays/extensions/display-text";
import { shortenPath } from "../render/render-utils";

/** Session status as published by the agents status records. */
export type AgentsViewStatus = "starting" | "waiting" | "compacting" | "error" | "running" | "idle";

/**
 * One live session as the view shows it. Structurally matches the coding
 * agent's `AgentSessionRow`, so its rows are passed through unchanged.
 */
export interface AgentsViewRow {
	instanceId?: string;
	pid?: number;
	/** Daemon unit key of a hosted (background) session. */
	hostKey?: string;
	/** Whether the session runs in the daemon and can be attached; false for foreground terminals. */
	attachable: boolean;
	sessionId?: string;
	sessionFile?: string;
	title: string;
	cwd: string;
	model?: string;
	status: AgentsViewStatus;
	detail?: string;
	lastActivityAt: number;
	startedAt: number;
	/** Hosted units of other processes on the same session; stopping the row stops them too. */
	duplicateHostKeys?: string[];
}

export type AgentsViewGroupId = "waiting" | "error" | "working" | "idle";

export interface AgentsViewGroup {
	id: AgentsViewGroupId;
	label: string;
	rows: AgentsViewRow[];
}

/** Display order of the groups: what needs the user first, idle sessions last. */
const GROUP_ORDER: readonly { id: AgentsViewGroupId; label: string }[] = [
	{ id: "waiting", label: "Needs input" },
	{ id: "error", label: "Error" },
	{ id: "working", label: "Working" },
	{ id: "idle", label: "Idle" },
];

const STATUS_GROUP: Record<AgentsViewStatus, AgentsViewGroupId> = {
	waiting: "waiting",
	error: "error",
	running: "working",
	compacting: "working",
	starting: "working",
	idle: "idle",
};

/** Statuses that call for the user: entering one rings the bell. */
const ATTENTION: Record<AgentsViewStatus, boolean> = {
	waiting: true,
	error: true,
	running: false,
	compacting: false,
	starting: false,
	idle: false,
};

/**
 * Stable identity of a row across polls. The daemon unit key comes first: a
 * hosted session is listed as a bare `starting` unit before its process
 * publishes a status record, and must keep its selection when it does.
 */
export function agentRowKey(row: AgentsViewRow): string {
	return row.hostKey ?? row.instanceId ?? row.sessionFile ?? `${row.pid ?? "?"}:${row.cwd}:${row.startedAt}`;
}

/**
 * Rows grouped Needs input → Error → Working → Idle, empty groups dropped.
 * Within a group the newest session comes first (start time, not activity, so
 * rows do not reshuffle every time a session does something).
 */
export function groupAgentRows(rows: readonly AgentsViewRow[]): AgentsViewGroup[] {
	const buckets = new Map<AgentsViewGroupId, AgentsViewRow[]>();
	for (const row of rows) {
		const id = STATUS_GROUP[row.status] ?? "idle";
		let bucket = buckets.get(id);
		if (!bucket) {
			bucket = [];
			buckets.set(id, bucket);
		}
		bucket.push(row);
	}
	const groups: AgentsViewGroup[] = [];
	for (const { id, label } of GROUP_ORDER) {
		const bucket = buckets.get(id);
		if (!bucket || bucket.length === 0) continue;
		bucket.sort((a, b) => b.startedAt - a.startedAt || agentRowKey(a).localeCompare(agentRowKey(b)));
		groups.push({ id, label, rows: bucket });
	}
	return groups;
}

/** Rows in display order (the order selection moves through). */
export function orderAgentRows(rows: readonly AgentsViewRow[]): AgentsViewRow[] {
	return groupAgentRows(rows).flatMap(group => group.rows);
}

/** Compact relative time of `at` seen from `now`: `now`, `42s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function formatRelativeTime(at: number, now: number): string {
	const seconds = Math.floor(Math.max(0, now - at) / 1000);
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Status of each row by {@link agentRowKey}; the memory transition detection compares against. */
export type AgentStatusSnapshot = ReadonlyMap<string, AgentsViewStatus>;

export function snapshotAgentStatuses(rows: readonly AgentsViewRow[]): Map<string, AgentsViewStatus> {
	return new Map(rows.map(row => [agentRowKey(row), row.status]));
}

/**
 * Rows that just entered `waiting` or `error`: they were in another status
 * before, or appeared since the previous poll already needing attention.
 * The first poll (`previous` undefined) reports nothing, so opening the view
 * on sessions that were already waiting does not ring.
 */
export function attentionTransitions(
	previous: AgentStatusSnapshot | undefined,
	rows: readonly AgentsViewRow[],
): AgentsViewRow[] {
	if (!previous) return [];
	return rows.filter(row => ATTENTION[row.status] && previous.get(agentRowKey(row)) !== row.status);
}

/** Number of sessions waiting for the user's input. */
export function countAwaitingInput(rows: readonly AgentsViewRow[]): number {
	let count = 0;
	for (const row of rows) if (row.status === "waiting") count++;
	return count;
}

/** Window title of the view: `N awaiting input · omp agents`, or plain `omp agents`. */
export function agentsViewTitle(rows: readonly AgentsViewRow[]): string {
	const waiting = countAwaitingInput(rows);
	return waiting > 0 ? `${waiting} awaiting input · omp agents` : "omp agents";
}

/** Status word shown in listings; `fg` marks a foreground session that cannot be attached. */
export function agentStatusLabel(row: AgentsViewRow): string {
	const word = row.status === "waiting" ? "needs input" : row.status;
	return row.attachable ? word : `${word} (fg)`;
}

/**
 * Session-supplied text (title, detail, notice) as one safe display line:
 * escapes, C0/C1 controls, tabs and newlines removed, and VS16 (U+FE0F)
 * dropped. Terminals disagree on the width of a text-default symbol with
 * VS16 (`⏱️`: 2 cells in kitty/Ghostty/WezTerm, 1 in others such as
 * xterm); the width model counts 2, so the row shifts on the others.
 * Without the selector every terminal and the model agree (`⏱` is 1 cell,
 * `✅` stays 2).
 */
export function agentDisplayText(text: string | undefined): string {
	return sanitizeDisplayLine(text ?? "").replaceAll("\uFE0F", "");
}

/**
 * A session's working directory as one display line (see
 * {@link agentDisplayText}) with the home directory as `~`. Display only;
 * filter on the raw path.
 */
export function formatAgentCwd(cwd: string, homeDir?: string): string {
	return shortenPath(agentDisplayText(cwd), homeDir);
}

export type AgentsViewCommandName = "resume";

/** A slash command of the view's prompt line. */
export interface AgentsViewCommand {
	name: AgentsViewCommandName;
	/** Argument synopsis shown in the hint line. */
	args: string;
	description: string;
}

/** Every slash command the prompt line accepts. */
export const AGENTS_VIEW_COMMANDS: readonly AgentsViewCommand[] = [
	{ name: "resume", args: "[query]", description: "open a saved session in the background" },
];

/** What a submitted prompt line means. */
export type AgentsViewInput =
	| { kind: "empty" }
	| { kind: "prompt"; prompt: string }
	| { kind: "command"; name: AgentsViewCommandName; arg: string }
	| { kind: "unknown"; name: string };

/**
 * Classify a prompt line. Anything starting with `/` is a command, never a
 * new-session prompt (a `/resume` typed as a prompt would start a session
 * that resumes another one inside it); an unknown name, or none (`/ foo`),
 * is reported as unknown.
 */
export function parseAgentsViewInput(draft: string): AgentsViewInput {
	const text = draft.trim();
	if (text.length === 0) return { kind: "empty" };
	if (!text.startsWith("/")) return { kind: "prompt", prompt: text };
	const space = text.search(/\s/);
	const name = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
	const command = AGENTS_VIEW_COMMANDS.find(entry => entry.name === name);
	if (!command) return { kind: "unknown", name };
	return { kind: "command", name: command.name, arg: space < 0 ? "" : text.slice(space).trim() };
}

/** Commands to list while the user types `draft` (a `/…` line): those matching the typed name, else all. */
export function matchingAgentsViewCommands(draft: string): readonly AgentsViewCommand[] {
	const typed = (/^\s*\/(\S*)/.exec(draft)?.[1] ?? "").toLowerCase();
	const matches = AGENTS_VIEW_COMMANDS.filter(entry => entry.name.startsWith(typed));
	return matches.length > 0 ? matches : AGENTS_VIEW_COMMANDS;
}

/** How to open a picked saved session given the live ones. */
export type ResumeAction<R extends AgentsViewRow = AgentsViewRow> =
	| { kind: "attach"; hostKey: string }
	| { kind: "foreground"; row: R }
	| { kind: "launch" };

/**
 * A picked session that is already live is attached (hosted) or refused
 * (another terminal runs it); only a session no process runs is launched.
 * A second process on a live session would fork its file.
 */
export function resumeAction<R extends AgentsViewRow>(
	rows: readonly R[],
	session: { path: string; id: string },
): ResumeAction<R> {
	const live = rows.filter(row => row.sessionFile === session.path || row.sessionId === session.id);
	const hosted = live.find(row => row.attachable && row.hostKey !== undefined);
	if (hosted?.hostKey) return { kind: "attach", hostKey: hosted.hostKey };
	if (live.length > 0) return { kind: "foreground", row: live[0] };
	return { kind: "launch" };
}
