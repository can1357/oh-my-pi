import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { SessionInfo, SessionStatus } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { loadPinnedSessionIds } from "../session/session-pins";
import { shortenPath, TRUNCATE_LENGTHS } from "../tools/render-utils";

export interface SessionsCommandArgs {
	flags: {
		all: boolean;
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

function tableCells(entry: SessionListEntry, includeCwd: boolean): string[] {
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

function printTable(entries: SessionListEntry[], includeCwd: boolean): void {
	const header = ["ID", "PIN", "STATUS", "MODIFIED", "MSGS", ...(includeCwd ? ["CWD"] : []), "TITLE / PREVIEW"];
	const rows = entries.map(entry => tableCells(entry, includeCwd));
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
	const sessions = cmd.flags.all ? await SessionManager.listAll() : await SessionManager.list(process.cwd());
	const pinnedIds = await loadPinnedSessionIds();
	const entries = sessions.map(session => toSessionListEntry(session, pinnedIds));

	if (cmd.flags.json) {
		process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
		return;
	}
	if (entries.length === 0) {
		if (cmd.flags.all) process.stdout.write(`${chalk.dim("No saved sessions found.")}\n`);
		else
			process.stdout.write(
				`${chalk.dim("No saved sessions in the current directory.\nUse --all to list sessions from every project.")}\n`,
			);
		return;
	}
	printTable(entries, cmd.flags.all);
}
