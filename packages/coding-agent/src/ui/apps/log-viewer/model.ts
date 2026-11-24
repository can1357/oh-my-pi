/**
 * The log viewer's screen state: the entries (see {@link LogEntries}), the
 * filter field, the status line, whether older history is loading, and the
 * terminal frame the list scrolls in. Every key, pointer and native event
 * runs through here; `version` changes whenever anything shown changes.
 */
import { type Accessor, type Reactive, signal } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ViewerFrameModel } from "../viewer-frame";
import { LOG_CHUNK, LogEntries, logCopyPayload } from "./entries";

/** The session boundary row. */
export const SESSION_BOUNDARY_WARNING = "### WARNING - Logs above are older than current session!";
/** The load-older row. */
export const LOAD_OLDER_LABEL = "### MOVE UP TO LOAD MORE...";
/** Wheel notches scroll this many rows. */
const WHEEL_ROWS = 3;

/** Host capabilities: the clipboard and older history. */
export interface LogViewerDeps {
	copyToClipboard(text: string): void;
	hasOlderLogs?(): boolean;
	loadOlderLogs?(): Promise<string>;
}

export interface LogViewerOptions {
	/** Recent log text (JSON lines, oldest first). */
	readonly logs: string;
	readonly deps: LogViewerDeps;
	/** Screen rows the terminal frame fills. */
	readonly terminalRows: Reactive<number>;
	/** When this process started (default: from its uptime). */
	readonly processStartMs?: number;
	readonly processPid?: number;
	onExit(): void;
	onStatus?(message: string): void;
	onError?(message: string): void;
}

/** A log line as display text (controls dropped, tabs expanded). */
export function displayLine(line: string): string {
	return replaceTabs(stripControl(line));
}

export class LogViewerModel {
	readonly entries: LogEntries;
	readonly frame: ViewerFrameModel;
	readonly #options: LogViewerOptions;
	readonly #version = signal(0);
	#filter = "";
	#status: string | undefined;
	#loading = false;
	/** Row index of each body line of the last terminal frame. */
	#bodyRows: (number | undefined)[] = [];

	constructor(options: LogViewerOptions) {
		this.#options = options;
		this.entries = new LogEntries(options.logs, {
			processStartMs: options.processStartMs ?? Date.now() - process.uptime() * 1000,
			processPid: options.processPid ?? process.pid,
			hasOlderLogs: options.deps.hasOlderLogs && (() => options.deps.hasOlderLogs!()),
			loadOlderLogs: options.deps.loadOlderLogs && (() => options.deps.loadOlderLogs!()),
		});
		this.frame = new ViewerFrameModel({
			title: "Recent Logs",
			height: options.terminalRows,
			headerRows: 2,
			footerRows: 2,
			minimumBodyRows: 3,
			content: context => this.#frameContent(context.contentWidth),
		});
	}

	/** Changes whenever what the viewer shows changes. */
	readonly version: Accessor<number> = () => this.#version();

	get filter(): string {
		this.#version();
		return this.#filter;
	}

	get status(): string | undefined {
		this.#version();
		return this.#status;
	}

	get loading(): boolean {
		this.#version();
		return this.#loading;
	}

