import type { Component } from "../../tui";
import { extractPrintableText, matchesKey } from "../../keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { padding, replaceTabs, truncateToWidth, visibleWidth } from "../../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../../theme/theme";
import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { DebugViewerFrame, type DebugViewerFrameContent, type DebugViewerFrameContext } from "./viewer-frame";
import { formatDebugLogExpandedLines, parseDebugLogPid, parseDebugLogTimestampMs } from "./log-formatting";
/** Host capabilities for copying and fetching earlier log entries. */
export interface LogViewerDeps {
	copyToClipboard(text: string): void;
	hasOlderLogs?(): boolean;
	loadOlderLogs?(limitDays?: number): Promise<string>;
}

/** Separator marking logs captured before the current process started. */
export const SESSION_BOUNDARY_WARNING = "### WARNING - Logs above are older than current session!";
/** Action row for loading earlier log entries. */
export const LOAD_OLDER_LABEL = "### MOVE UP TO LOAD MORE...";

const INITIAL_LOG_CHUNK = 50;
const LOAD_OLDER_CHUNK = 50;
const MIN_LOG_VIEWER_WIDTH = 48;

type LogEntry = {
	rawLine: string;
	timestampMs: number | undefined;
	pid: number | undefined;
};

type CursorToken = { kind: "log"; logIndex: number } | { kind: "load-older" };

type DebugLogViewerModelOptions = {
	processStartMs?: number;
	processPid?: number;
	hasOlderLogs?: () => boolean;
	loadOlderLogs?: (limitDays?: number) => Promise<string>;
};

type ViewerRow =
	| {
			kind: "warning";
	  }
	| {
			kind: "load-older";
	  }
	| {
			kind: "log";
			logIndex: number;
	  };

function getProcessStartMs(): number {
	return Date.now() - process.uptime() * 1000;
}

/** Split raw log text into nonempty entries. */
export function splitLogText(logText: string): string[] {
	return logText.split("\n").filter(line => line.length > 0);
}

/** Build sanitized clipboard text from selected log entries. */
export function buildLogCopyPayload(lines: string[]): string {
	return lines
		.map(line => sanitizeText(line))
		.filter(line => line.length > 0)
		.join("\n");
}

/** Filter, paginate, expand, and select captured log entries. */
export class DebugLogViewerModel {
	#entries: LogEntry[];
	#rows: ViewerRow[];
	#visibleLogIndices: number[];
	#selectableRowIndices: number[];
	#cursorSelectableIndex = 0;
	#selectionAnchorSelectableIndex: number | undefined;
	#expandedLogIndices = new Set<number>();
	#filterQuery = "";
	#processStartMs: number;
	#loadedStartIndex: number;
	#processFilterEnabled = false;
	#processPid: number;
	#hasOlderLogs?: () => boolean;
	#loadOlderLogs?: (limitDays?: number) => Promise<string>;

