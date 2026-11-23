/**
 * `omp agents` without an action: the Agent View over every live omp session.
 *
 * On a TTY the alt-screen view (`pi-tui/apps/agents-view`) runs in a loop with
 * the attach client: the view returns the session to attach, the terminal is
 * handed to {@link attachHosted} until the user detaches (←) or the session
 * ends, and the view comes back with its selection. Slash commands that need
 * the terminal (`/resume`, which opens the resume session picker) run between
 * view runs the same way. `--json` prints the rows; other non-TTY output gets
 * a plain table. Listing never starts the daemon.
 */
import * as path from "node:path";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { directoryExists } from "@oh-my-pi/pi-utils";
import {
	type AgentsViewHost,
	type AgentsViewState,
	createAgentsViewState,
	runAgentsViewApp,
} from "@oh-my-pi/pi-tui/apps/agents-view";
import {
	agentDisplayText,
	agentRowKey,
	agentStatusLabel,
	formatAgentCwd,
	formatRelativeTime,
	orderAgentRows,
	resumeAction,
} from "@oh-my-pi/pi-tui/apps/agents-view-data";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { attachHosted } from "../agents-view/attach";
import { launchHosted, stopHosted } from "../agents-view/host";
import { type AgentSessionRow, listAgentSessions } from "../agents-view/status";
import { closeDaemonClient } from "../daemon/client";
import { findSessionContinuation, type PickerListing, readSessionInfo } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { createSessionPicker } from "../session/session-picker";

export interface AgentsOverviewFlags {
	json?: boolean;
	/** Only sessions whose working directory is this one. */
	cwd?: string;
	/** Row (daemon unit key) selected when the view opens. */
	select?: string;
}

const TABLE_HEADER = ["STATUS", "TITLE", "CWD", "ACTIVE", "DETAIL"] as const;
/** Longest daemon label a dispatched prompt contributes. */
const DISPATCH_TITLE_MAX = 48;

/** Run `omp agents` with no action: the view on a TTY, JSON or a table otherwise. */
export async function runAgentsOverview(flags: AgentsOverviewFlags): Promise<void> {
	const cwd = flags.cwd ? path.resolve(flags.cwd) : undefined;
	try {
		if (flags.json) {
			// The attach token is a secret for attach clients, not output.
			const rows = (await listAgentSessions({ cwd })).map(({ attachToken: _, ...row }) => row);
			console.log(JSON.stringify(rows, null, 2));
			return;
		}
		if (process.stdout.isTTY === true && process.stdin.isTTY === true) {
			process.exitCode = await runAgentsView({ select: flags.select, cwd });
			return;
		}
		printTable(await listAgentSessions({ cwd }));
	} finally {
		await closeDaemonClient();
	}
}

/**
 * Run the interactive Agent View until the user quits; returns the exit code.
 * `returnTo` is the hosted session the caller just left (a foreground session
 * handed to the daemon): `esc` reattaches it.
 */
export async function runAgentsView(opts: { select?: string; returnTo?: string; cwd?: string }): Promise<number> {
	const state = createAgentsViewState({ select: opts.select, returnTo: opts.returnTo });
	const host: AgentsViewHost = {
		list: () => listAgentSessions({ cwd: opts.cwd }),
		dispatch: (prompt, size) =>
			launchHosted({
				cwd: process.cwd(),
				// `--` keeps a prompt that looks like a flag or a subcommand a prompt.
				argv: ["--", prompt],
				cols: size.cols,
				rows: size.rows,
				title: sanitizeDisplayLine(prompt).slice(0, DISPATCH_TITLE_MAX),
			}),
		async stop(row) {
			if (!row.hostKey) throw new Error("not a background session");
			// Other processes on the same session were collapsed into this row; stop them too.
			for (const key of [row.hostKey, ...(row.duplicateHostKeys ?? [])]) await stopHosted(key);
		},
	};
	for (;;) {
		const outcome = await runAgentsViewApp(state, host);
		switch (outcome.kind) {
			case "quit":
				return 0;
			case "attach":
				await attachAndReport(state, outcome.hostKey);
				break;
			case "command":
				switch (outcome.name) {
					case "resume":
						await resumeFromPicker(state, outcome.arg);
						break;
				}
				break;
		}
	}
}