	#changed(): void {
		this.#version.update(n => n + 1);
	}

	/** Run `change`, clearing the status line first. */
	#act(change: () => void): true {
		this.#status = undefined;
		change();
		this.#changed();
		return true;
	}

	key(id: string, text: string | undefined): boolean {
		const entries = this.entries;
		switch (id) {
			case "escape":
				this.#options.onExit();
				return true;
			case "ctrl+c":
				this.copySelected();
				return true;
			case "ctrl+p":
				return this.#act(() => entries.toggleProcessOnly());
			case "ctrl+a":
				return this.#act(() => entries.selectAll());
			case "ctrl+o":
				return this.#act(() => void this.loadOlder(this.frame.bodyHeight() + 1));
			case "enter":
				if (entries.cursorRow?.kind === "load-older") this.#act(() => void this.loadOlder());
				return true;
			case "shift+up":
			case "up":
				return this.#act(() => void this.#moveUp(id === "shift+up"));
			case "shift+down":
			case "down":
				return this.#act(() => entries.move(1, id === "shift+down"));
			case "pageUp":
				return this.#act(() => entries.move(-this.frame.bodyHeight(), false));
			case "pageDown":
				return this.#act(() => entries.move(this.frame.bodyHeight(), false));
			case "home":
				return this.#act(() => entries.move(-entries.rows.length, false));
			case "end":
				return this.#act(() => entries.move(entries.rows.length, false));
			case "right":
				return this.#act(() => {
					if (entries.cursorRow?.kind === "load-older") void this.loadOlder();
					else entries.expandSelected();
				});
			case "left":
				return this.#act(() => entries.collapseSelected());
		}
		const next = this.#editFilter(id, text);
		if (next !== undefined && next !== this.#filter) {
			this.#act(() => {
				this.#filter = next;
				entries.setQuery(next);
			});
		}
		return next !== undefined;
	}

	/** The filter after a key, or undefined when the key does not edit it. */
	#editFilter(id: string, text: string | undefined): string | undefined {
		if (id === "backspace")
			return [...new Intl.Segmenter().segment(this.#filter)]
				.slice(0, -1)
				.map(s => s.segment)
				.join("");
		if (id === "ctrl+u") return "";
		if (id === "ctrl+w") return this.#filter.replace(/\S*\s*$/, "");
		if (text !== undefined && text.length > 0 && !/[\x00-\x1f\x7f]/.test(text)) return this.#filter + text;
		return undefined;
	}

	/** A pointer event at frame row `row`: the wheel scrolls; a click moves there and toggles the entry (or loads older). */
	mouse(row: number, mouse: MouseEvent): boolean {
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			if (!this.frame.isBodyFrameRow(row)) return false;
			return this.#act(() => this.frame.scroll(mouse.button === "wheel-down" ? WHEEL_ROWS : -WHEEL_ROWS));
		}
		if (mouse.button !== "left" || mouse.action !== "press") return false;
		const line = this.frame.toBodyRow(row);
		const rowIndex = line === undefined ? undefined : this.#bodyRows[line];
		const target = rowIndex === undefined ? undefined : this.entries.rows[rowIndex];
		if (rowIndex === undefined || !target || target.kind === "warning") return false;
		return this.#act(() => {
			this.entries.moveToRow(rowIndex, false);
			if (target.kind === "load-older") void this.loadOlder();
			else if (this.entries.isExpanded(target.logIndex)) this.entries.collapseSelected();
			else this.entries.expandSelected();
		});
	}

	/** A picker row or bar button (native). */
	select(item: string, activate: boolean): void {
		const rowIndex = this.entries.rows.findIndex(row =>
			item === "older" ? row.kind === "load-older" : row.kind === "log" && `l${row.logIndex}` === item,
		);
		this.#status = undefined;
		if (rowIndex < 0 || !this.entries.moveToRow(rowIndex, false)) {
			this.#changed();
			return;
		}
		this.#changed();
		if (!activate) return;
		if (item === "older") void this.loadOlder();
		else this.copySelected();
	}

	action(act: string): void {
		this.#status = undefined;
		this.#changed();
		if (act === "copy") this.copySelected();
		else if (act === "all") this.#act(() => this.entries.selectAll());
		else if (act === "pid") this.#act(() => this.entries.toggleProcessOnly());
		else if (act === "older") void this.loadOlder(this.frame.bodyHeight() + 1);
		else if (act === "close") this.#options.onExit();
	}

	copySelected(): void {
		const payload = logCopyPayload(this.entries.selected().map(index => this.entries.rawLine(index)));
		const count = payload.length === 0 ? 0 : payload.split("\n").length;
		if (count === 0) {
			this.#status = "No log entry selected";
			this.#options.onStatus?.(this.#status);
		} else {
			try {
				this.#options.deps.copyToClipboard(payload);
				this.#status = `Copied ${count} log ${count === 1 ? "entry" : "entries"}`;
				this.#options.onStatus?.(this.#status);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#status = `Copy failed: ${message}`;
				this.#options.onError?.(`Failed to copy logs: ${message}`);
			}
		}
		this.#changed();
	}

	/** Show more older entries (one guard against overlapping loads). */
	async loadOlder(count = LOG_CHUNK): Promise<boolean> {
		if (this.#loading || !this.entries.canLoadOlder()) return false;
		this.#loading = true;
		this.#changed();
		try {
			return await this.entries.loadOlder(count);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#status = `Load older failed: ${message}`;
			this.#options.onError?.(`Failed to load older logs: ${message}`);
			return false;
		} finally {
			this.#loading = false;
			this.#changed();
		}
	}

	/** Up from the first row (or the load-older row) loads older entries first. */
	async #moveUp(extend: boolean): Promise<void> {
		const entries = this.entries;
		if (entries.cursorRow?.kind === "load-older" && (await this.loadOlder())) return;
		if (entries.canLoadOlder() && entries.atFirstStop && (await this.loadOlder())) {
			entries.move(-1, extend);
			this.#changed();
			return;
		}
		entries.move(-1, extend);
		this.#changed();
	}

	#frameContent(width: number) {
		this.#version();
		const theme = currentTheme();
		const entries = this.entries;
		const lines: string[] = [];
		const owners: (number | undefined)[] = [];
		const cursorRow = entries.cursorRowIndex;
		const cursorLog = entries.cursorLogIndex;
		const selected = new Set(entries.selected());
		let anchor: { id: string; start: number; end: number; margin: number } | undefined;
		entries.rows.forEach((row, rowIndex) => {
			const start = lines.length;
			if (row.kind === "warning") {
				lines.push(theme.fg("muted", truncate(SESSION_BOUNDARY_WARNING, width)));
			} else if (row.kind === "load-older") {
				const prefix = `${cursorRow === rowIndex ? theme.fg("accent", "❯") : " "}  `;
				const label = truncate(LOAD_OLDER_LABEL, Math.max(1, width - visibleWidth(prefix)));
				lines.push(truncate(`${prefix}${theme.fg("muted", label)}`, width));
			} else {
				const isSelected = selected.has(row.logIndex);
				const marker =
					cursorLog === row.logIndex ? theme.fg("accent", "❯") : isSelected ? theme.fg("accent", "•") : " ";
				const expanded = entries.isExpanded(row.logIndex);
				const prefix = `${marker}${expanded ? theme.fg("accent", "▾") : theme.fg("muted", "▸")} `;
				const room = Math.max(1, width - visibleWidth(prefix));
				const text = displayLine(entries.rawLine(row.logIndex));
				const bold = (content: string) => (isSelected ? theme.style("strong", content) : content);
				if (expanded) {
					const segments = text.length === 0 ? [""] : text.split("\n").flatMap(part => wrap(part, room));
					const indent = " ".repeat(visibleWidth(prefix));
					segments.forEach((segment, i) =>
						lines.push(truncate(`${i === 0 ? prefix : indent}${bold(segment)}`, width)),
					);
				} else {
					lines.push(truncate(`${prefix}${bold(truncate(text, room))}`, width));
				}
			}
			while (owners.length < lines.length) owners.push(rowIndex);
			if (rowIndex === cursorRow && row.kind !== "warning") {
				anchor = {
					id: row.kind === "log" ? `log:${row.logIndex}` : "load-older",
					start,
					end: lines.length,
					margin: 1,
				};
			}
		});
		if (lines.length === 0) {
			lines.push(theme.fg("muted", "no matches"));
			owners.push(undefined);
		}
		this.#bodyRows = owners;
		const count = selected.size;
		const expandedCount = entries.expandedCount;
		const limit = entries.historyLimitReached ? `  ${theme.fg("warning", "history limit reached")}` : "";
		const summary = `${theme.fg("muted", "showing")} ${theme.fg("accent", `${entries.visibleCount}/${entries.count}`)}  ${theme.fg("muted", "selected")} ${theme.fg(count > 0 ? "accent" : "muted", String(count))}  ${theme.fg("muted", "expanded")} ${theme.fg(expandedCount > 0 ? "accent" : "muted", String(expandedCount))}${limit}`;
		const caret = theme.style("inverse", " ");
		const query =
			this.#filter.length === 0
				? `${caret}${theme.fg("muted", "type to filter")}`
				: theme.fg("accent", `${this.#filter}${caret}`);
		const pid = entries.processOnly ? theme.fg("success", "pid on") : theme.fg("muted", "pid off");
		const loading = this.#loading ? `  ${theme.fg("warning", "loading older…")}` : "";
		const filter = `${theme.fg("muted", "filter")} ${query}  ${pid}${loading}`;
		const status = this.#status
			? theme.fg("success", this.#status)
			: theme.fg("dim", "⏎ loads older when highlighted; printable keys update filter");
		const controls = theme.fg(
			"dim",
			"⎋ close · ⌃C copy · ↑/↓/wheel move · PgUp/PgDn page · Home/End first/last · click toggle · ⇧↑/⇧↓ select · ←/→ collapse/expand · ⌃A all · ⌃O older · ⌃P pid",
		);
		return {
			header: [summary, filter],
			body: anchor ? { lines, anchor } : { lines },
			footer: [status, controls],
		};
	}
}
