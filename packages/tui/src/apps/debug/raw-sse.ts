import type { TspScrollBy } from "@oh-my-pi/pi-wire";
import { formatKeyHint } from "../../app-keybindings";
import type { Component } from "../../tui";
import { matchesKey } from "../../keys";
import { col, compact, keyed, node, row, span, text } from "../../native/describe";
import { Memo } from "../../native/memo";
import type { NativeNode, NativeScreen, NativeScroll, NativeUiEvent } from "../../native/node";
import { actionBar, actionButton } from "../../native/overlay";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { truncateToWidth } from "../../utils";
import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { getThemeEpoch, theme } from "../../theme/theme";
import { DebugViewerFrame } from "./viewer-frame";
import {
	formatRawSseIsoTime,
	type RawSseDebugBuffer,
	type RawSseDebugRecord,
	type RawSseDebugSnapshot,
	rawSseRecordLines,
} from "./raw-sse-buffer";

const MIN_VIEWER_WIDTH = 40;
// `data:` lines below this width render fine on a single row; anything wider gets pretty-printed
// across multiple `data:` lines so streamed JSON blobs stop getting clipped by `truncateToWidth`.
const PRETTY_PRINT_DATA_THRESHOLD = 100;
// The native body is fed append-only (a `text append` op per new record);
// past this many characters it starts over from the live window.
const NATIVE_STREAM_CHAR_CAP = 2_000_000;

// Walks the SSE wire lines and replaces single-line `data: <json>` payloads with
// multi-line `data: <indented-json>` entries when the JSON is wide enough to clip.
// Multi-line `data:` is still valid SSE (the spec joins lines with `\n`), so the
// transformed view round-trips back to the same event when copied.
/** @internal Exported for tests. */
export function expandPrettyDataLines(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of raw) {
		if (!line.startsWith("data: ") || line.length <= PRETTY_PRINT_DATA_THRESHOLD) {
			out.push(line);
			continue;
		}
		const body = line.slice("data: ".length);
		const trimmed = body.trim();
		if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
			out.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			out.push(line);
			continue;
		}
		const pretty = JSON.stringify(parsed, null, 2);
		for (const prettyLine of pretty.split("\n")) {
			out.push(`data: ${prettyLine}`);
		}
	}
	return out;
}

/** Host clipboard capability for the raw event viewer. */
export interface RawSseViewerDeps {
	copyToClipboard(text: string): void;
}

/** Raw event viewer content, callbacks, and host capabilities. */
export interface RawSseViewerOptions {
	deps: RawSseViewerDeps;
	buffer: RawSseDebugBuffer;
	terminalRows: number;
	onExit: () => void;
	onStatus?: (message: string) => void;
	onUpdate?: () => void;
}

/** Scrollable live view of captured provider events. */
export class RawSseViewerComponent implements Component {
	readonly #deps: RawSseViewerDeps;
	readonly #buffer: RawSseDebugBuffer;
	readonly #terminalRows: number;
	readonly #onExit: () => void;
	readonly #onStatus?: (message: string) => void;
	readonly #onUpdate?: () => void;
	readonly #unsubscribe: () => void;
	readonly #frame: DebugViewerFrame;
	#statusMessage: string | undefined;
	#statusFailed = false;
	#disposed = false;
	readonly #native = new Memo();
	readonly #nativeHead = new Memo();
	readonly #nativeBody = new Memo();
	/** The last scroll key, forwarded to the stream block (see {@link NativeNode.scroll}). */
	#nativeScroll: NativeScroll | undefined;
	/** What the native `ansi` body was fed: every record after a rebase, in order, through {@link #nativeLast}. */
	#nativeText = "";
	/** Sequence of the last record in {@link #nativeText}. */
	#nativeLast = 0;
	/** Buffer counters at the last feed; a drop means the buffer was cleared. */
	#nativeEvents = 0;
	#nativeDropped = 0;
	// Pretty-printed wire lines keyed by `record.sequence`. Pretty-printing is
	// the JSON.parse + JSON.stringify per `data:` line, so we cache the result —
	// the render path runs on every keypress and scroll update.
	// Sequences are monotonic; we prune entries below the oldest live record
	// after each render so the cache tracks the buffer's eviction window.
	readonly #prettyLinesCache = new Map<number, string[]>();
	/** Buffer snapshot for {@link #snapshotRevision}; the buffer's revision bumps on every change. */
	#snapshot: RawSseDebugSnapshot | undefined;
	#snapshotRevision = -1;
	/** Rendered body for (buffer revision, width, theme epoch). */
	#bodyLines: string[] = [];
	#bodyRevision = -1;
	#bodyWidth = -1;
	#bodyThemeEpoch = -1;

