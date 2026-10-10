/**
 * Interactive alt-screen monitor for `omp ps` (btop idiom): a live process
 * table over every selected broker scope with in-place actions.
 *
 * Keys — table: `↑/↓`/`j/k` select, `enter`/`i` info, `l` logs, `s` stop,
 * `x` kill, `r` restart, `a` toggle all scopes, `q`/`esc`/`ctrl+c` quit.
 * Sub-views (info, logs): `esc`/`q` back.
 */
import * as path from "node:path";
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
import { actionBar, actionButton } from "../native/overlay";
import { Memo } from "../native/memo";
import { truncateToWidth } from "../utils";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { DaemonSnapshot, DaemonSpec } from "../tools/daemon";
import {
	collapseCommand,
	daemonLabel,
	formatCommand,
	type PsDaemonRow,
	type PsScope,
	type PsScopeReport,
	type PsTarget,
	scopeHeader,
	flagsCell,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCells,
} from "./ps-data";

const REFRESH_MS = 2_000;
const LOGS_POLL_MS = 1_000;
const STATUS_TTL_MS = 5_000;

interface FlatRow {
	scope: PsScope;
	row: PsDaemonRow;
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

/** Broker capabilities supplied by the process command. */
export interface PsTopHost {
	collectReports(all: boolean, target: PsTarget): Promise<PsScopeReport[]>;
	act(scope: PsScope, name: string, verb: "stop" | "kill" | "restart"): Promise<DaemonSnapshot>;
	describe(scope: PsScope, name: string): Promise<{ daemon: DaemonSnapshot; spec: DaemonSpec }>;
	logs(scope: PsScope, name: string, lines: number): Promise<{ terminalRows?: string[]; text: string; state: string }>;
	close(): void;
}

/** Interactive process table and detail views. */
export class PsTopComponent implements Component {
	readonly #ui: TUI;
	readonly #target: PsTarget;
	readonly #done = Promise.withResolvers<void>();
	readonly #host: PsTopHost;
	#all: boolean;
	#reports: PsScopeReport[] = [];
	#flat: FlatRow[] = [];
	#selected = 0;
	/** `runtimeDir\u0000name` of the selection, kept stable across refreshes. */
	#selectedKey: string | undefined;
	readonly #tableView = new ScrollView([], { height: 1 });
	readonly #infoView = new ScrollView([], { height: 1 });
	readonly #logsView = new ScrollView([], { height: 1, followTail: true, anchor: "end" });
	readonly #infoList = new KeyValueList([], { indent: "   ", labelWidth: 9, gap: " " });
	#view: PsTopView = "table";
	#info: { daemon: DaemonSnapshot; spec: DaemonSpec } | undefined;
	#logsLines: string[] = [];
	#logsState = "";
	#logsTimer: NodeJS.Timeout | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
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
		this.#target = { dir: options.dir, global: options.global };
	}

