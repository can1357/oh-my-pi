import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { normalizePathForComparison, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { SessionInfo, SessionStatus } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { loadPinnedSessionIds } from "../session/session-pins";
import { shortenPath, TRUNCATE_LENGTHS } from "../tools/render-utils";

export interface SessionsCommandArgs {
	flags: {
		all: boolean;
		cwd?: string;
		json: boolean;
	};
}

export interface SessionListEntry {
	id: string;
	pinned: boolean;
	title: string | null;
	preview: string;
	cwd: string;
	path: string;
	createdAt: string | null;
	modifiedAt: string;
	status: SessionStatus;
	messageCount: number;
	sizeBytes: number;
}

export interface SessionRootEntry {
	cwd: string;
	sessionCount: number;
	pinnedCount: number;
	latestModifiedAt: string;
}

function toSessionListEntry(session: SessionInfo, pinnedIds: ReadonlySet<string>): SessionListEntry {
	const createdAt = Number.isNaN(session.created.getTime()) ? null : session.created.toISOString();
	const modifiedAt = session.modified.toISOString();
	return {
		id: session.id,
		pinned: pinnedIds.has(session.id),
		title: session.title ?? null,
		preview: truncateToWidth(
			sanitizeText(session.firstMessage).replace(/\s+/g, " ").trim() || "(no messages)",
			TRUNCATE_LENGTHS.CONTENT,
		),
		cwd: session.cwd,
		path: session.path,
		createdAt,
		modifiedAt,
		status: session.status ?? "unknown",
		messageCount: session.messageCount,
		sizeBytes: session.size,
	};
}

async function readSessionEntries(options: { all: boolean; cwd?: string }): Promise<SessionListEntry[]> {
	const sessions = options.all
		? await SessionManager.listAll()
		: await SessionManager.list(options.cwd ?? process.cwd());
	const pinnedIds = await loadPinnedSessionIds();
	return sessions.map(session => toSessionListEntry(session, pinnedIds));
}

function toSessionRootEntries(entries: SessionListEntry[]): SessionRootEntry[] {
	const roots = new Map<string, SessionRootEntry>();
	for (const entry of entries) {
		const cwd = entry.cwd.trim() || "(unknown cwd)";
		const key = entry.cwd.trim() ? normalizePathForComparison(entry.cwd) : "\0unknown-cwd";
		const root = roots.get(key);
		if (!root) {
			roots.set(key, {
				cwd,
				sessionCount: 1,
				pinnedCount: entry.pinned ? 1 : 0,
				latestModifiedAt: entry.modifiedAt,
			});
			continue;
		}
		root.sessionCount++;
		if (entry.pinned) root.pinnedCount++;
		if (entry.modifiedAt > root.latestModifiedAt) {
			root.cwd = cwd;
			root.latestModifiedAt = entry.modifiedAt;
		}
	}
	return [...roots.values()].sort(
		(left, right) => right.latestModifiedAt.localeCompare(left.latestModifiedAt) || left.cwd.localeCompare(right.cwd),
	);
}

function sessionTableCells(entry: SessionListEntry, includeCwd: boolean): string[] {
	const label =
		sanitizeText(entry.title ?? entry.preview)
			.replace(/\s+/g, " ")
			.trim() || "(no messages)";
	return [
		entry.id.slice(0, 12),
		entry.pinned ? "*" : "",
		entry.status,
		`${entry.modifiedAt.slice(0, 10)} ${entry.modifiedAt.slice(11, 16)}Z`,
		String(entry.messageCount),
		...(includeCwd ? [truncateToWidth(shortenPath(entry.cwd) || "-", TRUNCATE_LENGTHS.CONTENT)] : []),
		truncateToWidth(label, TRUNCATE_LENGTHS.CONTENT),
	];
}

function printTable(header: string[], rows: string[][]): void {
	const widths = header.map((title, column) =>
		Math.max(title.length, ...rows.map(row => Bun.stringWidth(row[column]))),
	);
	const maxWidth = process.stdout.isTTY ? (process.stdout.columns ?? 120) : Number.POSITIVE_INFINITY;
	const render = (row: string[]): string => {
		const line = `  ${row
			.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell))))
			.join("  ")}`.trimEnd();
		return Number.isFinite(maxWidth) ? truncateToWidth(line, maxWidth) : line;
	};

	process.stdout.write(`${chalk.dim(render(header))}\n`);
	for (const row of rows) process.stdout.write(`${render(row)}\n`);
}

export async function runSessionsCommand(cmd: SessionsCommandArgs): Promise<void> {
	const entries = await readSessionEntries(cmd.flags);

	if (cmd.flags.json) {
		process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
		return;
	}
	if (entries.length === 0) {
		if (cmd.flags.all) process.stdout.write(`${chalk.dim("No saved sessions found.")}\n`);
		else if (cmd.flags.cwd) process.stdout.write(`${chalk.dim(`No saved sessions in ${cmd.flags.cwd}.`)}\n`);
		else
			process.stdout.write(
				`${chalk.dim("No saved sessions in the current directory.\nUse --all to list sessions from every project.")}\n`,
			);
		return;
	}
	printTable(
		["ID", "PIN", "STATUS", "MODIFIED", "MSGS", ...(cmd.flags.all ? ["CWD"] : []), "TITLE / PREVIEW"],
		entries.map(entry => sessionTableCells(entry, cmd.flags.all)),
	);
}

export async function runSessionRootsCommand(json: boolean): Promise<void> {
	const roots = toSessionRootEntries(await readSessionEntries({ all: true }));

	if (json) {
		process.stdout.write(`${JSON.stringify(roots, null, 2)}\n`);
		return;
	}
	if (roots.length === 0) {
		process.stdout.write(`${chalk.dim("No saved session roots found.")}\n`);
		return;
	}
	printTable(
		["CWD", "SESSIONS", "PINNED", "LAST MODIFIED"],
		roots.map(root => [
			truncateToWidth(shortenPath(root.cwd) || root.cwd, TRUNCATE_LENGTHS.CONTENT),
			String(root.sessionCount),
			String(root.pinnedCount),
			`${root.latestModifiedAt.slice(0, 10)} ${root.latestModifiedAt.slice(11, 16)}Z`,
		]),
	);
}