/**
 * `/resume [query]`: pick a saved session with the `omp --resume` picker and
 * open it in the background. A session some process already runs is attached
 * (hosted) or refused (another terminal); a second process would fork its file.
 */
async function resumeFromPicker(state: AgentsViewState, query: string): Promise<void> {
	try {
		const cwd = process.cwd();
		const folder = await SessionManager.listForPicker(cwd);
		let allSessions: PickerListing | undefined;
		if (folder.sessions.length === 0) {
			allSessions = await SessionManager.listAllForPicker();
			if (allSessions.sessions.length === 0) {
				state.notice = { tone: "muted", text: "No saved sessions." };
				return;
			}
		}
		const selectSession = createSessionPicker();
		const picked = await selectSession(folder.sessions, {
			completeSessions: folder.complete,
			allSessions,
			initialQuery: query || undefined,
		});
		if (!picked) return;
		// A preliminary row lacks the recorded cwd; a session that went on in a newer file resumes that file.
		const selected = (await readSessionInfo(picked.path)) ?? picked;
		const chosen = (await findSessionContinuation(selected.path))?.session ?? selected;
		const live = await listAgentSessions();
		const action = resumeAction(live, { path: chosen.path, id: chosen.id });
		switch (action.kind) {
			case "attach":
				state.selectedKey = action.hostKey;
				await attachAndReport(state, action.hostKey);
				return;
			case "foreground":
				state.selectedKey = agentRowKey(action.row);
				state.notice = {
					tone: "warning",
					text: `${action.row.title} is running in another terminal; run /bg there to move it here.`,
				};
				return;
			case "launch": {
				const key = await launchHosted({
					cwd: chosen.cwd && (await directoryExists(chosen.cwd)) ? chosen.cwd : cwd,
					argv: ["--resume", chosen.path],
					cols: process.stdout.columns ?? 120,
					rows: process.stdout.rows ?? 40,
					title: sanitizeDisplayLine(chosen.title ?? path.basename(chosen.cwd || cwd)).slice(
						0,
						DISPATCH_TITLE_MAX,
					),
				});
				state.selectedKey = key;
				await attachAndReport(state, key);
				return;
			}
		}
	} catch (error) {
		state.notice = {
			tone: "error",
			text: `Could not resume: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Attach to a hosted session and record how it ended for the view's next run. */
async function attachAndReport(state: AgentsViewState, hostKey: string): Promise<void> {
	try {
		const result = await attachHosted(hostKey);
		if (result === "detached") {
			state.returnTo = hostKey;
			state.notice = undefined;
			return;
		}
		if (state.returnTo === hostKey) state.returnTo = undefined;
		state.notice =
			result === "exited"
				? { tone: "muted", text: "The session exited." }
				: {
						tone: "warning",
						text: "Lost the connection to the session; it keeps running. Press enter to reattach.",
					};
	} catch (error) {
		if (state.returnTo === hostKey) state.returnTo = undefined;
		state.notice = {
			tone: "error",
			text: `Could not attach: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function printTable(rows: readonly AgentSessionRow[]): void {
	if (rows.length === 0) {
		console.log(chalk.dim("No live omp sessions."));
		return;
	}
	const now = Date.now();
	const ordered = orderAgentRows(rows);
	const cells = ordered.map(row => [
		agentStatusLabel(row),
		agentDisplayText(row.title),
		formatAgentCwd(row.cwd),
		formatRelativeTime(row.lastActivityAt, now),
		agentDisplayText(row.detail),
	]);
	// Truncate to the terminal on a TTY; keep full lines when piped.
	const maxWidth = process.stdout.isTTY ? (process.stdout.columns ?? 120) : Number.POSITIVE_INFINITY;
	const widths = TABLE_HEADER.map((title, column) =>
		Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
	);
	const render = (row: readonly string[]): string => {
		const line = row
			.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell))))
			.join("  ")
			.trimEnd();
		return Number.isFinite(maxWidth) ? truncateToWidth(line, maxWidth) : line;
	};
	console.log(chalk.dim(render(TABLE_HEADER)));
	for (const [index, row] of cells.entries()) {
		const line = render(row);
		console.log(ordered[index].attachable ? line : chalk.dim(line));
	}
}
