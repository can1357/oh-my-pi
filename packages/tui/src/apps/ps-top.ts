/**
 * Interactive alt-screen monitor for `omp ps` (btop idiom): a live process
 * table over the daemon's units, grouped by scope, with in-place actions.
 *
 * Keys — table: `↑/↓`/`j/k` select, `enter`/`i` info, `l` logs, `s` stop,
 * `x` kill, `r` restart, `a` toggle all scopes, `q`/`esc`/`ctrl+c` quit.
 * Sub-views (info, logs): `esc`/`q` back.
 */
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { KeyValueList, type KeyValueRow } from "../components/key-value-list";
import { ScrollView } from "../components/scroll-view";
import { renderTableRow, type TableColumn } from "../components/table";
import { matchesKey } from "../keys";
import { ProcessTerminal } from "../terminal";
import { type Component, TUI } from "../tui";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { col, compact, elapsed, keyed, node, row, span, stableKey, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, iconButton, segmentedTabs } from "../native/overlay";
import { Memo } from "../native/memo";
import { truncateToWidth } from "../utils";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ProcSpec, UnitScope, UnitSnapshot } from "../tools/daemon";
import {
	collapseCommand,
	daemonHeader,
	flagsCell,
	formatCommand,
	idleCell,
	type PsBoard,
	type PsScopeReport,
	type PsTarget,
	pidsCell,
	scopeHeader,
	scopeId,
	scopeTitle,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCells,
	unitLabel,
	unitName,
} from "./ps-data";

/** Fallback poll; unit events from the daemon refresh sooner. */
const REFRESH_MS = 2_000;
/** Coalesces bursts of unit events into one refresh. */
const EVENT_REFRESH_MS = 100;
const LOGS_POLL_MS = 1_000;
const STATUS_TTL_MS = 5_000;

interface FlatRow {
	scope: UnitScope;
	unit: UnitSnapshot;
}

type PsTopView = "table" | "info" | "logs";

type PsStatusTone = "success" | "warning" | "error" | "muted";

const STATUS_PAINT: Record<PsStatusTone, (text: string) => string> = {
	success: chalk.green,
	warning: chalk.yellow,
	error: chalk.red,
	muted: chalk.dim,
};

/** Options accepted by the interactive monitor: scope selection from the list flags. */
export interface PsTopOptions extends PsTarget {
	all: boolean;
}

/** Unit detail shown by the info view. */
export interface PsUnitInfo {
	unit: UnitSnapshot;
	proc?: ProcSpec;
}

/** Unit log window shown by the logs view. */
export interface PsUnitLogs {
	text: string;
	/** PTY output replayed into terminal rows; empty for non-PTY units. */
	terminalOutput: string;
	state: string;
}

/** Daemon capabilities supplied by the process command. */
export interface PsTopHost {
	/** The board for the selection; never starts the daemon. */
	collectBoard(all: boolean, target: PsTarget): Promise<PsBoard>;
	/** Calls `onChange` on every unit transition while a daemon answers; returns the unsubscribe. */
	watch(onChange: () => void): () => void;
	act(unit: UnitSnapshot, verb: "stop" | "kill" | "restart"): Promise<UnitSnapshot>;
	describe(unit: UnitSnapshot): Promise<PsUnitInfo>;
	logs(unit: UnitSnapshot, lines: number): Promise<PsUnitLogs>;
	close(): void;
}

/** Interactive process table and detail views. */
export class PsTopComponent implements Component {
	readonly #ui: TUI;
	readonly #target: PsTarget;
	readonly #done = Promise.withResolvers<void>();
	readonly #host: PsTopHost;
	#all: boolean;
	#board: PsBoard | undefined;
	#reports: PsScopeReport[] = [];
	#flat: FlatRow[] = [];
	#selected = 0;
	/** Unit id of the selection, kept stable across refreshes. */
	#selectedKey: string | undefined;
	readonly #tableView = new ScrollView([], { height: 1 });
	readonly #infoView = new ScrollView([], { height: 1 });
	readonly #logsView = new ScrollView([], { height: 1, followTail: true, anchor: "end" });
	readonly #infoList = new KeyValueList([], { indent: "   ", labelWidth: 9, gap: " " });
	#view: PsTopView = "table";
	#info: PsUnitInfo | undefined;
	#logsLines: string[] = [];
	#logsState = "";
	#logsTimer: NodeJS.Timeout | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	#eventTimer: NodeJS.Timeout | undefined;
	#unwatch: (() => void) | undefined;
	#refreshing = false;
	#lastRefresh = 0;
	#status = "";
	#statusText = "";
	#statusTone: PsStatusTone = "muted";
	#statusAt = 0;
	#logsError: string | undefined;
	/** Process key a pointer `Kill` waits on for confirmation. */
	#killConfirm: string | undefined;
	#disposed = false;
	readonly #native = new Memo();

