/**
 * `omp agents` — the Agent View: an alt-screen list of every live omp session
 * on the machine, grouped by what it needs (input, error, working, idle), and a
 * prompt line that dispatches new background sessions.
 *
 * Keys: `↑/↓` select, `enter`/`→` attach (empty prompt), typing + `enter`
 * starts a background session, `ctrl+x` stop (asks first), `esc` back to the
 * session just left (or quit), `q` (empty prompt) / `ctrl+c` quit.
 *
 * The app never attaches itself: attaching needs the raw terminal, so
 * {@link runAgentsViewApp} stops the TUI completely (alt screen left, stdin
 * released) and returns an `attach` outcome; the caller attaches and runs the
 * app again with the same {@link AgentsViewState}, which keeps the selection,
 * the typed prompt, and the status memory for bell transitions.
 */
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { Input } from "../components/input";
import { ScrollView } from "../components/scroll-view";
import { matchesKey } from "../keys";
import { ProcessTerminal } from "../terminal";
import { type ThemeColor, theme } from "../theme/theme";
import { type Component, TUI } from "../tui";
import { padding, truncateToWidth, visibleWidth } from "../utils";
import {
	type AgentsViewCommandName,
	type AgentsViewGroupId,
	type AgentsViewRow,
	type AgentsViewStatus,
	AGENTS_VIEW_COMMANDS,
	agentDisplayText,
	agentRowKey,
	agentsViewTitle,
	attentionTransitions,
	countAwaitingInput,
	formatAgentCwd,
	formatRelativeTime,
	groupAgentRows,
	matchingAgentsViewCommands,
	orderAgentRows,
	parseAgentsViewInput,
	snapshotAgentStatuses,
} from "./agents-view-data";

/** Status poll interval. */
const POLL_MS = 1_000;
/** Spinner frame interval while any session works. */
const SPIN_MS = 80;
const NOTICE_TTL_MS = 6_000;
const PROMPT_PLACEHOLDER = "Describe a task to start a background session";

export type AgentsViewTone = "success" | "warning" | "error" | "muted";

/** Session capabilities supplied by the coding agent. */
export interface AgentsViewHost {
	/** Live sessions; never starts the daemon. */
	list(): Promise<AgentsViewRow[]>;
	/** Start a hosted session running `prompt`; resolves to its daemon unit key. */
	dispatch(prompt: string, size: { cols: number; rows: number }): Promise<string>;
	/** Stop a hosted session, with every duplicate unit on the same session. */
	stop(row: AgentsViewRow): Promise<void>;
}

/** State carried across app runs (the app is recreated after every attach). */
export interface AgentsViewState {
	/** Row key ({@link agentRowKey}) of the selection; kept while the row is not listed yet. */
	selectedKey?: string;
	/** Unit key `esc` reattaches: the session the user just left. */
	returnTo?: string;
	/** Text typed into the prompt line. */
	draft: string;
	/** Rows of the last poll, painted at once when the app is recreated. */
	rows: AgentsViewRow[];
	/** Statuses of the last poll; undefined until the first poll (no bell for pre-existing waits). */
	statuses?: Map<string, AgentsViewStatus>;
	/** Message shown at the bottom, e.g. why the last attach ended. */
	notice?: { tone: AgentsViewTone; text: string };
}

/**
 * Why the app returned: quit, attach a session, or run a slash command that
 * needs the terminal (the app is stopped, as for an attach).
 */
export type AgentsViewOutcome =
	| { kind: "quit" }
	| { kind: "attach"; hostKey: string }
	| { kind: "command"; name: AgentsViewCommandName; arg: string };

export function createAgentsViewState(options: { select?: string; returnTo?: string } = {}): AgentsViewState {
	return { selectedKey: options.select ?? options.returnTo, returnTo: options.returnTo, draft: "", rows: [] };
}

const GROUP_COLOR: Record<AgentsViewGroupId, ThemeColor> = {
	waiting: "warning",
	error: "error",
	working: "accent",
	idle: "muted",
};