	run(): Promise<void> {
		void this.#refresh();
		this.#refreshTimer = setInterval(() => void this.#refresh(), REFRESH_MS);
		return this.#done.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
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
			const reports = await this.#host.collectReports(this.#all, this.#target);
			if (this.#disposed) return;
			this.#reports = reports;
			this.#flat = reports.flatMap(report => report.daemons.map(row => ({ scope: report.scope, row })));
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
		const name = entry.row.snapshot.name;
		this.#setStatus("warning", `${verb} ${name}…`);
		try {
			const daemon = await this.#host.act(entry.scope, name, verb);
			this.#setStatus(
				"success",
				`${verb === "restart" ? "Restarted" : verb === "kill" ? "Killed" : "Stopped"} ${daemonLabel(daemon)}`,
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
			this.#info = await this.#host.describe(entry.scope, entry.row.snapshot.name);
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
				const result = await this.#host.logs(
					current.scope,
					current.row.snapshot.name,
					Math.max(10, this.#ui.terminal.rows - 4),
				);
				this.#logsLines = result.terminalRows ?? result.text.replace(/\n$/, "").split("\n");
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
	 * control, freshness, close), one section per broker scope with a
	 * selectable process list, the transient status, and an action bar that
	 * mirrors the keys. Info and logs replace the list.
	 */
	describe(): NativeNode {
		const statusVisible = Date.now() - this.#statusAt < STATUS_TTL_MS;
		return this.#native.get(
			[
				this.#view,
				this.#reports,
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
			const running = this.#flat.filter(flat => !TERMINAL_STATES[flat.row.snapshot.state]).length;
			const stopped = this.#flat.length - running;
			left.push(
				text("Processes", { role: "omp.app.title" }),
				text(
					[
						span(`${running} running`, running > 0 ? "success" : "muted"),
						...(stopped > 0 ? [span(` · ${stopped} stopped`, "muted")] : []),
						span(` · ${this.#reports.length} scope${this.#reports.length === 1 ? "" : "s"}`, "muted"),
					],
					{ truncate: "end" },
				),
			);
		} else {
			left.push(
				node("icon", {
					name: "back",
					role: "omp.app.ibtn",
					title: "Back  esc",
					aria: "Back",
					actions: { click: "back" },
				}),
				text(
					this.#view === "logs" ? `Logs · ${entry?.row.snapshot.name ?? "?"}` : (entry?.row.snapshot.name ?? "?"),
					{
						role: "omp.app.title",
						truncate: "end",
					},
				),
			);
			const daemon = this.#view === "info" ? this.#info?.daemon : entry?.row.snapshot;
			if (daemon) left.push(node("badge", { text: stateLabel(daemon), tone: daemonTone(daemon) }));
			if (this.#view === "logs" && this.#logsState) left.push(text([span(this.#logsState, "muted")]));
		}
		const right: NativeNode[] = [];
		if (this.#view === "table") {
			right.push(
				node(
					"tabs",
					{
						items: [
							{
								id: "current",
								label:
									this.#target.dir !== undefined || this.#target.global !== undefined
										? "Target"
										: "This project",
							},
							{ id: "all", label: "All scopes" },
						],
						active: this.#all ? "all" : "current",
						role: "omp.app.seg",
					},
					undefined,
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
			node("icon", { name: "x", role: "omp.app.ibtn", title: "Quit  q", aria: "Quit", actions: { click: "quit" } }),
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
			const pid = entry.row.snapshot.pid;
			return keyed(
				row(
					[
						text(
							[
								span(`Kill ${entry.row.snapshot.name}${pid === undefined ? "" : ` (pid ${pid})`}?`, "strong"),
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
						text("No broker scopes", { role: "omp.app.empty-title" }),
						text([
							span("No omp process broker runs here. ", "muted"),
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
								selected && selected.scope.runtimeDir === report.scope.runtimeDir
									? stableKey(flatKey(selected))
									: null,
							empty: "No processes",
							role: "omp.ps.processes",
						},
						report.daemons.map(daemon => describeProcess(report.scope, daemon)),
					),
				],
				stableKey(report.scope.runtimeDir),
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
		const { daemon, spec } = info;
		const items: { k: string; v: TspText }[] = [
			{ k: "Command", v: [span(collapseCommand(formatCommand(spec)), "mono")] },
			{ k: "Directory", v: [span(spec.cwd, "path")] },
		];
		if (daemon.pid !== undefined && !TERMINAL_STATES[daemon.state])
			items.push({ k: "PID", v: [span(String(daemon.pid), "num")] });
		if (daemon.exitReason) items.push({ k: "Exit", v: [span(daemon.exitReason, "error")] });
		items.push({ k: "Restarts", v: `${daemon.restartCount} (policy ${spec.restart})` });
		items.push({ k: "Owner", v: daemon.owner ?? "—" });
		const flags = [spec.pty && "pty", spec.persist && "persist", spec.detached && "detached"].filter(Boolean);
		items.push({ k: "Flags", v: flags.length > 0 ? flags.join(" · ") : "—" });
		const body: NativeNode[] = [];
		if (!TERMINAL_STATES[daemon.state]) {
			body.push(
				row([text([span("Up for", "muted")]), elapsed(Date.now() - daemon.startedAt)], {
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
			: this.#target.dir !== undefined || this.#target.global !== undefined
				? "(target)"
				: "(current + global)";
		const scopesLabel = `${this.#flat.length} process${this.#flat.length === 1 ? "" : "es"} in ${this.#reports.length} scope${this.#reports.length === 1 ? "" : "s"} ${chalk.dim(scopeKind)}`;
		const header = this.#header(width, scopesLabel);
		const footer = this.#footer(
			width,
			`${formatKeyHints(["up", "down"])} select · ${formatKeyHint("enter")} info · ${formatKeyHint("l")} logs · ${formatKeyHint("s")} stop · ${formatKeyHint("x")} kill · ${formatKeyHint("r")} restart · ${formatKeyHint("a")} all scopes · ${formatKeyHint("q")} quit`,
		);
		const bodyHeight = height - 1 - footer.length;

		const cells = this.#flat.map(entry => tableCells(entry.row));
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
		const body: { text: string; flat?: number }[] = [];
		let flatIndex = 0;
		for (const report of this.#reports) {
			body.push({ text: ` ${scopeHeader(report.scope)}` });
			if (report.daemons.length === 0) {
				body.push({ text: chalk.dim("   no processes") });
			} else {
				body.push({ text: chalk.dim(renderRow([...TABLE_HEADER])) });
				for (const row of report.daemons) {
					const line = renderRow(tableCells(row));
					body.push({
						text: TERMINAL_STATES[row.snapshot.state] ? chalk.dim(line) : line,
						flat: flatIndex,
					});
					flatIndex++;
				}
			}
			body.push({ text: "" });
		}
		if (body.length === 0) body.push({ text: chalk.dim(" No daemon broker scopes found.") });

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
		const header = this.#header(width, "process info");
		const footer = this.#footer(width, `${formatKeyHint("escape")} back · ${formatKeyHint("q")} back`);
		const body = [""];
		if (info) {
			const daemon = info.daemon;
			body.push(` ${chalk.bold(daemonLabel(daemon))}`);
			body.push("");
			const rows: KeyValueRow[] = [
				{ label: "command:", value: collapseCommand(formatCommand(info.spec)) },
				{ label: "cwd:", value: info.spec.cwd },
			];
			if (!TERMINAL_STATES[daemon.state])
				rows.push({ label: "uptime:", value: formatDuration(Date.now() - daemon.startedAt) });
			if (daemon.exitReason) rows.push({ label: "exit:", value: daemon.exitReason });
			rows.push({ label: "restarts:", value: `${daemon.restartCount} (policy: ${info.spec.restart})` });
			rows.push({ label: "owner:", value: daemon.owner ?? "-" });
			this.#infoList.setRows(rows);
			body.push(...this.#infoList.render(width));
			body.push(`   pty: ${info.spec.pty}  persist: ${info.spec.persist}  detached: ${info.spec.detached}`);
		} else {
			body.push(chalk.dim(" loading…"));
		}
		this.#infoView.setLines(body);
		this.#infoView.setHeight(height - 1 - footer.length);
		return [header, ...this.#infoView.render(width), ...footer];
	}

	#renderLogs(width: number, height: number): string[] {
		const entry = this.#flat[this.#selected];
		const name = entry?.row.snapshot.name ?? "?";
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
	return `${entry.scope.runtimeDir}\u0000${entry.row.snapshot.name}`;
}

/** Semantic tone of a process state (the ANSI STATE cell's colour). */
function daemonTone(snapshot: DaemonSnapshot): TspTone {
	if (snapshot.state === "ready" || snapshot.state === "running") return "success";
	if (snapshot.state === "failed") return "error";
	return TERMINAL_STATES[snapshot.state] ? "muted" : "warning";
}

/** Scope heading spans, e.g. `project /work/pi — broker pid 1234`. */
function scopeSpans(scope: PsScope): TspSpan[] {
	const spans =
		scope.kind === "global"
			? [span("global "), span(scope.service ?? path.basename(scope.runtimeDir), "strong")]
			: [span("project "), span(scope.projectDir ?? path.basename(scope.runtimeDir), "strong path")];
	spans.push(span(" — ", "dim"));
	spans.push(
		scope.brokerPid !== undefined
			? span(`broker pid ${scope.brokerPid}`, "success")
			: span("broker not running", "dim"),
	);
	return spans;
}

/** A state as the table shows it: `ready`, `exited(143)`. */
function stateLabel(snapshot: DaemonSnapshot): string {
	return TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined
		? `${snapshot.state}(${snapshot.exitCode})`
		: snapshot.state;
}

/** Status icon of a process state (tinted by {@link daemonTone}). */
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

/** One selectable process row: name, state/pid/uptime/restarts/flags, and the launch command. */
function describeProcess(scope: PsScope, daemon: PsDaemonRow): NativeNode {
	const { snapshot } = daemon;
	const terminal = TERMINAL_STATES[snapshot.state] === true;
	const state = stateLabel(snapshot);
	const meta = [
		snapshot.pid !== undefined && !terminal ? `pid ${snapshot.pid}` : undefined,
		terminal ? undefined : formatDuration(Date.now() - snapshot.startedAt),
		`${snapshot.restartCount} restart${snapshot.restartCount === 1 ? "" : "s"}`,
		flagsCell(daemon) || undefined,
	].filter(part => part !== undefined);
	const command = collapseCommand(daemon.command);
	const tone = daemonTone(snapshot);
	return node(
		"item",
		{
			label: [span(snapshot.name, terminal ? "dim" : "strong")],
			detail: command ? [span(command, "mono muted")] : undefined,
			value: [span(state, tone === "muted" ? "dim" : tone), span(` · ${meta.join(" · ")}`, "muted")],
			icon: STATE_ICON[tone],
			tone,
			title: daemonLabel(snapshot),
		},
		undefined,
		stableKey(flatKey({ scope, row: daemon })),
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
