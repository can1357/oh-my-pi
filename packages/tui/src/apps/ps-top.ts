/**
 * Interactive alt-screen monitor for `omp ps` (btop idiom): a live process
 * table over every selected broker scope with in-place actions.
 *
 * Keys — table: `↑/↓`/`j/k` select, `enter`/`i` info, `l` logs, `s` stop,
 * `x` kill, `r` restart, `a` toggle all scopes, `q`/`esc`/`ctrl+c` quit.
 * Sub-views (info, logs): `esc`/`q` back.
 */
import { KeyValueList, type KeyValueRow } from "../components/key-value-list";
import { ScrollView } from "../components/scroll-view";
import { renderTableRow, type TableColumn } from "../components/table";
import { matchesKey } from "../keys";
import { ProcessTerminal } from "../terminal";
import { type Component, TUI } from "../tui";
import { truncateToWidth } from "../utils";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { DaemonSnapshot, DaemonSpec } from "../tools/hub";
import {
	collapseCommand,
	daemonLabel,
	formatCommand,
	type PsDaemonRow,
	type PsScope,
	type PsScopeReport,
	type PsTarget,
	scopeHeader,
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
	#statusAt = 0;
	#disposed = false;

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
			this.#setStatus(chalk.red(error instanceof Error ? error.message : String(error)));
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

	#setStatus(text: string): void {
		this.#status = text;
		this.#statusAt = Date.now();
		this.#ui.requestRender();
	}

	// -- actions ---------------------------------------------------------------

	async #act(verb: "stop" | "kill" | "restart"): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		const name = entry.row.snapshot.name;
		this.#setStatus(chalk.yellow(`${verb} ${name}…`));
		try {
			const daemon = await this.#host.act(entry.scope, name, verb);
			this.#setStatus(
				chalk.green(
					`${verb === "restart" ? "Restarted" : verb === "kill" ? "Killed" : "Stopped"} ${daemonLabel(daemon)}`,
				),
			);
			void this.#refresh();
		} catch (error) {
			this.#setStatus(
				chalk.red(`${verb} ${name} failed: ${error instanceof Error ? error.message : String(error)}`),
			);
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
			this.#setStatus(chalk.red(error instanceof Error ? error.message : String(error)));
		}
	}

	#openLogs(): void {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		this.#view = "logs";
		this.#logsLines = [];
		this.#logsState = "";
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
				this.#ui.requestRender();
			} catch (error) {
				this.#logsLines = [chalk.red(error instanceof Error ? error.message : String(error))];
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
		else if (data === "a") {
			this.#all = !this.#all;
			this.#setStatus(chalk.dim(this.#all ? "Showing all scopes" : "Showing current scope"));
			void this.#refresh();
		} else if (matchesKey(data, "enter") || data === "i") void this.#openInfo();
		else if (data === "l") this.#openLogs();
		else if (data === "s") void this.#act("stop");
		else if (data === "x") void this.#act("kill");
		else if (data === "r") void this.#act("restart");
	}

	#moveSelection(delta: number): void {
		if (this.#flat.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#flat.length - 1, this.#selected + delta));
		this.#selectedKey = flatKey(this.#flat[this.#selected]);
		this.#ui.requestRender();
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
		const scopesLabel = `${this.#flat.length} process${this.#flat.length === 1 ? "" : "es"} in ${this.#reports.length} scope${this.#reports.length === 1 ? "" : "s"} ${chalk.dim(this.#all ? "(all)" : "(current)")}`;
		const header = this.#header(width, scopesLabel);
		const footer = this.#footer(
			width,
			"↑/↓ select · enter info · l logs · s stop · x kill · r restart · a all scopes · q quit",
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
		const footer = this.#footer(width, "esc back · q back");
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
		const footer = this.#footer(width, "esc back · q back · view refreshes live");
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
