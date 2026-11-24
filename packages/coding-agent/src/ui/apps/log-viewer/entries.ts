/**
 * The log viewer's data: loaded entries (with older history loaded on
 * demand), the filter (text and "this process only"), the rows it leaves
 * (a load-older row, the session boundary, one row per entry), the cursor,
 * the range selection and which entries are expanded.
 *
 * Log index 0 is the oldest loaded entry; loading older history shifts every
 * index by the number of entries it adds.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Entries the viewer shows at first, and per load-older step, before reading older history. */
export const LOG_CHUNK = 50;
/** Most entries kept; past it older history no longer loads (the newest entries are never dropped). */
const MAX_LOG_ENTRIES = 50_000;

interface LogEntry {
	readonly rawLine: string;
	readonly timestampMs: number | undefined;
	readonly pid: number | undefined;
	lower?: string;
}

/** One row of the list. */
export type LogRow =
	| { readonly kind: "warning" }
	| { readonly kind: "load-older" }
	| { readonly kind: "log"; readonly logIndex: number };

type CursorToken = { kind: "log"; logIndex: number } | { kind: "load-older" } | undefined;

export interface LogEntriesOptions {
	/** Entries stamped before this are from earlier sessions. */
	readonly processStartMs: number;
	/** The pid the process filter keeps. */
	readonly processPid: number;
	hasOlderLogs?(): boolean;
	/** Older history (newline-separated lines, oldest first). */
	loadOlderLogs?(): Promise<string>;
	readonly maxLogEntries?: number;
}

function parseLine(rawLine: string): LogEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {}
	let timestampMs: number | undefined;
	let pid: number | undefined;
	if (parsed && typeof parsed === "object") {
		const fields = parsed as { timestamp?: unknown; pid?: unknown };
		if (typeof fields.timestamp === "string") {
			const ms = Date.parse(fields.timestamp);
			if (Number.isFinite(ms)) timestampMs = ms;
		}
		if (typeof fields.pid === "number" && Number.isFinite(fields.pid)) pid = fields.pid;
	}
	return { rawLine, timestampMs, pid };
}

/** Nonempty lines of log text, parsed. */
function parseLines(text: string): LogEntry[] {
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map(parseLine);
}

/** Clipboard text of raw log lines: sanitized, empty ones dropped. */
export function logCopyPayload(lines: readonly string[]): string {
	return lines
		.map(line => sanitizeText(line))
		.filter(line => line.length > 0)
		.join("\n");
}

export class LogEntries {
	/** Newest first, so loading older history appends; log index `i` lives at `length - 1 - i`. */
	#entries: LogEntry[];
	readonly #options: LogEntriesOptions;
	readonly #max: number;
	/** First loaded log index shown (earlier ones are loaded but not shown yet). */
	#start: number;
	#rows: LogRow[] = [];
	#visible: number[] = [];
	/** Row indices the cursor can stop on (everything but the session boundary). */
	#stops: number[] = [];
	#cursor = 0;
	#anchor: number | undefined;
	#expanded = new Set<number>();
	#query = "";
	#processOnly = false;