	constructor(ui: TUI, options: PsTopOptions, host: PsTopHost) {
		this.#ui = ui;
		this.#host = host;
		this.#all = options.all;
		this.#target = { dir: options.dir };
	}

	run(): Promise<void> {
		void this.#refresh();
		this.#refreshTimer = setInterval(() => void this.#refresh(), REFRESH_MS);
		this.#unwatch = this.#host.watch(() => {
			if (this.#eventTimer) return;
			this.#eventTimer = setTimeout(() => {
				this.#eventTimer = undefined;
				void this.#refresh();
			}, EVENT_REFRESH_MS);
		});
		return this.#done.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
		clearTimeout(this.#eventTimer);
		this.#unwatch?.();
		this.#stopLogsPoll();
		this.#tableView.dispose();
		this.#infoView.dispose();
		this.#logsView.dispose();
		this.#host.close();
	}

	// -- data ----------------------------------------------------------------

	async #refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const board = await this.#host.collectBoard(this.#all, this.#target);
			if (this.#disposed) return;
			this.#board = board;
			this.#reports = board.reports;
			this.#flat = board.reports.flatMap(report => report.units.map(unit => ({ scope: report.scope, unit })));
			this.#lastRefresh = Date.now();
			this.#restoreSelection();
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		} finally {
			this.#refreshing = false;
		}
	}

	#restoreSelection(): void {
		if (this.#selectedKey !== undefined) {
			const index = this.#flat.findIndex(entry => flatKey(entry) === this.#selectedKey);
			if (index >= 0) {
				this.#selected = index;
				return;
			}
		}
		this.#selected = Math.max(0, Math.min(this.#selected, this.#flat.length - 1));
		this.#selectedKey = this.#flat[this.#selected] ? flatKey(this.#flat[this.#selected]) : undefined;
	}

	#setStatus(tone: PsStatusTone, text: string): void {
		this.#status = STATUS_PAINT[tone](text);
		this.#statusText = text;
		this.#statusTone = tone;
		this.#statusAt = Date.now();
		this.#ui.requestRender();
	}

	// -- actions ---------------------------------------------------------------

	async #act(verb: "stop" | "kill" | "restart"): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		const name = unitName(entry.unit);
		this.#setStatus("warning", `${verb} ${name}…`);
		try {
			const unit = await this.#host.act(entry.unit, verb);
			this.#setStatus(
				"success",
				`${verb === "restart" ? "Restarted" : verb === "kill" ? "Killed" : "Stopped"} ${unitLabel(unit)}`,
			);
			void this.#refresh();
		} catch (error) {
			this.#setStatus("error", `${verb} ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #openInfo(): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		try {
			this.#info = await this.#host.describe(entry.unit);
			this.#view = "info";
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		}
	}

	#openLogs(): void {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		this.#view = "logs";
		this.#logsLines = [];
		this.#logsState = "";
		this.#logsError = undefined;
		const poll = async (): Promise<void> => {
			const current = this.#flat[this.#selected];
			if (this.#disposed || this.#view !== "logs" || !current) return;
			try {
				const result = await this.#host.logs(current.unit, Math.max(10, this.#ui.terminal.rows - 4));
				this.#logsLines = (result.terminalOutput || result.text).replace(/\n$/, "").split("\n");
				this.#logsState = result.state;
				this.#logsError = undefined;
				this.#ui.requestRender();
			} catch (error) {
				this.#logsError = error instanceof Error ? error.message : String(error);
				this.#logsLines = [chalk.red(this.#logsError)];
				this.#ui.requestRender();
			}
		};
		void poll();
		this.#logsTimer = setInterval(() => void poll(), LOGS_POLL_MS);
	}

	#stopLogsPoll(): void {
		clearInterval(this.#logsTimer);
		this.#logsTimer = undefined;
	}

	#closeView(): void {
		this.#stopLogsPoll();
		this.#view = "table";
		this.#info = undefined;
		this.#ui.requestRender();
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve();
			return;
		}
		if (this.#view !== "table") {
			if (matchesKey(data, "escape") || data === "q") this.#closeView();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.#done.resolve();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.#moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.#moveSelection(1);
		else if (data === "a") this.#toggleAll();
		else if (matchesKey(data, "enter") || data === "i") void this.#openInfo();
		else if (data === "l") this.#openLogs();
		else if (data === "s") void this.#act("stop");
		else if (data === "x") void this.#act("kill");
		else if (data === "r") void this.#act("restart");
	}

	#toggleAll(): void {
		this.#all = !this.#all;
		this.#setStatus("muted", this.#all ? "Showing all scopes" : "Showing current scope");
		void this.#refresh();
	}

	#moveSelection(delta: number): void {
		if (this.#flat.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#flat.length - 1, this.#selected + delta));
		this.#selectedKey = flatKey(this.#flat[this.#selected]);
		this.#ui.requestRender();
	}

	// -- native --------------------------------------------------------------

	/**
	 * Pointer actions: a click selects a process, a double click opens its info
	 * (Enter); the scope control switches between the current and all scopes;
	 * the action bar runs the same code as the keys, except that a pointer
	 * `Kill` asks first (the `x` key stays immediate).
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			this.#nativeAction(event.act);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.item === "current" || event.item === "all") {
			if ((event.item === "all") !== this.#all) this.#toggleAll();
			return;
		}
		if (this.#view !== "table") return;
		const index = this.#flat.findIndex(entry => stableKey(flatKey(entry)) === event.item);
		if (index < 0) return;
		this.#selected = index;
		this.#selectedKey = flatKey(this.#flat[index]);
		this.#killConfirm = undefined;
		if (event.type === "activate") void this.#openInfo();
		else this.#ui.requestRender();
	}

	#nativeAction(act: string): void {
		switch (act) {
			case "info":
				void this.#openInfo();
				return;
			case "logs":
				this.#openLogs();
				return;
			case "stop":
			case "restart":
				void this.#act(act);
				return;
			case "kill":
				this.#killConfirm = this.#selectedKey;
				this.#ui.requestRender();
				return;
			case "kill-confirm":
				this.#killConfirm = undefined;
				void this.#act("kill");
				return;
			case "kill-cancel":
				this.#killConfirm = undefined;
				this.#ui.requestRender();
				return;
			case "back":
				this.#closeView();
				return;
			case "quit":
				this.#done.resolve();
				return;
		}
	}

	/**
	 * The process monitor as a native page: a head (title, counts, the scope
	 * control, freshness, close), one section per unit scope with a
	 * selectable process list, the transient status, and an action bar that
	 * mirrors the keys. Info and logs replace the list.
	 */
	describe(): NativeNode {
		const statusVisible = Date.now() - this.#statusAt < STATUS_TTL_MS;
		return this.#native.get(
			[
				this.#view,
				this.#board,
				this.#selected,
				this.#all,
				this.#lastRefresh,
				this.#info,
				this.#logsLines,
				this.#logsState,
				this.#logsError,
				statusVisible,
				this.#statusText,
				this.#statusTone,
				this.#killConfirm,
			],
			() => {
				const body =
					this.#view === "info"
						? this.#describeInfo()
						: this.#view === "logs"
							? this.#describeLogs()
							: this.#describeTable();
				return col(
					compact([
						this.#describeHead(),
						body,
						statusVisible &&
							this.#statusText !== "" &&
							keyed(
								text([span(this.#statusText, this.#statusTone)], { wrap: "word", role: "omp.app.status" }),
								"status",
							),
						this.#describeActions(),
					]),
					{ role: "omp.app.ps", gap: "md" },
				);
			},
		);
	}

	#describeHead(): NativeNode {
		const entry = this.#flat[this.#selected];
		const left: NativeNode[] = [];
		if (this.#view === "table") {
			const running = this.#flat.filter(flat => !TERMINAL_STATES[flat.unit.state]).length;
			const stopped = this.#flat.length - running;
			left.push(
				text("Processes", { role: "omp.app.title" }),
				text(
					[
						span(`${running} running`, running > 0 ? "success" : "muted"),
						...(stopped > 0 ? [span(` · ${stopped} stopped`, "muted")] : []),
						span(` · ${this.#reports.length} scope${this.#reports.length === 1 ? "" : "s"}`, "muted"),
						this.#board?.daemon
							? span(` · daemon pid ${this.#board.daemon.pid}`, "muted")
							: span(" · daemon not running", "dim"),
					],
					{ truncate: "end" },
				),
			);
		} else {
			left.push(
				iconButton("back", "back", "Back  esc", { aria: "Back" }),
				text(
					this.#view === "logs"
						? `Logs · ${entry ? unitName(entry.unit) : "?"}`
						: entry
							? unitName(entry.unit)
							: "?",
					{
						role: "omp.app.title",
						truncate: "end",
					},
				),
			);
			const unit = this.#view === "info" ? this.#info?.unit : entry?.unit;
			if (unit) left.push(node("badge", { text: stateLabel(unit), tone: unitTone(unit) }));
			if (this.#view === "logs" && this.#logsState) left.push(text([span(this.#logsState, "muted")]));
		}
		const right: NativeNode[] = [];
		if (this.#view === "table") {
			right.push(
				segmentedTabs(
					{
						items: [
							{
								id: "current",
								label: this.#target.dir !== undefined ? "Target" : "This project",
							},
							{ id: "all", label: "All scopes" },
						],
						active: this.#all ? "all" : "current",
						role: "omp.app.seg",
					},
					"scope",
				),
			);
		}
		right.push(
			this.#lastRefresh
				? row(
						[text([span("updated", "dim")]), elapsed(Date.now() - this.#lastRefresh), text([span("ago", "dim")])],
						{
							gap: "xs",
							align: "center",
							role: "omp.app.fresh",
						},
					)
				: row([node("spinner", { style: "dots" }), text([span("updating", "dim")])], {
						gap: "xs",
						align: "center",
						role: "omp.app.fresh",
					}),
			iconButton("x", "quit", "Quit  q", { aria: "Quit" }),
		);
		return keyed(
			row(
				[
					row(left, { gap: "sm", align: "center", role: "omp.app.where" }),
					row(right, { gap: "md", align: "center", role: "omp.app.tools" }),
				],
				{ justify: "between", align: "center", role: "omp.app.head" },
			),
			"head",
		);
	}

	/** The action bar for the view, or the kill confirmation that replaces it. */
	#describeActions(): NativeNode {
		const entry = this.#flat[this.#selected];
		if (
			this.#view === "table" &&
			entry &&
			this.#killConfirm === this.#selectedKey &&
			this.#killConfirm !== undefined
		) {
			const pids = pidsCell(entry.unit);
			return keyed(
				row(
					[
						text(
							[
								span(`Kill ${unitName(entry.unit)}${pids === "-" ? "" : ` (pid ${pids})`}?`, "strong"),
								span("  It stops at once, without cleanup.", "muted"),
							],
							{ truncate: "end", grow: 1 },
						),
						actionButton("Cancel", "kill-cancel"),
						actionButton("Kill", "kill-confirm", { tone: "error" }),
					],
					{ gap: "sm", align: "center", role: "omp.app.confirm", tone: "error" },
				),
				"actions",
			);
		}
		if (this.#view !== "table") {
			return actionBar([
				actionButton("Back", "back", { keys: "escape", tone: "accent" }),
				...(this.#view === "info" ? [actionButton("Logs", "logs")] : []),
			]);
		}
		if (!entry) return actionBar([null, actionButton("Quit", "quit", { keys: "q" })]);
		return actionBar([
			actionButton("Info", "info", { keys: "enter", tone: "accent" }),
			actionButton("Logs", "logs", { keys: "l" }),
			actionButton("Restart", "restart", { keys: "r" }),
			actionButton("Stop", "stop", { keys: "s" }),
			actionButton("Kill", "kill", { keys: "x", tone: "error", title: "Kill the process (asks first)" }),
			null,
			actionButton("Quit", "quit", { keys: "q" }),
		]);
	}

	#describeTable(): NativeNode {
		if (this.#reports.length === 0) {
			return keyed(
				col(
					[
						text("No units", { role: "omp.app.empty-title" }),
						text([
							span(
								this.#board?.daemon ? "The omp daemon runs nothing here. " : "The omp daemon is not running. ",
								"muted",
							),
							span(this.#all ? "Nothing runs anywhere." : "Show every scope with ", "muted"),
							...(this.#all ? [] : [span("a", "key"), span(".", "muted")]),
						]),
					],
					{ gap: "xs", align: "center", role: "omp.app.empty" },
				),
				"empty",
			);
		}
		const selected = this.#flat[this.#selected];
		const sections = this.#reports.map(report =>
			node(
				"section",
				{ head: scopeSpans(report.scope), role: "omp.app.ps.scope" },
				[
					node(
						"list",
						{
							selected:
								selected && scopeId(selected.scope) === scopeId(report.scope)
									? stableKey(flatKey(selected))
									: null,
							empty: "No units",
							role: "omp.ps.processes",
						},
						report.units.map(unit => describeUnit(report.scope, unit)),
					),
				],
				stableKey(scopeId(report.scope)),
			),
		);
		return keyed(col(sections, { gap: "lg", grow: 1, role: "omp.app.ps.scopes" }), "scopes");
	}

	#describeInfo(): NativeNode {
		const info = this.#info;
		if (!info) {
			return keyed(
				row([node("spinner", { style: "dots" }), text([span("Loading…", "muted")])], { gap: "sm" }),
				"info",
			);
		}
		const { unit, proc } = info;
		const command = collapseCommand(formatCommand(proc) ?? unit.command);
		const cwd = proc?.cwd ?? unit.cwd;
		const items: { k: string; v: TspText }[] = [
			{ k: "Kind", v: unit.kind },
			{ k: "Key", v: [span(unit.key, "mono")] },
			{ k: "Id", v: [span(unit.id, "mono")] },
		];
		if (command) items.push({ k: "Command", v: [span(command, "mono")] });
		if (cwd) items.push({ k: "Directory", v: [span(cwd, "path")] });
		const pids = pidsCell(unit);
		if (pids !== "-") items.push({ k: "PID", v: [span(pids, "num")] });
		if (unit.exitReason) items.push({ k: "Exit", v: [span(unit.exitReason, "error")] });
		items.push({ k: "Restarts", v: `${unit.restartCount} (policy ${unit.policy.restart})` });
		items.push({ k: "Leases", v: String(unit.leases) });
		items.push({ k: "Idle", v: idleCell(unit) });
		items.push({ k: "Owner", v: unit.owner ?? "—" });
		const flags = [proc?.pty && "pty", `hold ${unit.policy.hold}`, `survive ${unit.policy.survive}`].filter(Boolean);
		items.push({ k: "Flags", v: flags.join(" · ") });
		const body: NativeNode[] = [];
		if (!TERMINAL_STATES[unit.state]) {
			body.push(
				row([text([span("Up for", "muted")]), elapsed(Date.now() - unit.startedAt)], {
					gap: "xs",
					role: "omp.app.fresh",
				}),
			);
		}
		body.push(node("kv", { items, layout: "grid" }));
		return keyed(col(body, { role: "omp.ps.info", gap: "md" }), "info");
	}

	#describeLogs(): NativeNode {
		if (this.#logsError) {
			return keyed(text([span(this.#logsError, "error mono")], { wrap: "word", role: "omp.ps.logs" }), "logs");
		}
		return node(
			"ansi",
			{ text: this.#logsLines.join("\n"), follow: true, role: "omp.ps.logs", grow: 1 },
			undefined,
			"logs",
		);
	}

	// -- render ------------------------------------------------------------

	render(width: number): readonly string[] {
		const height = Math.max(6, this.#ui.terminal.rows);
		switch (this.#view) {
			case "info":
				return this.#renderInfo(width, height);
			case "logs":
				return this.#renderLogs(width, height);
			default:
				return this.#renderTable(width, height);
		}
	}

	#header(width: number, title: string): string {
		const age = this.#lastRefresh ? `updated ${formatDuration(Date.now() - this.#lastRefresh)} ago` : "updating…";
		const left = ` ${chalk.bold("omp ps")} ${chalk.dim("·")} ${title}`;
		const right = chalk.dim(age);
		const pad = Math.max(1, width - Bun.stringWidth(left) - Bun.stringWidth(right) - 1);
		return truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width);
	}

	#footer(width: number, hints: string): string[] {
		const status = Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
		return [truncateToWidth(` ${status}`, width), truncateToWidth(chalk.dim(` ${hints}`), width)];
	}

	#renderTable(width: number, height: number): string[] {
		const scopeKind = this.#all
			? "(all)"
			: this.#target.dir !== undefined
				? "(target + global)"
				: "(current + global)";
		const scopesLabel = `${this.#flat.length} unit${this.#flat.length === 1 ? "" : "s"} in ${this.#reports.length} scope${this.#reports.length === 1 ? "" : "s"} ${chalk.dim(scopeKind)}`;
		const header = this.#header(width, scopesLabel);
		const footer = this.#footer(
			width,
			`${formatKeyHints(["up", "down"])} select · ${formatKeyHint("enter")} info · ${formatKeyHint("l")} logs · ${formatKeyHint("s")} stop · ${formatKeyHint("x")} kill · ${formatKeyHint("r")} restart · ${formatKeyHint("a")} all scopes · ${formatKeyHint("q")} quit`,
		);
		const bodyHeight = height - 1 - footer.length;

		const cells = this.#flat.map(entry => tableCells(entry.unit));
		const widths = TABLE_HEADER.map((title, column) =>
			Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
		);
		const columns: TableColumn[] = widths.map((columnWidth): TableColumn => ({
			width: columnWidth,
			align: "left",
			overflow: "truncate",
		}));
		const renderRow = (row: string[]): string =>
			renderTableRow(
				row.map(cell => ({ text: cell })),
				columns,
				undefined,
				{ indent: "   ", gap: "  ", fit: false },
			).trimEnd();

		// Body lines with the flat index carried for selection highlighting.
		const body: { text: string; flat?: number }[] = [{ text: ` ${daemonHeader(this.#board?.daemon)}` }, { text: "" }];
		let flatIndex = 0;
		for (const report of this.#reports) {
			body.push({ text: ` ${scopeHeader(report.scope)}` });
			if (report.units.length === 0) {
				body.push({ text: chalk.dim("   no units") });
			} else {
				body.push({ text: chalk.dim(renderRow([...TABLE_HEADER])) });
				for (const unit of report.units) {
					const line = renderRow(tableCells(unit));
					body.push({
						text: TERMINAL_STATES[unit.state] ? chalk.dim(line) : line,
						flat: flatIndex,
					});
					flatIndex++;
				}
			}
			body.push({ text: "" });
		}
		if (this.#reports.length === 0) body.push({ text: chalk.dim(" No units.") });

		// Keep the selected logical row visible through refreshes and resizes.
		const selectedLine = body.findIndex(line => line.flat === this.#selected);
		const display = body.map(entry => {
			if (entry.flat === this.#selected) {
				const plain = ` ❯${Bun.stripANSI(entry.text).slice(2)}`;
				return truncateToWidth(chalk.inverse(plain.padEnd(width)), width);
			}
			return truncateToWidth(entry.text, width);
		});
		this.#tableView.setLines(display);
		this.#tableView.setHeight(bodyHeight);
		this.#tableView.setActiveRow(selectedLine >= 0 ? selectedLine : undefined);

		const lines = [header, ...this.#tableView.render(width)];
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}

	#renderInfo(width: number, height: number): string[] {
		const info = this.#info;
		const header = this.#header(width, "unit info");
		const footer = this.#footer(width, `${formatKeyHint("escape")} back · ${formatKeyHint("q")} back`);
		const body = [""];
		if (info) {
			const { unit, proc } = info;
			body.push(` ${chalk.bold(unitLabel(unit))}`);
			body.push("");
			const rows: KeyValueRow[] = [
				{ label: "id:", value: unit.id },
				{ label: "scope:", value: scopeHeader(unit.scope) },
			];
			const command = formatCommand(proc) ?? unit.command;
			if (command) rows.push({ label: "command:", value: collapseCommand(command) });
			const cwd = proc?.cwd ?? unit.cwd;
			if (cwd) rows.push({ label: "cwd:", value: cwd });
			if (!TERMINAL_STATES[unit.state])
				rows.push({ label: "uptime:", value: formatDuration(Date.now() - unit.startedAt) });
			if (unit.exitReason) rows.push({ label: "exit:", value: unit.exitReason });
			rows.push({ label: "restarts:", value: `${unit.restartCount} (policy: ${unit.policy.restart})` });
			rows.push({ label: "leases:", value: `${unit.leases}  idle: ${idleCell(unit)}` });
			rows.push({ label: "owner:", value: unit.owner ?? "-" });
			this.#infoList.setRows(rows);
			body.push(...this.#infoList.render(width));
			body.push(`   pty: ${proc?.pty ?? false}  hold: ${unit.policy.hold}  survive: ${unit.policy.survive}`);
		} else {
			body.push(chalk.dim(" loading…"));
		}
		this.#infoView.setLines(body);
		this.#infoView.setHeight(height - 1 - footer.length);
		return [header, ...this.#infoView.render(width), ...footer];
	}

	#renderLogs(width: number, height: number): string[] {
		const entry = this.#flat[this.#selected];
		const name = entry ? unitName(entry.unit) : "?";
		const header = this.#header(
			width,
			`logs ${chalk.bold(name)}${this.#logsState ? chalk.dim(` · ${this.#logsState}`) : ""}`,
		);
		const footer = this.#footer(
			width,
			`${formatKeyHint("escape")} back · ${formatKeyHint("q")} back · view refreshes live`,
		);
		const bodyHeight = height - 1 - footer.length;
		this.#logsView.setLines(this.#logsLines.map(line => ` ${line}`));
		this.#logsView.setHeight(bodyHeight);
		const lines = [header, ...this.#logsView.render(width)];
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}
}

function flatKey(entry: FlatRow): string {
	return entry.unit.id;
}

/** Semantic tone of a unit state (the ANSI STATE cell's colour). */
function unitTone(snapshot: UnitSnapshot): TspTone {
	if (snapshot.state === "ready" || snapshot.state === "running") return "success";
	if (snapshot.state === "failed") return "error";
	return TERMINAL_STATES[snapshot.state] ? "muted" : "warning";
}

/** Scope heading spans, e.g. `project /work/pi`. */
function scopeSpans(scope: UnitScope): TspSpan[] {
	const { kind, name } = scopeTitle(scope);
	if (!name) return [span(kind, "strong")];
	return [span(`${kind} `), span(name, scope.kind === "project" ? "strong path" : "strong mono")];
}

/** A state as the table shows it: `ready`, `exited(143)`. */
function stateLabel(snapshot: UnitSnapshot): string {
	return TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined
		? `${snapshot.state}(${snapshot.exitCode})`
		: snapshot.state;
}

/** Status icon of a unit state (tinted by {@link unitTone}). */
const STATE_ICON: Record<TspTone, string> = {
	success: "check",
	error: "x",
	muted: "stop",
	warning: "clock",
	neutral: "activity",
	accent: "activity",
	info: "activity",
	pending: "clock",
	user: "user",
};

/** One selectable unit row: kind and name, state/pids/uptime/leases/idle/flags, and the launch command. */
function describeUnit(scope: UnitScope, unit: UnitSnapshot): NativeNode {
	const terminal = TERMINAL_STATES[unit.state] === true;
	const state = stateLabel(unit);
	const pids = pidsCell(unit);
	const idle = idleCell(unit);
	const meta = [
		unit.kind,
		pids === "-" ? undefined : `pid ${pids}`,
		terminal ? undefined : formatDuration(Date.now() - unit.startedAt),
		unit.leases > 0 ? `${unit.leases} lease${unit.leases === 1 ? "" : "s"}` : undefined,
		idle === "-" ? undefined : `idle ${idle}`,
		unit.restartCount > 0 ? `${unit.restartCount} restart${unit.restartCount === 1 ? "" : "s"}` : undefined,
		flagsCell(unit) || undefined,
	].filter(part => part !== undefined);
	const command = collapseCommand(unit.command);
	const tone = unitTone(unit);
	return node(
		"item",
		{
			label: [span(unitName(unit), terminal ? "dim" : "strong")],
			detail: command ? [span(command, "mono muted")] : undefined,
			value: [span(state, tone === "muted" ? "dim" : tone), span(` · ${meta.join(" · ")}`, "muted")],
			icon: STATE_ICON[tone],
			tone,
			title: unitLabel(unit),
		},
		undefined,
		stableKey(flatKey({ scope, unit })),
	);
}

/** Run the fullscreen interactive process monitor until the user quits. */
export async function runPsTop(options: PsTopOptions, host: PsTopHost): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new PsTopComponent(ui, options, host);
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
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