	constructor(logText: string, options: DebugLogViewerModelOptions = {}) {
		const { processStartMs = getProcessStartMs(), processPid = process.pid, hasOlderLogs, loadOlderLogs } = options;
		this.#entries = splitLogText(logText).map(rawLine => ({
			rawLine,
			timestampMs: parseDebugLogTimestampMs(rawLine),
			pid: parseDebugLogPid(rawLine),
		}));
		this.#processStartMs = processStartMs;
		this.#processPid = processPid;
		this.#hasOlderLogs = hasOlderLogs;
		this.#loadOlderLogs = loadOlderLogs;
		this.#loadedStartIndex = Math.max(0, this.#entries.length - INITIAL_LOG_CHUNK);
		this.#rows = [];
		this.#visibleLogIndices = [];
		this.#selectableRowIndices = [];
		this.#rebuildRows();
	}

	get logCount(): number {
		return this.#entries.length;
	}

	get visibleLogCount(): number {
		return this.#visibleLogIndices.length;
	}

	get rows(): readonly ViewerRow[] {
		return this.#rows;
	}

	get cursorRowIndex(): number | undefined {
		return this.#selectableRowIndices[this.#cursorSelectableIndex];
	}

	get cursorLogIndex(): number | undefined {
		const row = this.#getCursorRow();
		return row?.kind === "log" ? row.logIndex : undefined;
	}

	get filterQuery(): string {
		return this.#filterQuery;
	}

	get cursorRowKind(): ViewerRow["kind"] | undefined {
		return this.#getCursorRow()?.kind;
	}

	get expandedCount(): number {
		return this.#expandedLogIndices.size;
	}

	isProcessFilterEnabled(): boolean {
		return this.#processFilterEnabled;
	}

	isCursorAtFirstSelectableRow(): boolean {
		return this.#cursorSelectableIndex === 0;
	}

	getRawLine(logIndex: number): string {
		return this.#entries[logIndex]?.rawLine ?? "";
	}

	setFilterQuery(query: string): void {
		if (query === this.#filterQuery) {
			return;
		}
		this.#filterQuery = query;
		this.#rebuildRows();
	}

	toggleProcessFilter(): void {
		this.#processFilterEnabled = !this.#processFilterEnabled;
		this.#rebuildRows();
	}

	moveCursor(delta: number, extendSelection: boolean): void {
		if (this.#selectableRowIndices.length === 0) {
			return;
		}

		if (extendSelection && this.#selectionAnchorSelectableIndex === undefined) {
			const row = this.#getCursorRow();
			if (row?.kind === "log") {
				this.#selectionAnchorSelectableIndex = this.#cursorSelectableIndex;
			}
		}

		this.#cursorSelectableIndex = Math.max(
			0,
			Math.min(this.#selectableRowIndices.length - 1, this.#cursorSelectableIndex + delta),
		);

		if (!extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}

		if (this.#getCursorRow()?.kind !== "log" && !extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}
	}

	moveCursorToRow(rowIndex: number, extendSelection: boolean): boolean {
		const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
		if (selectableIndex < 0) {
			return false;
		}

		if (extendSelection && this.#selectionAnchorSelectableIndex === undefined) {
			const row = this.#getCursorRow();
			if (row?.kind === "log") {
				this.#selectionAnchorSelectableIndex = this.#cursorSelectableIndex;
			}
		}

		this.#cursorSelectableIndex = selectableIndex;

		if (!extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}

		if (this.#getCursorRow()?.kind !== "log" && !extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}
		return true;
	}

	getSelectedLogIndices(): number[] {
		if (this.#selectableRowIndices.length === 0) {
			return [];
		}

		const cursorRow = this.#getCursorRow();
		if (this.#selectionAnchorSelectableIndex === undefined) {
			if (cursorRow?.kind !== "log") {
				return [];
			}
			return [cursorRow.logIndex];
		}

		const min = Math.min(this.#selectionAnchorSelectableIndex, this.#cursorSelectableIndex);
		const max = Math.max(this.#selectionAnchorSelectableIndex, this.#cursorSelectableIndex);
		const selected: number[] = [];
		for (let i = min; i <= max; i++) {
			const rowIndex = this.#selectableRowIndices[i];
			const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
			if (row?.kind === "log") {
				selected.push(row.logIndex);
			}
		}
		return selected;
	}

	getSelectedCount(): number {
		return this.getSelectedLogIndices().length;
	}

	isSelected(logIndex: number): boolean {
		const selected = this.getSelectedLogIndices();
		return selected.includes(logIndex);
	}

	isExpanded(logIndex: number): boolean {
		return this.#expandedLogIndices.has(logIndex);
	}

	expandSelected(): void {
		for (const index of this.getSelectedLogIndices()) {
			this.#expandedLogIndices.add(index);
		}
	}

	collapseSelected(): void {
		for (const index of this.getSelectedLogIndices()) {
			this.#expandedLogIndices.delete(index);
		}
	}

	getSelectedRawLines(): string[] {
		const selectedIndices = this.getSelectedLogIndices();
		return selectedIndices.map(index => this.getRawLine(index));
	}

	selectAllVisible(): void {
		if (this.#selectableRowIndices.length === 0) {
			return;
		}

		let firstLogIndex: number | undefined;
		let lastLogIndex: number | undefined;
		for (let i = 0; i < this.#selectableRowIndices.length; i++) {
			const rowIndex = this.#selectableRowIndices[i];
			const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
			if (row?.kind === "log") {
				if (firstLogIndex === undefined) {
					firstLogIndex = i;
				}
				lastLogIndex = i;
			}
		}

		if (firstLogIndex === undefined || lastLogIndex === undefined) {
			return;
		}

		this.#selectionAnchorSelectableIndex = firstLogIndex;
		this.#cursorSelectableIndex = lastLogIndex;
	}

	canLoadOlder(): boolean {
		return this.#loadedStartIndex > 0 || this.#hasExternalOlderLogs();
	}

	async loadOlder(additionalCount: number = LOAD_OLDER_CHUNK): Promise<boolean> {
		if (this.#loadedStartIndex > 0) {
			return this.#loadOlderInMemory(additionalCount);
		}
		if (!this.#loadOlderLogs || !this.#hasExternalOlderLogs()) {
			return false;
		}
		const olderText = await this.#loadOlderLogs();
		if (olderText.length === 0) {
			if (!this.#hasExternalOlderLogs()) {
				this.#rebuildRows();
			}
			return false;
		}
		const added = this.prependLogs(olderText);
		if (added === 0) {
			if (!this.#hasExternalOlderLogs()) {
				this.#rebuildRows();
			}
			return false;
		}
		return this.#loadOlderInMemory(additionalCount);
	}

	prependLogs(logText: string): number {
		const previousCursor = this.#getCursorToken();
		const previousAnchorLogIndex = this.#getAnchorLogIndex();
		const newEntries = splitLogText(logText).map(rawLine => ({
			rawLine,
			timestampMs: parseDebugLogTimestampMs(rawLine),
			pid: parseDebugLogPid(rawLine),
		}));
		if (newEntries.length === 0) {
			return 0;
		}
		const offset = newEntries.length;
		this.#entries = [...newEntries, ...this.#entries];
		this.#loadedStartIndex += offset;
		this.#expandedLogIndices = new Set([...this.#expandedLogIndices].map(logIndex => logIndex + offset));
		const adjustedCursor: CursorToken | undefined =
			previousCursor?.kind === "log" ? { kind: "log", logIndex: previousCursor.logIndex + offset } : previousCursor;
		const adjustedAnchor = previousAnchorLogIndex === undefined ? undefined : previousAnchorLogIndex + offset;
		this.#rebuildRows(adjustedCursor, adjustedAnchor);
		return offset;
	}

	#loadOlderInMemory(additionalCount: number = LOAD_OLDER_CHUNK): boolean {
		if (this.#loadedStartIndex === 0) {
			return false;
		}
		const requested = Math.max(1, additionalCount);
		const nextStart = Math.max(0, this.#loadedStartIndex - requested);
		if (nextStart === this.#loadedStartIndex) {
			return false;
		}
		this.#loadedStartIndex = nextStart;
		this.#rebuildRows();
		return true;
	}

	#rebuildRows(
		previousCursor: CursorToken | undefined = this.#getCursorToken(),
		previousAnchorLogIndex = this.#getAnchorLogIndex(),
	): void {
		const query = this.#filterQuery.toLowerCase();
		const visible: number[] = [];
		for (let i = this.#loadedStartIndex; i < this.#entries.length; i++) {
			const entry = this.#entries[i];
			if (!entry) {
				continue;
			}
			if (this.#matchesFilters(entry, query)) {
				visible.push(i);
			}
		}
		this.#visibleLogIndices = visible;

		const rows: ViewerRow[] = [];
		if (this.#hasOlderEntries(query)) {
			rows.push({ kind: "load-older" });
		}
		let olderSeen = false;
		let warningInserted = false;
		for (const logIndex of visible) {
			const timestampMs = this.#entries[logIndex]?.timestampMs;
			if (timestampMs !== undefined) {
				if (timestampMs < this.#processStartMs) {
					olderSeen = true;
				} else if (olderSeen && !warningInserted) {
					rows.push({ kind: "warning" });
					warningInserted = true;
				}
			}
			rows.push({ kind: "log", logIndex });
		}
		this.#rows = rows;
		this.#selectableRowIndices = rows
			.map((row, index) => (row.kind === "warning" ? undefined : index))
			.filter((index): index is number => index !== undefined);

		if (this.#selectableRowIndices.length === 0) {
			this.#cursorSelectableIndex = 0;
			this.#selectionAnchorSelectableIndex = undefined;
			return;
		}

		if (previousCursor?.kind === "log") {
			const rowIndex = this.#rows.findIndex(row => row.kind === "log" && row.logIndex === previousCursor.logIndex);
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			if (selectableIndex >= 0) {
				this.#cursorSelectableIndex = selectableIndex;
			} else {
				this.#cursorSelectableIndex = this.#selectableRowIndices.length - 1;
			}
		} else if (previousCursor?.kind === "load-older") {
			const rowIndex = this.#rows.findIndex(row => row.kind === "load-older");
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			this.#cursorSelectableIndex = selectableIndex >= 0 ? selectableIndex : this.#selectableRowIndices.length - 1;
		} else {
			this.#cursorSelectableIndex = this.#selectableRowIndices.length - 1;
		}

		if (previousAnchorLogIndex !== undefined) {
			const rowIndex = this.#rows.findIndex(row => row.kind === "log" && row.logIndex === previousAnchorLogIndex);
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			this.#selectionAnchorSelectableIndex = selectableIndex >= 0 ? selectableIndex : undefined;
		} else {
			this.#selectionAnchorSelectableIndex = undefined;
		}
	}

	#matchesFilters(entry: LogEntry, query: string): boolean {
		if (query.length > 0 && !entry.rawLine.toLowerCase().includes(query)) {
			return false;
		}
		if (!this.#processFilterEnabled) {
			return true;
		}
		return entry.pid === this.#processPid;
	}

	#hasOlderEntries(query: string): boolean {
		if (this.#hasExternalOlderLogs()) {
			return true;
		}
		if (this.#loadedStartIndex === 0) {
			return false;
		}
		for (let i = 0; i < this.#loadedStartIndex; i++) {
			const entry = this.#entries[i];
			if (entry && this.#matchesFilters(entry, query)) {
				return true;
			}
		}
		return false;
	}

	#hasExternalOlderLogs(): boolean {
		return this.#hasOlderLogs?.() ?? false;
	}

	#getCursorRow(): ViewerRow | undefined {
		const rowIndex = this.cursorRowIndex;
		return rowIndex === undefined ? undefined : this.#rows[rowIndex];
	}

	#getCursorToken(): CursorToken | undefined {
		const row = this.#getCursorRow();
		if (!row) {
			return undefined;
		}
		if (row.kind === "log") {
			return { kind: "log", logIndex: row.logIndex };
		}
		if (row.kind === "load-older") {
			return { kind: "load-older" };
		}
		return undefined;
	}

	#getAnchorLogIndex(): number | undefined {
		if (this.#selectionAnchorSelectableIndex === undefined) {
			return undefined;
		}
		const rowIndex = this.#selectableRowIndices[this.#selectionAnchorSelectableIndex];
		const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
		return row?.kind === "log" ? row.logIndex : undefined;
	}
}

