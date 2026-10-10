import type { TspPickerGroup, TspPickerItem, TspTone } from "@oh-my-pi/pi-wire";
import { formatKeyHint, formatKeyHints } from "../../app-keybindings";
import type { Component } from "../../tui";
import { code } from "../../native/describe";
import { Memo } from "../../native/memo";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../../native/node";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent, pickerHits, pickerQuery } from "../../native/picker";
import { matchesKey } from "../../keys";
import { Input } from "../../components/input";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { padding, truncateToWidth, visibleWidth } from "../../utils";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { getThemeEpoch, theme } from "../../theme/theme";
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
/**
 * Default for {@link DebugLogViewerModelOptions.maxLogEntries}. Once this many
 * entries are loaded, older history stops loading; the newest entries (the
 * current session) are never evicted.
 */
const MAX_LOG_ENTRIES = 50_000;
const MIN_LOG_VIEWER_WIDTH = 48;
/** Picker item id of the "load older entries" row. */
const OLDER_ITEM = "older";
/** Status-dot tone of a log level. */
const LEVEL_TONES: Readonly<Record<string, TspTone>> = {
	error: "error",
	warn: "warning",
	info: "info",
	debug: "muted",
};

type LogEntry = {
	rawLine: string;
	timestampMs: number | undefined;
	pid: number | undefined;
	/** Lowercased {@link rawLine}, filled on first filter match. */
	lowerLine?: string;
};

type SelectionState = {
	rows: readonly ViewerRow[];
	cursor: number;
	anchor: number | undefined;
	indices: number[];
	set: Set<number>;
};

type CachedLogRow = {
	width: number;
	selected: boolean;
	active: boolean;
	expanded: boolean;
	lines: string[];
};

type CursorToken = { kind: "log"; logIndex: number } | { kind: "load-older" };

type DebugLogViewerModelOptions = {
	processStartMs?: number;
	processPid?: number;
	hasOlderLogs?: () => boolean;
	loadOlderLogs?: (limitDays?: number) => Promise<string>;
	/** Most entries kept; older history beyond it is not loaded. Defaults to {@link MAX_LOG_ENTRIES}. */
	maxLogEntries?: number;
};

/**
 * One log entry as a picker row: the message as the label, the remaining
 * fields as `key=value` detail, the local time and pid as facts and the
 * level as the status dot. Lines that aren't JSON objects show as they are.
 */
function logPickerItem(id: string, rawLine: string): TspPickerItem {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {}
	if (!isRecord(parsed)) {
		return { id, label: sanitizeDisplayText(rawLine).replace(/\s+/g, " "), mono: true };
	}
	const { timestamp, level, pid, message, ...rest } = parsed;
	let detail = "";
	for (const key in rest) {
		const value = rest[key];
		detail += `${detail ? " " : ""}${key}=${typeof value === "string" ? value : JSON.stringify(value)}`;
	}
	const time = typeof timestamp === "string" ? new Date(timestamp) : undefined;
	return {
		id,
		label: sanitizeDisplayText(typeof message === "string" ? message : rawLine).replace(/\s+/g, " "),
		detail: detail ? sanitizeDisplayText(detail).replace(/\s+/g, " ") : undefined,
		dot: typeof level === "string" ? LEVEL_TONES[level] : undefined,
		facts: {
			time: time && Number.isFinite(time.getTime()) ? time.toLocaleTimeString(undefined, { hour12: false }) : "",
			pid: typeof pid === "number" ? String(pid) : "",
		},
	};
}

/** A log line pretty-printed for the preview pane: indented JSON when it parses, else the sanitized line. */
function logPreviewText(rawLine: string): { text: string; lang?: string } {
	try {
		return { text: JSON.stringify(JSON.parse(rawLine), null, 2), lang: "json" };
	} catch {
		return { text: sanitizeDisplayText(rawLine) };
	}
}

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