	constructor(text: string, options: LogEntriesOptions) {
		this.#options = options;
		this.#max = Math.max(1, options.maxLogEntries ?? MAX_LOG_ENTRIES);
		this.#entries = parseLines(text).reverse();
		if (this.#entries.length > this.#max) this.#entries.length = this.#max;
		this.#start = Math.max(0, this.#entries.length - LOG_CHUNK);
		this.#rebuild();
	}

	get count(): number {
		return this.#entries.length;
	}

	get visibleCount(): number {
		return this.#visible.length;
	}

	get historyLimitReached(): boolean {
		return this.#entries.length >= this.#max;
	}

	get rows(): readonly LogRow[] {
		return this.#rows;
	}

	get query(): string {
		return this.#query;
	}

	get processOnly(): boolean {
		return this.#processOnly;
	}

	get expandedCount(): number {
		return this.#expanded.size;
	}

	get cursorRowIndex(): number | undefined {
		return this.#stops[this.#cursor];
	}

	get cursorRow(): LogRow | undefined {
		const index = this.cursorRowIndex;
		return index === undefined ? undefined : this.#rows[index];
	}

	get cursorLogIndex(): number | undefined {
		const row = this.cursorRow;
		return row?.kind === "log" ? row.logIndex : undefined;
	}

	get atFirstStop(): boolean {
		return this.#cursor === 0;
	}

	rawLine(logIndex: number): string {
		return this.#entryAt(logIndex)?.rawLine ?? "";
	}

	isExpanded(logIndex: number): boolean {
		return this.#expanded.has(logIndex);
	}

	setQuery(query: string): void {
		if (query === this.#query) return;
		this.#query = query;
		this.#rebuild();
	}

	toggleProcessOnly(): void {
		this.#processOnly = !this.#processOnly;
		this.#rebuild();
	}

	/** Move the cursor by `delta` stops; `extend` grows the range selection from where it started. */
	move(delta: number, extend: boolean): void {
		if (this.#stops.length === 0) return;
		this.#moveTo(Math.max(0, Math.min(this.#stops.length - 1, this.#cursor + delta)), extend);
	}

	/** Move the cursor onto row `rowIndex`; false when the row is not a stop. */
	moveToRow(rowIndex: number, extend: boolean): boolean {
		const stop = this.#stops.indexOf(rowIndex);
		if (stop < 0) return false;
		this.#moveTo(stop, extend);
		return true;
	}

	#moveTo(stop: number, extend: boolean): void {
		if (extend && this.#anchor === undefined && this.cursorRow?.kind === "log") this.#anchor = this.#cursor;
		this.#cursor = stop;
		if (!extend) this.#anchor = undefined;
	}

	/** Selected log indices: the range from the anchor to the cursor, else the entry under the cursor. */
	selected(): number[] {
		if (this.#anchor === undefined) {
			const index = this.cursorLogIndex;
			return index === undefined ? [] : [index];
		}
		const out: number[] = [];
		const low = Math.min(this.#anchor, this.#cursor);
		const high = Math.max(this.#anchor, this.#cursor);
		for (let stop = low; stop <= high; stop++) {
			const row = this.#rows[this.#stops[stop]!];
			if (row?.kind === "log") out.push(row.logIndex);
		}
		return out;
	}

	expandSelected(): void {
		for (const index of this.selected()) this.#expanded.add(index);
	}

	collapseSelected(): void {
		for (const index of this.selected()) this.#expanded.delete(index);
	}

	/** Select every shown entry. */
	selectAll(): void {
		let first: number | undefined;
		let last: number | undefined;
		this.#stops.forEach((rowIndex, stop) => {
			if (this.#rows[rowIndex]?.kind !== "log") return;
			first ??= stop;
			last = stop;
		});
		if (first === undefined || last === undefined) return;
		this.#anchor = first;
		this.#cursor = last;
	}

	canLoadOlder(): boolean {
		return this.#start > 0 || this.#hasExternalOlder();
	}

	/** Show up to `count` more older entries, reading older history when everything loaded is shown. */
	async loadOlder(count = LOG_CHUNK): Promise<boolean> {
		if (this.#start > 0) return this.#reveal(count);
		if (!this.#options.loadOlderLogs || !this.#hasExternalOlder()) return false;
		const text = await this.#options.loadOlderLogs();
		const added = text.length === 0 ? 0 : this.#prepend(text);
		if (added === 0) {
			if (!this.#hasExternalOlder()) this.#rebuild();
			return false;
		}
		return this.#reveal(count);
	}

	#prepend(text: string): number {
		const cursor = this.#cursorToken();
		const anchor = this.#anchorLogIndex();
		const room = this.#max - this.#entries.length;
		const parsed = room > 0 ? parseLines(text) : [];
		const added = parsed.length > room ? parsed.slice(parsed.length - room) : parsed;
		if (added.length === 0) return 0;
		const offset = added.length;
		for (let i = offset - 1; i >= 0; i--) this.#entries.push(added[i]!);
		this.#start += offset;
		this.#expanded = new Set([...this.#expanded].map(index => index + offset));
		this.#rebuild(
			cursor?.kind === "log" ? { kind: "log", logIndex: cursor.logIndex + offset } : cursor,
			anchor === undefined ? undefined : anchor + offset,
		);
		return offset;
	}

	#reveal(count: number): boolean {
		if (this.#start === 0) return false;
		const next = Math.max(0, this.#start - Math.max(1, count));
		if (next === this.#start) return false;
		this.#start = next;
		this.#rebuild();
		return true;
	}

	#rebuild(cursor: CursorToken = this.#cursorToken(), anchor = this.#anchorLogIndex()): void {
		const query = this.#query.toLowerCase();
		const visible: number[] = [];
		for (let i = this.#start; i < this.#entries.length; i++) {
			if (this.#matches(this.#entryAt(i)!, query)) visible.push(i);
		}
		this.#visible = visible;
		const rows: LogRow[] = [];
		if (this.#hasOlder(query)) rows.push({ kind: "load-older" });
		let olderSeen = false;
		let boundary = false;
		for (const logIndex of visible) {
			const at = this.#entryAt(logIndex)!.timestampMs;
			if (at !== undefined) {
				if (at < this.#options.processStartMs) olderSeen = true;
				else if (olderSeen && !boundary) {
					rows.push({ kind: "warning" });
					boundary = true;
				}
			}
			rows.push({ kind: "log", logIndex });
		}
		this.#rows = rows;
		this.#stops = rows.flatMap((row, index) => (row.kind === "warning" ? [] : [index]));
		if (this.#stops.length === 0) {
			this.#cursor = 0;
			this.#anchor = undefined;
			return;
		}
		const last = this.#stops.length - 1;
		const stopOf = (rowIndex: number): number => {
			const stop = this.#stops.indexOf(rowIndex);
			return stop >= 0 ? stop : last;
		};
		if (cursor?.kind === "log") {
			this.#cursor = stopOf(rows.findIndex(row => row.kind === "log" && row.logIndex === cursor.logIndex));
		} else if (cursor?.kind === "load-older") {
			this.#cursor = stopOf(rows.findIndex(row => row.kind === "load-older"));
		} else {
			this.#cursor = last;
		}
		if (anchor === undefined) this.#anchor = undefined;
		else {
			const stop = this.#stops.indexOf(rows.findIndex(row => row.kind === "log" && row.logIndex === anchor));
			this.#anchor = stop >= 0 ? stop : undefined;
		}
	}

	#matches(entry: LogEntry, query: string): boolean {
		if (query.length > 0 && !(entry.lower ??= entry.rawLine.toLowerCase()).includes(query)) return false;
		return !this.#processOnly || entry.pid === this.#options.processPid;
	}

	#hasOlder(query: string): boolean {
		if (this.#hasExternalOlder()) return true;
		for (let i = 0; i < this.#start; i++) if (this.#matches(this.#entryAt(i)!, query)) return true;
		return false;
	}

	#hasExternalOlder(): boolean {
		return !this.historyLimitReached && (this.#options.hasOlderLogs?.() ?? false);
	}

	#entryAt(logIndex: number): LogEntry | undefined {
		return this.#entries[this.#entries.length - 1 - logIndex];
	}

	#cursorToken(): CursorToken {
		const row = this.cursorRow;
		if (row?.kind === "log") return { kind: "log", logIndex: row.logIndex };
		return row?.kind === "load-older" ? { kind: "load-older" } : undefined;
	}

	#anchorLogIndex(): number | undefined {
		if (this.#anchor === undefined) return undefined;
		const row = this.#rows[this.#stops[this.#anchor]!];
		return row?.kind === "log" ? row.logIndex : undefined;
	}
}