	constructor(options: RawSseViewerOptions) {
		this.#deps = options.deps;
		this.#buffer = options.buffer;
		this.#terminalRows = options.terminalRows;
		this.#onExit = options.onExit;
		this.#onStatus = options.onStatus;
		this.#onUpdate = options.onUpdate;
		this.#unsubscribe = this.#buffer.subscribe(() => {
			this.#onUpdate?.();
		});
		this.#frame = new DebugViewerFrame({
			title: "Raw Provider Stream",
			getHeight: () => process.stdout.rows || this.#terminalRows || 24,
			headerRows: 1,
			footerRows: 1,
			minimumBodyRows: 3,
			followTail: true,
			frame: context => ({
				header: [this.#summaryText()],
				body: { lines: this.#renderRawLines(context.contentWidth) },
				footer: [this.#statusText()],
			}),
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#frame.dispose();
	}

	handleInput(keyData: string): void {
		if (routeSgrMouseInput(keyData, event => this.#handleMouse(event))) {
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#close();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copyAll();
			return;
		}

		const by: TspScrollBy | undefined = matchesKey(keyData, "up")
			? "line-up"
			: matchesKey(keyData, "down")
				? "line-down"
				: matchesKey(keyData, "pageUp")
					? "page-up"
					: matchesKey(keyData, "pageDown")
						? "page-down"
						: matchesKey(keyData, "home")
							? "start"
							: matchesKey(keyData, "end")
								? "end"
								: undefined;
		if (by) this.#scroll(by);
	}

	/**
	 * Scroll keys move the row frame and, natively, ask the terminal to move
	 * the stream block the same way (`end` follows the tail again).
	 */
	#scroll(by: TspScrollBy): void {
		const page = this.#frame.getBodyHeight();
		switch (by) {
			case "line-up":
				this.#frame.scroll(-1);
				break;
			case "line-down":
				this.#frame.scroll(1);
				break;
			case "page-up":
				this.#frame.scroll(-page);
				break;
			case "page-down":
				this.#frame.scroll(page);
				break;
			case "start":
				this.#frame.setScrollOffset(0);
				break;
			case "end":
				this.#frame.setFollowTail(true);
				break;
		}
		this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
		this.#onUpdate?.();
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null && this.#frame.isBodyFrameRow(event.row)) {
			this.#frame.scroll(event.wheel * 3);
			this.#onUpdate?.();
			return true;
		}

		if (!event.leftClick) return false;
		if (this.#frame.toHeaderRow(event.row) === 0) {
			this.#frame.setFollowTail(!this.#frame.isFollowingTail());
			this.#onUpdate?.();
			return true;
		}
		const logicalRow = this.#frame.toBodyRow(event.row);
		if (logicalRow !== undefined) {
			this.#frame.setScrollOffset(logicalRow);
			this.#onUpdate?.();
			return true;
		}
		return false;
	}

	invalidate(): void {
		this.#frame.invalidate();
		this.#native.clear();
		this.#nativeHead.clear();
		this.#nativeBody.clear();
		this.#bodyRevision = -1;
	}

	render(width: number): readonly string[] {
		return this.#frame.render(Math.max(MIN_VIEWER_WIDTH, width));
	}

	/** The action bar's buttons run the same code as their keys. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "copy") this.#copyAll();
		else if (event.act === "close") this.#close();
	}

	/**
	 * The stream as a page of its own: the capture counters over the wire
	 * text, one `ansi` block that fills the page, scrolls itself and follows
	 * its tail until the user scrolls away (Tern-local, so no follow state
	 * here; the scroll keys reach it as `scroll` requests). The copy status
	 * and the buttons are this component's own node, docked under the page
	 * so they never scroll away.
	 */
	describeScreen(): NativeScreen {
		const snapshot = this.#currentSnapshot();
		const stream = this.#feedNative(snapshot);
		const head = this.#nativeHead.get(
			[snapshot.totalEvents, snapshot.records.length, snapshot.droppedRecords, snapshot.lastUpdatedAt],
			() => this.#describeHead(snapshot),
		);
		const body = this.#nativeBody.get([stream, this.#nativeScroll], () =>
			stream.length > 0
				? {
						...node(
							"ansi",
							{ text: stream, follow: true, role: "omp.debug.stream", max: { h: 1 } },
							undefined,
							"stream",
						),
						scroll: this.#nativeScroll,
					}
				: keyed(
						col(
							[
								text("No raw SSE frames captured yet", { role: "omp.app.empty-title" }),
								text([
									span("HTTP SSE providers populate this view while a model response is streaming.", "muted"),
								]),
							],
							{ gap: "xs", align: "center", role: "omp.app.empty" },
						),
						"empty",
					),
		);
		return { role: "omp.debug", main: [head, body], dock: [this] };
	}

	/** The docked bar under the stream page: the copy status and the buttons. */
	describe(): NativeNode {
		return this.#native.get([this.#statusMessage, this.#statusFailed], () =>
			col(
				compact([
					this.#statusMessage !== undefined &&
						keyed(
							text([span(this.#statusMessage, this.#statusFailed ? "error" : "success")], {
								wrap: "word",
								role: "omp.app.status",
							}),
							"status",
						),
					actionBar([
						actionButton("Copy raw", "copy", { keys: "ctrl+c", tone: "accent" }),
						null,
						actionButton("Close", "close", { keys: "escape" }),
					]),
				]),
				{ role: "omp.debug.bar", gap: "sm" },
			),
		);
	}

	#describeHead(snapshot: RawSseDebugSnapshot): NativeNode {
		const stats = [
			span(`${snapshot.totalEvents} events`, "num"),
			span(" · ", "dim"),
			span(`${snapshot.records.length} records`, "num"),
		];
		if (snapshot.droppedRecords > 0) {
			stats.push(span(" · ", "dim"), span(`${snapshot.droppedRecords} dropped`, "warning"));
		}
		stats.push(
			span(" · ", "dim"),
			snapshot.lastUpdatedAt
				? span(`last ${formatRawSseIsoTime(snapshot.lastUpdatedAt)}`, "muted")
				: span("waiting for first frame", "muted"),
		);
		return keyed(
			row([text("Raw provider stream", { role: "omp.app.title" }), text(stats, { truncate: "end" })], {
				gap: "sm",
				align: "center",
				role: "omp.app.head",
			}),
			"head",
		);
	}

	/**
	 * Brings {@link #nativeText} up to the live window: appends the records
	 * after {@link #nativeLast}, so evictions never rewrite what the terminal
	 * already holds. Starts over once the text outgrows its cap or the buffer
	 * was cleared.
	 */
	#feedNative(snapshot: RawSseDebugSnapshot): string {
		const records = snapshot.records;
		const last = records.at(-1)?.sequence ?? 0;
		if (
			this.#nativeText.length > NATIVE_STREAM_CHAR_CAP ||
			last < this.#nativeLast ||
			snapshot.totalEvents < this.#nativeEvents ||
			snapshot.droppedRecords < this.#nativeDropped
		) {
			this.#nativeText = "";
			this.#nativeLast = 0;
		}
		this.#nativeEvents = snapshot.totalEvents;
		this.#nativeDropped = snapshot.droppedRecords;
		if (last === this.#nativeLast) return this.#nativeText;
		let fed = this.#nativeText;
		for (const record of records) {
			if (record.sequence <= this.#nativeLast) continue;
			for (const line of this.#prettyLinesFor(record)) fed += `${sanitizeDisplayText(line)}\n`;
			if (record.kind === "event" && record.truncated) {
				fed += `${theme.fg("warning", `: omp-debug-event-truncated originalChars=${record.originalChars}`)}\n`;
			}
			fed += "\n";
		}
		this.#nativeText = fed;
		this.#nativeLast = last;
		this.#pruneCache(records[0]!.sequence);
		return fed;
	}

	#close(): void {
		this.dispose();
		this.#onExit();
	}

	/** The buffer's snapshot, re-taken only when its revision moved. */
	#currentSnapshot(): RawSseDebugSnapshot {
		const revision = this.#buffer.revision;
		if (!this.#snapshot || this.#snapshotRevision !== revision) {
			this.#snapshot = this.#buffer.snapshot();
			this.#snapshotRevision = revision;
		}
		return this.#snapshot;
	}

	#renderRawLines(innerWidth: number): string[] {
		const snapshot = this.#currentSnapshot();
		const themeEpoch = getThemeEpoch();
		if (
			this.#bodyRevision === this.#snapshotRevision &&
			this.#bodyWidth === innerWidth &&
			this.#bodyThemeEpoch === themeEpoch
		) {
			return this.#bodyLines;
		}
		this.#bodyRevision = this.#snapshotRevision;
		this.#bodyWidth = innerWidth;
		this.#bodyThemeEpoch = themeEpoch;
		this.#bodyLines = this.#formatRawLines(snapshot, innerWidth);
		return this.#bodyLines;
	}

	#formatRawLines(snapshot: RawSseDebugSnapshot, innerWidth: number): string[] {
		if (snapshot.records.length === 0) {
			return [
				theme.fg("muted", "No raw SSE frames captured yet."),
				theme.fg("muted", "HTTP SSE providers populate this view while a model response is streaming."),
			];
		}
		const lines: string[] = [];
		if (snapshot.droppedRecords > 0) {
			lines.push(
				theme.fg(
					"warning",
					`: omp-debug-dropped records=${snapshot.droppedRecords} chars=${snapshot.droppedChars}`,
				),
			);
			lines.push("");
		}
		const firstSequence = snapshot.records[0]?.sequence;
		for (const record of snapshot.records) {
			for (const line of this.#prettyLinesFor(record)) {
				lines.push(truncateToWidth(sanitizeDisplayText(line), innerWidth));
			}
			if (record.kind === "event" && record.truncated) {
				lines.push(theme.fg("warning", `: omp-debug-event-truncated originalChars=${record.originalChars}`));
			}
			lines.push("");
		}
		if (firstSequence !== undefined) this.#pruneCache(firstSequence);
		return lines;
	}

	#prettyLinesFor(record: RawSseDebugRecord): string[] {
		const cached = this.#prettyLinesCache.get(record.sequence);
		if (cached) return cached;
		const expanded = expandPrettyDataLines(rawSseRecordLines(record));
		this.#prettyLinesCache.set(record.sequence, expanded);
		return expanded;
	}

	#pruneCache(firstSequence: number): void {
		// Bounded by the buffer eviction rate; with `MAX_RAW_SSE_EVENTS = 1000`
		// this rarely runs and only walks freshly-evicted entries.
		for (const key of this.#prettyLinesCache.keys()) {
			if (key < firstSequence) this.#prettyLinesCache.delete(key);
		}
	}
	#summaryText(): string {
		const snapshot = this.#currentSnapshot();
		const last = snapshot.lastUpdatedAt
			? `${theme.fg("muted", "last")} ${theme.fg("accent", formatRawSseIsoTime(snapshot.lastUpdatedAt))}`
			: theme.fg("muted", "waiting for first frame");
		const follow = this.#frame.isFollowingTail()
			? theme.fg("success", "follow on")
			: theme.fg("warning", "follow off");
		return `${theme.fg("muted", "events")} ${theme.fg("accent", String(snapshot.totalEvents))}  ${theme.fg("muted", "records")} ${theme.fg("accent", String(snapshot.records.length))}  ${last}  ${follow}`;
	}

	#statusText(): string {
		const help = `${formatKeyHint("escape")} close · ${formatKeyHint("ctrl+c")} copy raw · ${formatKeyHint("end")} follow tail · wheel scroll · click summary toggles follow`;
		return this.#statusMessage
			? `${theme.fg("success", this.#statusMessage)}  ${theme.fg("dim", help)}`
			: theme.fg("dim", help);
	}

	#copyAll(): void {
		const payload = this.#buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			this.#statusMessage = message;
			this.#statusFailed = true;
			this.#onStatus?.(message);
			this.#onUpdate?.();
			return;
		}

		try {
			this.#deps.copyToClipboard(payload);
			const message = "Copied raw SSE stream";
			this.#statusMessage = message;
			this.#statusFailed = false;
			this.#onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#statusMessage = `Copy failed: ${message}`;
			this.#statusFailed = true;
		}
		this.#onUpdate?.();
	}
}