function parseLogEntries(logText: string): LogEntry[] {
	return logText
		.split("\n")
		.filter(line => line.length > 0)
		.map(rawLine => ({
			rawLine,
			timestampMs: parseDebugLogTimestampMs(rawLine),
			pid: parseDebugLogPid(rawLine),
		}));
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
	/**
	 * Loaded entries, newest first, so loading older history appends instead of
	 * copying the whole array. Log index `i` (0 = oldest) lives at `length - 1 - i`.
	 */
	#entries: LogEntry[];
	readonly #maxLogEntries: number;
	#rows: ViewerRow[];
	#visibleLogIndices: number[];
	#selectableRowIndices: number[];
	#cursorSelectableIndex = 0;
	#selectionAnchorSelectableIndex: number | undefined;
	#selection: SelectionState | undefined;
	#expandedLogIndices = new Set<number>();
	#filterQuery = "";
	#processStartMs: number;
	#loadedStartIndex: number;
	#processFilterEnabled = false;
	#processPid: number;
	#hasOlderLogs?: () => boolean;
	#loadOlderLogs?: (limitDays?: number) => Promise<string>;

	constructor(logText: string, options: DebugLogViewerModelOptions = {}) {
		const {
			processStartMs = getProcessStartMs(),
			processPid = process.pid,
			hasOlderLogs,
			loadOlderLogs,
			maxLogEntries = MAX_LOG_ENTRIES,
		} = options;
		this.#maxLogEntries = Math.max(1, maxLogEntries);
		this.#entries = parseLogEntries(logText).reverse();
		// Newest first: truncating keeps the newest entries and drops the oldest.
		if (this.#entries.length > this.#maxLogEntries) this.#entries.length = this.#maxLogEntries;
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

	/** True once the entry cap is reached, so older history no longer loads. */
	get historyLimitReached(): boolean {
		return this.#entries.length >= this.#maxLogEntries;
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
		return this.#entryAt(logIndex)?.rawLine ?? "";
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
		return this.#selectionState().indices.slice();
	}

	getSelectedCount(): number {
		return this.#selectionState().indices.length;
	}

	isSelected(logIndex: number): boolean {
		return this.#selectionState().set.has(logIndex);
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
		return this.#selectionState().indices.map(index => this.getRawLine(index));
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
		const room = this.#maxLogEntries - this.#entries.length;
		const parsed = room > 0 ? parseLogEntries(logText) : [];
		// Chronological order: past the cap, keep the chunk's newest entries (nearest the loaded history).
		const newEntries = parsed.length > room ? parsed.slice(parsed.length - room) : parsed;
		if (newEntries.length === 0) {
			return 0;
		}
		const offset = newEntries.length;
		for (let i = offset - 1; i >= 0; i--) {
			this.#entries.push(newEntries[i]!);
		}
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
			const entry = this.#entryAt(i);
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
			const timestampMs = this.#entryAt(logIndex)?.timestampMs;
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
		if (query.length > 0 && !(entry.lowerLine ??= entry.rawLine.toLowerCase()).includes(query)) {
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
			const entry = this.#entryAt(i);
			if (entry && this.#matchesFilters(entry, query)) {
				return true;
			}
		}
		return false;
	}

	#hasExternalOlderLogs(): boolean {
		return !this.historyLimitReached && (this.#hasOlderLogs?.() ?? false);
	}

	#entryAt(logIndex: number): LogEntry | undefined {
		return this.#entries[this.#entries.length - 1 - logIndex];
	}

	/** Selected log indices, memoized until the rows, cursor or anchor change. */
	#selectionState(): SelectionState {
		const cached = this.#selection;
		if (
			cached &&
			cached.rows === this.#rows &&
			cached.cursor === this.#cursorSelectableIndex &&
			cached.anchor === this.#selectionAnchorSelectableIndex
		) {
			return cached;
		}
		const indices = this.#computeSelectedLogIndices();
		const state: SelectionState = {
			rows: this.#rows,
			cursor: this.#cursorSelectableIndex,
			anchor: this.#selectionAnchorSelectableIndex,
			indices,
			set: new Set(indices),
		};
		this.#selection = state;
		return state;
	}

	#computeSelectedLogIndices(): number[] {
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
	/** Filter field; its value is pushed into the model whenever it changes. */
	readonly #filter = new Input();
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
	readonly #native = new Memo();
	/** Picker rows by log index, valid for {@link #nativeItemsGeneration} (a prepend shifts indices). */
	#nativeItems = new Map<number, TspPickerItem>();
	#nativeItemsGeneration = 0;
	/** Formatted ANSI log rows by log index, valid for {@link #rowCacheGeneration} and {@link #rowCacheThemeEpoch}. */
	#rowCache = new Map<number, CachedLogRow>();
	#rowCacheGeneration = 0;
	#rowCacheThemeEpoch = -1;

	constructor(options: DebugLogViewerComponentOptions) {
		this.#deps = options.deps;
		this.#model = new DebugLogViewerModel(options.logs, {
			processStartMs: options.processStartMs,
			processPid: options.processPid,
			hasOlderLogs: this.#deps.hasOlderLogs?.bind(this.#deps),
			loadOlderLogs: this.#deps.loadOlderLogs?.bind(this.#deps),
		});
		this.#filter.prompt = "";
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

		// Page and end keys jump the cursor; the frame (or the native list)
		// keeps it in view.
		const jump = matchesKey(keyData, "pageUp")
			? -this.#frame.getBodyHeight()
			: matchesKey(keyData, "pageDown")
				? this.#frame.getBodyHeight()
				: matchesKey(keyData, "home")
					? -this.#model.rows.length
					: matchesKey(keyData, "end")
						? this.#model.rows.length
						: 0;
		if (jump !== 0) {
			this.#statusMessage = undefined;
			this.#model.moveCursor(jump, false);
			this.#onUpdate?.();
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

		// Everything else edits the filter field; refilter only when the text changed.
		const before = this.#filter.getValue();
		this.#filter.handleInput(keyData);
		const after = this.#filter.getValue();
		if (after !== before) {
			this.#statusMessage = undefined;
			this.#model.setFilterQuery(after);
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
		this.#native.clear();
		this.#rowCache.clear();
	}

	dispose(): void {
		this.#frame.dispose();
	}

	/** A `picker` sheet floats over the transcript instead of taking the screen. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	/**
	 * The logs as a picker sheet: the filter as its query, one row per entry
	 * (message, fields, time, pid, level dot) with the session boundary as a
	 * group head, the range selection checked, the entry under the cursor
	 * pretty-printed below, and the keys' actions in the bar. Without the
	 * `picker` kind it falls back to rows.
	 */
	describe(cx: DescribeContext): NativeNode | null {
		if (!cx.supports("picker")) return null;
		const model = this.#model;
		const query = this.#filter.getValue();
		const cursor = this.#filter.getCursor();
		const selected = model.getSelectedLogIndices();
		return this.#native.get(
			[
				model.rows,
				model.cursorRowIndex,
				selected.join(","),
				model.logCount,
				model.historyLimitReached,
				model.isProcessFilterEnabled(),
				model.canLoadOlder(),
				query,
				cursor,
				this.#loadingOlder,
				this.#statusMessage,
			],
			() => {
				// Entries only grow, and every prepend shifts log indices, so the count keys the item cache.
				const generation = model.logCount;
				if (this.#nativeItemsGeneration !== generation) {
					this.#nativeItems = new Map();
					this.#nativeItemsGeneration = generation;
				}
				const items: TspPickerItem[] = [];
				const order: (string | TspPickerGroup)[] = [];
				const hits: Record<string, [number, number][]> = {};
				const needle = query.toLowerCase();
				for (const viewerRow of model.rows) {
					if (viewerRow.kind === "warning") {
						order.push({ group: "session", label: "This session" });
						continue;
					}
					if (viewerRow.kind === "load-older") {
						items.push({ id: OLDER_ITEM, label: "Load older entries", tone: "muted" });
						order.push(OLDER_ITEM);
						continue;
					}
					let item = this.#nativeItems.get(viewerRow.logIndex);
					if (!item) {
						item = logPickerItem(`l${viewerRow.logIndex}`, model.getRawLine(viewerRow.logIndex));
						this.#nativeItems.set(viewerRow.logIndex, item);
					}
					items.push(item);
					order.push(item.id);
					if (needle && typeof item.label === "string") {
						const found = pickerHits(item.label, [needle]);
						if (found.length > 0) hits[item.id] = found;
					}
				}
				const cursorLog = model.cursorLogIndex;
				const preview = cursorLog === undefined ? undefined : logPreviewText(model.getRawLine(cursorLog));
				const subtitle = [
					`${model.visibleLogCount}/${model.logCount} entries`,
					selected.length > 1 ? `${selected.length} selected` : undefined,
					model.historyLimitReached ? "history limit reached" : undefined,
					this.#loadingOlder ? "loading older…" : undefined,
				]
					.filter(part => part !== undefined)
					.join(" · ");
				return picker(
					{
						title: "Recent logs",
						subtitle,
						noun: "entries",
						size: "lg",
						layout: "rows",
						preview: preview ? "below" : "none",
						...pickerQuery(this.#filter),
						placeholder: "Filter logs…",
						columns: [
							{ id: "pid", format: "dim", priority: 0 },
							{ id: "time", format: "dim", priority: 1 },
						],
						items,
						order,
						hits,
						selected:
							model.cursorRowKind === "load-older"
								? OLDER_ITEM
								: cursorLog === undefined
									? null
									: `l${cursorLog}`,
						current: selected.length > 1 ? selected.map(index => `l${index}`) : [],
						total: model.logCount,
						empty: query ? "No matching log entries" : "No log entries",
						message: this.#statusMessage,
						actions: [
							pickerAction("copy", "Copy", "ctrl+c", { primary: true }),
							pickerAction("all", "Select all", "ctrl+a"),
							pickerAction("pid", "This process", "ctrl+p", { on: model.isProcessFilterEnabled() }),
							pickerAction("older", "Load older", "ctrl+o", {
								disabled: model.canLoadOlder()
									? undefined
									: model.historyLimitReached
										? "Log history limit reached"
										: "No older log entries",
							}),
							CLOSE_ACTION,
						],
					},
					preview && cursorLog !== undefined
						? [{ ...code(preview.text, { lang: preview.lang, wrap: true }), key: `entry:${cursorLog}` }]
						: undefined,
				);
			},
		);
	}

	/**
	 * Pointer actions run the keys' code: a row click moves the cursor there,
	 * a second click copies it (or loads older entries from that row), and the
	 * bar's buttons mirror their keys.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event);
		if (!ev) return;
		this.#statusMessage = undefined;
		if (ev.kind === "action") {
			switch (ev.act) {
				case "copy":
					this.#copySelected();
					return;
				case "all":
					this.#model.selectAllVisible();
					return;
				case "pid":
					this.#model.toggleProcessFilter();
					return;
				case "older":
					void this.#handleLoadOlder(this.#frame.getBodyHeight() + 1);
					return;
				case "close":
					this.#onExit();
					return;
			}
			return;
		}
		const rowIndex = this.#model.rows.findIndex(viewerRow =>
			ev.item === OLDER_ITEM
				? viewerRow.kind === "load-older"
				: viewerRow.kind === "log" && `l${viewerRow.logIndex}` === ev.item,
		);
		if (rowIndex < 0 || !this.#model.moveCursorToRow(rowIndex, false)) return;
		if (ev.kind !== "activate") return;
		if (ev.item === OLDER_ITEM) void this.#handleLoadOlder();
		else this.#copySelected();
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
		const limitText = this.#model.historyLimitReached ? `  ${theme.fg("warning", "history limit reached")}` : "";
		return `${theme.fg("muted", "showing")} ${theme.fg("accent", `${this.#model.visibleLogCount}/${this.#model.logCount}`)}  ${theme.fg("muted", "selected")} ${theme.fg(selected > 0 ? "accent" : "muted", String(selected))}  ${theme.fg("muted", "expanded")} ${theme.fg(expanded > 0 ? "accent" : "muted", String(expanded))}${limitText}`;
	}

	#controlsText(): string {
		return `${formatKeyHint("escape")} close · ${formatKeyHint("ctrl+c")} copy · ${formatKeyHints(["up", "down"])}/wheel move · ${formatKeyHints(["pageUp", "pageDown"])} page · ${formatKeyHints(["home", "end"])} first/last · click toggle · ${formatKeyHints(["shift+up", "shift+down"])} select · ${formatKeyHints(["left", "right"])} collapse/expand · ${formatKeyHint("ctrl+a")} all · ${formatKeyHint("ctrl+o")} older · ${formatKeyHint("ctrl+p")} pid`;
	}

	#filterText(): string {
		const value = this.#filter.getValue();
		const [field = ""] = this.#filter.render(visibleWidth(value) + 1);
		const query = value.length === 0 ? field + theme.fg("muted", "type to filter") : theme.fg("accent", field);
		const pidStatus = this.#model.isProcessFilterEnabled()
			? theme.fg("success", "pid on")
			: theme.fg("muted", "pid off");
		const loading = this.#loadingOlder ? `  ${theme.fg("warning", "loading older…")}` : "";
		return `${theme.fg("muted", "filter")} ${query}  ${pidStatus}${loading}`;
	}

	#statusText(): string {
		return this.#statusMessage
			? theme.fg("success", this.#statusMessage)
			: theme.fg("dim", `${formatKeyHint("enter")} loads older when highlighted; printable keys update filter`);
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
		const model = this.#model;
		const rendered: Array<{ lines: string[]; rowIndex: number }> = [];
		// Entries only grow, and every prepend shifts log indices, so the count keys the row cache.
		const generation = model.logCount;
		const themeEpoch = getThemeEpoch();
		if (this.#rowCacheGeneration !== generation || this.#rowCacheThemeEpoch !== themeEpoch) {
			this.#rowCache.clear();
			this.#rowCacheGeneration = generation;
			this.#rowCacheThemeEpoch = themeEpoch;
		}
		const cursorRowIndex = model.cursorRowIndex;
		const cursorLogIndex = model.cursorLogIndex;

		for (let rowIndex = 0; rowIndex < model.rows.length; rowIndex++) {
			const row = model.rows[rowIndex];
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
				const active = cursorRowIndex === rowIndex;
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
			const selected = model.isSelected(logIndex);
			const active = cursorLogIndex !== undefined && cursorLogIndex === logIndex;
			const expanded = model.isExpanded(logIndex);
			const cached = this.#rowCache.get(logIndex);
			if (
				cached &&
				cached.width === innerWidth &&
				cached.selected === selected &&
				cached.active === active &&
				cached.expanded === expanded
			) {
				rendered.push({ rowIndex, lines: cached.lines });
				continue;
			}

			const marker = active ? theme.fg("accent", "❯") : selected ? theme.fg("accent", "•") : " ";
			const fold = expanded ? theme.fg("accent", "▾") : theme.fg("muted", "▸");
			const prefix = `${marker}${fold} `;
			const contentWidth = Math.max(1, innerWidth - visibleWidth(prefix));
			let lines: string[];
			if (expanded) {
				const wrapped = formatDebugLogExpandedLines(model.getRawLine(logIndex), contentWidth);
				const indent = padding(visibleWidth(prefix));
				lines = wrapped.map((segment, index) => {
					const content = selected ? theme.bold(segment) : segment;
					return truncateToWidth(`${index === 0 ? prefix : indent}${content}`, innerWidth);
				});
			} else {
				const preview = truncateToWidth(sanitizeDisplayText(model.getRawLine(logIndex)), contentWidth);
				const content = selected ? theme.bold(preview) : preview;
				lines = [truncateToWidth(`${prefix}${content}`, innerWidth)];
			}
			this.#rowCache.set(logIndex, { width: innerWidth, selected, active, expanded, lines });
			rendered.push({ rowIndex, lines });
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