const NOTICE_COLOR: Record<AgentsViewTone, ThemeColor> = {
	success: "success",
	warning: "warning",
	error: "error",
	muted: "dim",
};

/** The Agent View list, prompt line and footer. */
export class AgentsViewComponent implements Component {
	readonly #ui: TUI;
	readonly #host: AgentsViewHost;
	readonly #state: AgentsViewState;
	readonly #done = Promise.withResolvers<AgentsViewOutcome>();
	readonly #input = new Input();
	readonly #list = new ScrollView([], { height: 1 });
	/** Rows in display order. */
	#ordered: AgentsViewRow[] = [];
	#selected = 0;
	#loaded = false;
	#refreshing = false;
	#dispatching = false;
	/** Row key a pending `ctrl+x` waits on for confirmation. */
	#confirmStop: string | undefined;
	#noticeAt = 0;
	#title: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#spinTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(ui: TUI, state: AgentsViewState, host: AgentsViewHost) {
		this.#ui = ui;
		this.#host = host;
		this.#state = state;
		this.#input.prompt = "› ";
		this.#input.focused = true;
		this.#input.setValue(state.draft, { cursor: "end" });
		if (state.notice) this.#noticeAt = Date.now();
		this.#applyRows(state.rows);
	}

	run(): Promise<AgentsViewOutcome> {
		void this.#refresh();
		this.#pollTimer = setInterval(() => void this.#refresh(), POLL_MS);
		this.#spinTimer = setInterval(() => {
			if (this.#ordered.some(row => row.status === "running" || row.status === "compacting")) {
				this.#ui.requestRender();
			}
		}, SPIN_MS);
		return this.#done.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#pollTimer);
		clearInterval(this.#spinTimer);
		this.#state.draft = this.#input.getValue();
		this.#list.dispose();
	}

	// -- data ----------------------------------------------------------------

	async #refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const rows = await this.#host.list();
			if (this.#disposed) return;
			this.#loaded = true;
			const entered = attentionTransitions(this.#state.statuses, rows);
			this.#state.statuses = snapshotAgentStatuses(rows);
			this.#state.rows = rows;
			this.#applyRows(rows);
			if (entered.length > 0) this.#ui.terminal.write("\x07");
			this.#ui.requestRender();
		} catch (error) {
			this.#notify("error", error instanceof Error ? error.message : String(error));
		} finally {
			this.#refreshing = false;
		}
	}

	#applyRows(rows: readonly AgentsViewRow[]): void {
		this.#ordered = orderAgentRows(rows);
		const key = this.#state.selectedKey;
		const index = key === undefined ? -1 : this.#ordered.findIndex(row => agentRowKey(row) === key);
		// A selection not listed (yet) keeps its key: a just-dispatched or
		// just-backgrounded session shows up a poll later.
		this.#selected = index >= 0 ? index : Math.max(0, Math.min(this.#selected, this.#ordered.length - 1));
		if (key === undefined && this.#ordered[this.#selected]) {
			this.#state.selectedKey = agentRowKey(this.#ordered[this.#selected]);
		}
		if (this.#confirmStop !== undefined && !this.#ordered.some(row => agentRowKey(row) === this.#confirmStop)) {
			this.#confirmStop = undefined;
		}
		const title = agentsViewTitle(rows);
		if (title !== this.#title) {
			this.#title = title;
			this.#ui.terminal.setTitle(title);
		}
	}

	#notify(tone: AgentsViewTone, text: string): void {
		this.#state.notice = { tone, text };
		this.#noticeAt = Date.now();
		this.#ui.requestRender();
	}

	// -- actions -------------------------------------------------------------

	#attach(row: AgentsViewRow | undefined): void {
		if (!row) return;
		if (!row.attachable || !row.hostKey) {
			this.#notify("warning", "This session runs in a terminal of its own; press ← there to move it here.");
			return;
		}
		this.#state.selectedKey = agentRowKey(row);
		this.#state.notice = undefined;
		this.#done.resolve({ kind: "attach", hostKey: row.hostKey });
	}

	#escape(): void {
		const returnTo = this.#state.returnTo;
		if (returnTo !== undefined) {
			const row = this.#ordered.find(entry => entry.hostKey === returnTo);
			if (row?.attachable) {
				this.#attach(row);
				return;
			}
			// Right after a handoff the session may not be listed yet: go back to it anyway.
			if (!row && !this.#loaded) {
				this.#state.selectedKey = returnTo;
				this.#done.resolve({ kind: "attach", hostKey: returnTo });
				return;
			}
		}
		this.#done.resolve({ kind: "quit" });
	}

	async #dispatch(prompt: string): Promise<void> {
		if (this.#dispatching) return;
		this.#dispatching = true;
		// Consume the submitted line now: text typed while the launch runs is a new draft.
		const submitted = this.#input.getValue();
		this.#input.setValue("");
		this.#state.draft = "";
		this.#notify("muted", "Starting session…");
		try {
			const key = await this.#host.dispatch(prompt, {
				cols: this.#ui.terminal.columns,
				rows: this.#ui.terminal.rows,
			});
			if (this.#disposed) return;
			this.#state.selectedKey = key;
			this.#notify("success", `Started ${prompt.slice(0, 60)}`);
			void this.#refresh();
		} catch (error) {
			// Give the prompt back for a retry unless the user already typed something else.
			if (this.#disposed) {
				if (this.#state.draft === "") this.#state.draft = submitted;
			} else if (this.#input.getValue() === "") {
				this.#input.setValue(submitted, { cursor: "end" });
			}
			this.#notify("error", `Could not start a session: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#dispatching = false;
		}
	}

	#requestStop(): void {
		const row = this.#ordered[this.#selected];
		if (!row) return;
		if (!row.attachable || !row.hostKey) {
			this.#notify("warning", "Foreground sessions are stopped from their own terminal.");
			return;
		}
		this.#confirmStop = agentRowKey(row);
		this.#ui.requestRender();
	}

	async #stop(row: AgentsViewRow): Promise<void> {
		this.#notify("warning", `Stopping ${row.title}…`);
		try {
			await this.#host.stop(row);
			if (this.#state.returnTo === row.hostKey) this.#state.returnTo = undefined;
			this.#notify("success", `Stopped ${row.title}`);
			void this.#refresh();
		} catch (error) {
			this.#notify("error", `Stop failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#moveSelection(delta: number): void {
		if (this.#ordered.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#ordered.length - 1, this.#selected + delta));
		this.#state.selectedKey = agentRowKey(this.#ordered[this.#selected]);
		this.#confirmStop = undefined;
		this.#ui.requestRender();
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve({ kind: "quit" });
			return;
		}
		if (this.#confirmStop !== undefined) {
			const key = this.#confirmStop;
			this.#confirmStop = undefined;
			const row = this.#ordered.find(entry => agentRowKey(entry) === key);
			if (row && (data === "y" || data === "Y" || matchesKey(data, "enter"))) void this.#stop(row);
			else this.#ui.requestRender();
			return;
		}
		const draft = this.#input.getValue();
		if (matchesKey(data, "up")) this.#moveSelection(-1);
		else if (matchesKey(data, "down")) this.#moveSelection(1);
		else if (matchesKey(data, "ctrl+x")) this.#requestStop();
		else if (matchesKey(data, "escape")) {
			if (draft.length > 0) {
				this.#input.setValue("");
				this.#ui.requestRender();
			} else this.#escape();
		} else if (matchesKey(data, "enter")) this.#submit(draft);
		else if (draft.length === 0 && matchesKey(data, "right")) this.#attach(this.#ordered[this.#selected]);
		else if (draft.length === 0 && data === "q") this.#done.resolve({ kind: "quit" });
		else {
			this.#input.handleInput(data);
			this.#ui.requestRender();
		}
	}

	/** Enter: attach on an empty line, run a `/command`, else start a session with the prompt. */
	#submit(draft: string): void {
		const input = parseAgentsViewInput(draft);
		switch (input.kind) {
			case "empty":
				this.#attach(this.#ordered[this.#selected]);
				return;
			case "prompt":
				void this.#dispatch(input.prompt);
				return;
			case "unknown": {
				const known = AGENTS_VIEW_COMMANDS.map(entry => `/${entry.name}`).join(", ");
				this.#notify(
					"warning",
					input.name ? `Unknown command /${input.name}; commands: ${known}` : `Type a command after /: ${known}`,
				);
				return;
			}
			case "command":
				this.#input.setValue("");
				this.#state.draft = "";
				this.#state.notice = undefined;
				this.#done.resolve({ kind: "command", name: input.name, arg: input.arg });
				return;
		}
	}

	// -- render ----------------------------------------------------------------

	render(width: number): readonly string[] {
		const height = Math.max(8, this.#ui.terminal.rows);
		const now = Date.now();
		const header = this.#renderHeader(width);
		const bottom = [this.#renderStatusLine(width, now), this.#renderPrompt(width), this.#renderHints(width)];
		const bodyHeight = height - 2 - bottom.length;

		const body: string[] = [""];
		let activeLine: number | undefined;
		const groups = groupAgentRows(this.#ordered);
		if (groups.length === 0) {
			body.push(
				theme.fg(
					"dim",
					this.#loaded
						? "  No live sessions. Type a task below to start one in the background."
						: "  Loading sessions…",
				),
			);
		}
		const selectedRow = this.#ordered[this.#selected];
		for (const group of groups) {
			body.push(
				` ${theme.bold(theme.fg(GROUP_COLOR[group.id], group.label))} ${theme.fg("dim", `${group.rows.length}`)}`,
			);
			for (const row of group.rows) {
				const selected = row === selectedRow;
				if (selected) activeLine = body.length;
				body.push(this.#renderRow(row, width, now, selected));
			}
			body.push("");
		}
		this.#list.setLines(body);
		this.#list.setHeight(Math.max(1, bodyHeight));
		this.#list.setActiveRow(activeLine);

		const lines = [header, ...this.#list.render(width)];
		while (lines.length < height - bottom.length - 1) lines.push("");
		lines.push("", ...bottom);
		return lines;
	}

	#renderHeader(width: number): string {
		const total = this.#ordered.length;
		const waiting = countAwaitingInput(this.#ordered);
		const left = ` ${theme.bold("omp agents")} ${theme.fg("dim", "·")} ${total} session${total === 1 ? "" : "s"}`;
		const right = waiting > 0 ? theme.fg("warning", `${waiting} awaiting input `) : "";
		const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${padding(pad)}${right}`, width);
	}

	#renderRow(row: AgentsViewRow, width: number, now: number, selected: boolean): string {
		const foreground = !row.attachable;
		const timeCell = `${foreground ? "fg · " : ""}${formatRelativeTime(row.lastActivityAt, now)}`;
		const timeWidth = Math.max(visibleWidth(timeCell), 8);
		const fixed = 3 + 2 + 2 + timeWidth; // gutter, glyph, gap, time
		const room = Math.max(0, width - fixed);
		let titleWidth = Math.max(10, Math.min(40, Math.floor(room * 0.35)));
		const cwdWidth = Math.max(8, Math.min(36, Math.floor(room * 0.3)));
		let detailWidth = room - titleWidth - cwdWidth - 4;
		if (detailWidth < 8) {
			titleWidth += Math.max(0, detailWidth + 2);
			detailWidth = 0;
		}
		const cell = (text: string, cellWidth: number): string => truncateToWidth(text, cellWidth, undefined, true);
		const title = cell(agentDisplayText(row.title) || "(untitled)", titleWidth);
		const cwd = cell(formatAgentCwd(row.cwd), cwdWidth);
		const detail = detailWidth > 0 ? `  ${cell(agentDisplayText(row.detail), detailWidth)}` : "";
		const time = `${padding(timeWidth - visibleWidth(timeCell))}${timeCell}`;
		const gutter = selected ? ` ${theme.fg("accent", "❯")} ` : "   ";
		const glyph = foreground ? theme.fg("dim", this.#glyphText(row.status)) : this.#glyph(row.status);
		const text = foreground
			? theme.fg("dim", `${title}  ${cwd}${detail}  ${time}`)
			: `${selected ? theme.bold(title) : title}  ${theme.fg("muted", cwd)}${theme.fg("dim", detail)}  ${theme.fg("dim", time)}`;
		const line = truncateToWidth(`${gutter}${glyph} ${text}`, width);
		return selected ? theme.bg("selectedBg", `${line}${padding(width - visibleWidth(line))}`) : line;
	}

	#glyphText(status: AgentsViewStatus): string {
		switch (status) {
			case "running": {
				const frames = theme.getSpinnerFrames("activity");
				return frames[Math.floor(Date.now() / SPIN_MS) % frames.length] ?? "*";
			}
			case "waiting":
				return theme.status.warning;
			case "error":
				return theme.status.error;
			case "compacting":
				return theme.status.running;
			case "starting":
				return theme.status.pending;
			case "idle":
				return theme.status.disabled;
		}
	}

	#glyph(status: AgentsViewStatus): string {
		const text = this.#glyphText(status);
		switch (status) {
			case "waiting":
				return theme.fg("warning", text);
			case "error":
				return theme.fg("error", text);
			case "running":
			case "compacting":
				return theme.fg("accent", text);
			default:
				return theme.fg("dim", text);
		}
	}

	#renderStatusLine(width: number, now: number): string {
		if (this.#confirmStop !== undefined) {
			const row = this.#ordered.find(entry => agentRowKey(entry) === this.#confirmStop);
			const name = row ? agentDisplayText(row.title) : "session";
			return truncateToWidth(
				` ${theme.fg("error", `Stop ${name}?`)} ${theme.fg("dim", "y/enter to stop, any other key cancels")}`,
				width,
			);
		}
		const notice = this.#state.notice;
		if (!notice || now - this.#noticeAt > NOTICE_TTL_MS) return "";
		// Notices carry titles, prompts and error messages from other processes.
		return truncateToWidth(` ${theme.fg(NOTICE_COLOR[notice.tone], agentDisplayText(notice.text))}`, width);
	}

	#renderPrompt(width: number): string {
		const [line = ""] = this.#input.render(Math.max(1, width - 1));
		if (this.#input.getValue().length > 0) return ` ${line}`;
		return truncateToWidth(` ${line.trimEnd()} ${theme.fg("dim", PROMPT_PLACEHOLDER)}`, width);
	}

	#renderHints(width: number): string {
		const draft = this.#input.getValue();
		const canGoBack =
			this.#state.returnTo !== undefined && this.#ordered.some(row => row.hostKey === this.#state.returnTo);
		const exitHints = canGoBack
			? `${formatKeyHint("escape")} back · ${formatKeyHint("q")} quit`
			: `${formatKeyHints(["escape", "q"])} quit`;
		let hints: string;
		if (draft.length === 0) {
			hints = `${formatKeyHints(["up", "down"])} select · ${formatKeyHint("enter")} attach · ${formatKeyHint("ctrl+x")} stop · ${exitHints} · type to start a session, / for commands`;
		} else if (draft.trimStart().startsWith("/")) {
			const commands = matchingAgentsViewCommands(draft)
				.map(entry => `/${entry.name} ${entry.args}  ${entry.description}`)
				.join(" · ");
			hints = `${commands} · ${formatKeyHint("enter")} run · ${formatKeyHint("escape")} clear`;
		} else {
			hints = `${formatKeyHint("enter")} start in ${formatAgentCwd(process.cwd())} · ${formatKeyHint("escape")} clear`;
		}
		return truncateToWidth(theme.fg("dim", ` ${hints}`), width);
	}
}

/**
 * Run the Agent View until the user quits or picks a session to attach. The
 * TUI is fully stopped (alt screen left, raw mode and stdin released) when this
 * resolves, so the caller can hand the terminal to the attach client.
 */
export async function runAgentsViewApp(state: AgentsViewState, host: AgentsViewHost): Promise<AgentsViewOutcome> {
	const ui = new TUI(new ProcessTerminal());
	const component = new AgentsViewComponent(ui, state, host);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		return await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