interface DebugLogViewerComponentOptions {
	logs: string;
	terminalRows: number;
	onExit: () => void;
	onStatus?: (message: string) => void;
	onError?: (message: string) => void;
	processStartMs?: number;
	processPid?: number;
	deps: LogViewerDeps;
	onUpdate?: () => void;
}

/** Interactive log viewer with host-provided storage and clipboard capabilities. */
export class DebugLogViewerComponent implements Component {
	#model: DebugLogViewerModel;
	#terminalRows: number;
	#onExit: () => void;
	#onStatus?: (message: string) => void;
	#onError?: (message: string) => void;
	#onUpdate?: () => void;
	readonly #deps: LogViewerDeps;
	readonly #frame: DebugViewerFrame;
	#statusMessage: string | undefined;
	#loadingOlder = false;
	#bodyLineToRowIndex: Array<number | undefined> = [];

	constructor(options: DebugLogViewerComponentOptions) {
		this.#deps = options.deps;
		this.#model = new DebugLogViewerModel(options.logs, {
			processStartMs: options.processStartMs,
			processPid: options.processPid,
			hasOlderLogs: this.#deps.hasOlderLogs?.bind(this.#deps),
			loadOlderLogs: this.#deps.loadOlderLogs?.bind(this.#deps),
		});
		this.#terminalRows = options.terminalRows;
		this.#onExit = options.onExit;
		this.#onStatus = options.onStatus;
		this.#onError = options.onError;
		this.#onUpdate = options.onUpdate;
		this.#frame = new DebugViewerFrame({
			title: "Recent Logs",
			getHeight: () => process.stdout.rows || this.#terminalRows || 24,
			headerRows: 2,
			footerRows: 2,
			minimumBodyRows: 3,
			frame: context => this.#buildFrameContent(context),
		});
	}

	handleInput(keyData: string): void {
		if (routeSgrMouseInput(keyData, event => this.#handleMouse(event))) {
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#onExit();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copySelected();
			return;
		}

		if (matchesKey(keyData, "ctrl+p")) {
			this.#statusMessage = undefined;
			this.#model.toggleProcessFilter();
			return;
		}

		if (matchesKey(keyData, "ctrl+a")) {
			this.#statusMessage = undefined;
			this.#model.selectAllVisible();
			return;
		}

		if (matchesKey(keyData, "ctrl+o")) {
			this.#statusMessage = undefined;
			void this.#handleLoadOlder(this.#frame.getBodyHeight() + 1);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			if (this.#model.cursorRowKind === "load-older") {
				this.#statusMessage = undefined;
				void this.#handleLoadOlder();
			}
			return;
		}

		if (matchesKey(keyData, "shift+up")) {
			this.#statusMessage = undefined;
			void this.#handleMoveUp(true);
			return;
		}

		if (matchesKey(keyData, "shift+down")) {
			this.#statusMessage = undefined;
			this.#model.moveCursor(1, true);
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#statusMessage = undefined;
			void this.#handleMoveUp(false);
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#statusMessage = undefined;
			this.#model.moveCursor(1, false);
			return;
		}

		if (matchesKey(keyData, "right")) {
			this.#statusMessage = undefined;
			if (this.#model.cursorRowKind === "load-older") {
				void this.#handleLoadOlder();
				return;
			}
			this.#model.expandSelected();
			return;
		}

		if (matchesKey(keyData, "left")) {
			this.#statusMessage = undefined;
			this.#model.collapseSelected();
			return;
		}

		if (matchesKey(keyData, "backspace")) {
			if (this.#model.filterQuery.length > 0) {
				this.#statusMessage = undefined;
				this.#model.setFilterQuery(this.#model.filterQuery.slice(0, -1));
			}
			return;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText) {
			this.#statusMessage = undefined;
			this.#model.setFilterQuery(this.#model.filterQuery + printableText);
		}
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null && this.#frame.isBodyFrameRow(event.row)) {
			this.#statusMessage = undefined;
			this.#frame.scroll(event.wheel * 3);
			this.#onUpdate?.();
			return true;
		}

		if (!event.leftClick) return false;
		const logicalLine = this.#frame.toBodyRow(event.row);
		if (logicalLine === undefined) return false;
		const rowIndex = this.#bodyLineToRowIndex[logicalLine];
		if (rowIndex === undefined) return false;

		const target = this.#model.rows[rowIndex];
		if (!target || target.kind === "warning") return false;
		this.#statusMessage = undefined;
		this.#model.moveCursorToRow(rowIndex, false);
		if (target.kind === "load-older") {
			void this.#handleLoadOlder();
			return true;
		}

		if (this.#model.isExpanded(target.logIndex)) {
			this.#model.collapseSelected();
		} else {
			this.#model.expandSelected();
		}
		this.#onUpdate?.();
		return true;
	}

	invalidate(): void {
		this.#frame.invalidate();
	}

	dispose(): void {
		this.#frame.dispose();
	}

	render(width: number): readonly string[] {
		return this.#frame.render(Math.max(MIN_LOG_VIEWER_WIDTH, width));
	}

	#buildFrameContent(context: DebugViewerFrameContext): DebugViewerFrameContent {
		const rendered = this.#renderRows(context.contentWidth);
		const lines: string[] = [];
		const mapping: Array<number | undefined> = [];
		const cursorRowIndex = this.#model.cursorRowIndex;
		const cursorTarget = cursorRowIndex === undefined ? undefined : this.#model.rows[cursorRowIndex];
		let anchor: DebugViewerFrameContent["body"]["anchor"];

		if (rendered.length === 0) {
			lines.push(theme.fg("muted", "no matches"));
			mapping.push(undefined);
		} else {
			for (const entry of rendered) {
				const start = lines.length;
				for (const line of entry.lines) {
					lines.push(line);
					mapping.push(entry.rowIndex);
				}
				if (entry.rowIndex === cursorRowIndex && cursorTarget && cursorTarget.kind !== "warning") {
					const id = cursorTarget.kind === "log" ? `log:${cursorTarget.logIndex}` : "load-older";
					anchor = { id, start, end: lines.length, margin: 1 };
				}
			}
		}
		this.#bodyLineToRowIndex = mapping;
		return {
			header: [this.#summaryText(), this.#filterText()],
			body: anchor ? { lines, anchor } : { lines },
			footer: [this.#statusText(), theme.fg("dim", this.#controlsText())],
		};
	}

	#summaryText(): string {
		const selected = this.#model.getSelectedCount();
		const expanded = this.#model.expandedCount;
		return `${theme.fg("muted", "showing")} ${theme.fg("accent", `${this.#model.visibleLogCount}/${this.#model.logCount}`)}  ${theme.fg("muted", "selected")} ${theme.fg(selected > 0 ? "accent" : "muted", String(selected))}  ${theme.fg("muted", "expanded")} ${theme.fg(expanded > 0 ? "accent" : "muted", String(expanded))}`;
	}

	#controlsText(): string {
		return "Esc close · Ctrl+C copy · ↑/↓/wheel move · click toggle · Shift+↑/↓ select · ←/→ collapse/expand · Ctrl+A all · Ctrl+O older · Ctrl+P pid";
	}

	#filterText(): string {
		const sanitized = replaceTabs(sanitizeText(this.#model.filterQuery));
		const query = sanitized.length === 0 ? theme.fg("muted", "type to filter") : theme.fg("accent", sanitized);
		const pidStatus = this.#model.isProcessFilterEnabled()
			? theme.fg("success", "pid on")
			: theme.fg("muted", "pid off");
		const loading = this.#loadingOlder ? `  ${theme.fg("warning", "loading older…")}` : "";
		return `${theme.fg("muted", "filter")} ${query}  ${pidStatus}${loading}`;
	}

	#statusText(): string {
		return this.#statusMessage
			? theme.fg("success", this.#statusMessage)
			: theme.fg("dim", "Enter loads older when highlighted; printable keys update filter");
	}

	async #handleLoadOlder(additionalCount: number = LOAD_OLDER_CHUNK): Promise<void> {
		const loaded = await this.#loadOlder(additionalCount);
		if (loaded) {
			this.#onUpdate?.();
		}
	}

	async #handleMoveUp(extendSelection: boolean): Promise<void> {
		if (this.#model.cursorRowKind === "load-older") {
			const loaded = await this.#loadOlder(LOAD_OLDER_CHUNK);
			if (loaded) {
				this.#onUpdate?.();
				return;
			}
		}

		if (this.#model.canLoadOlder() && this.#model.isCursorAtFirstSelectableRow()) {
			const loaded = await this.#loadOlder(LOAD_OLDER_CHUNK);
			if (loaded) {
				this.#model.moveCursor(-1, extendSelection);
				this.#onUpdate?.();
				return;
			}
		}

		this.#model.moveCursor(-1, extendSelection);
		this.#onUpdate?.();
	}

	async #loadOlder(additionalCount: number): Promise<boolean> {
		if (this.#loadingOlder || !this.#model.canLoadOlder()) {
			return false;
		}
		this.#loadingOlder = true;
		try {
			return await this.#model.loadOlder(additionalCount);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#statusMessage = `Load older failed: ${message}`;
			this.#onError?.(`Failed to load older logs: ${message}`);
			this.#onUpdate?.();
			return false;
		} finally {
			this.#loadingOlder = false;
		}
	}

	#renderRows(innerWidth: number): Array<{ lines: string[]; rowIndex: number }> {
		const rendered: Array<{ lines: string[]; rowIndex: number }> = [];

		for (let rowIndex = 0; rowIndex < this.#model.rows.length; rowIndex++) {
			const row = this.#model.rows[rowIndex];
			if (!row) {
				continue;
			}

			if (row.kind === "warning") {
				rendered.push({
					rowIndex,
					lines: [theme.fg("muted", truncateToWidth(SESSION_BOUNDARY_WARNING, innerWidth))],
				});
				continue;
			}

			if (row.kind === "load-older") {
				const active = this.#model.cursorRowIndex === rowIndex;
				const marker = active ? theme.fg("accent", "❯") : " ";
				const prefix = `${marker}  `;
				const contentWidth = Math.max(1, innerWidth - visibleWidth(prefix));
				const label = truncateToWidth(LOAD_OLDER_LABEL, contentWidth);
				rendered.push({
					rowIndex,
					lines: [truncateToWidth(`${prefix}${theme.fg("muted", label)}`, innerWidth)],
				});
				continue;
			}

			const logIndex = row.logIndex;
			const selected = this.#model.isSelected(logIndex);
			const cursorLogIndex = this.#model.cursorLogIndex;
			const active = cursorLogIndex !== undefined && cursorLogIndex === logIndex;
			const expanded = this.#model.isExpanded(logIndex);
			const marker = active ? theme.fg("accent", "❯") : selected ? theme.fg("accent", "•") : " ";
			const fold = expanded ? theme.fg("accent", "▾") : theme.fg("muted", "▸");
			const prefix = `${marker}${fold} `;
			const contentWidth = Math.max(1, innerWidth - visibleWidth(prefix));

			if (expanded) {
				const wrapped = formatDebugLogExpandedLines(this.#model.getRawLine(logIndex), contentWidth);
				const indent = padding(visibleWidth(prefix));
				const lines = wrapped.map((segment, index) => {
					const content = selected ? theme.bold(segment) : segment;
					return truncateToWidth(`${index === 0 ? prefix : indent}${content}`, innerWidth);
				});
				rendered.push({ rowIndex, lines });
				continue;
			}

			const preview = truncateToWidth(
				sanitizeDisplayText(this.#model.getRawLine(logIndex)),
				Math.max(1, contentWidth),
			);
			const content = selected ? theme.bold(preview) : preview;
			rendered.push({ rowIndex, lines: [truncateToWidth(`${prefix}${content}`, innerWidth)] });
		}

		return rendered;
	}

	#copySelected() {
		const selectedPayload = buildLogCopyPayload(this.#model.getSelectedRawLines());
		const selected = selectedPayload.length === 0 ? [] : selectedPayload.split("\n");

		if (selected.length === 0) {
			const message = "No log entry selected";
			this.#statusMessage = message;
			this.#onStatus?.(message);
			return;
		}

		try {
			this.#deps.copyToClipboard(selectedPayload);
			const message = `Copied ${selected.length} log ${selected.length === 1 ? "entry" : "entries"}`;
			this.#statusMessage = message;
			this.#onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#statusMessage = `Copy failed: ${message}`;
			this.#onError?.(`Failed to copy logs: ${message}`);
		}
	}
}
