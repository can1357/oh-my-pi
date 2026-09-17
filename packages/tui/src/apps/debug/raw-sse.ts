import type { Component } from "../../tui";
import { matchesKey } from "../../keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { replaceTabs, truncateToWidth } from "../../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../../theme/theme";
import { DebugViewerFrame } from "./viewer-frame";
import {
	formatRawSseIsoTime,
	type RawSseDebugBuffer,
	type RawSseDebugRecord,
	rawSseRecordLines,
} from "./raw-sse-buffer";

const MIN_VIEWER_WIDTH = 40;
// `data:` lines below this width render fine on a single row; anything wider gets pretty-printed
// across multiple `data:` lines so streamed JSON blobs stop getting clipped by `truncateToWidth`.
const PRETTY_PRINT_DATA_THRESHOLD = 100;

function sanitizeFrameLine(line: string, width: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(line)), width);
}

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
	#disposed = false;
	// Pretty-printed wire lines keyed by `record.sequence`. Pretty-printing is
	// the JSON.parse + JSON.stringify per `data:` line, so we cache the result —
	// the render path runs on every keypress and scroll update.
	// Sequences are monotonic; we prune entries below the oldest live record
	// after each render so the cache tracks the buffer's eviction window.
	readonly #prettyLinesCache = new Map<number, string[]>();

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
			this.dispose();
			this.#onExit();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copyAll();
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#frame.scroll(-1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#frame.scroll(1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#frame.scroll(-this.#frame.getBodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#frame.scroll(this.#frame.getBodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "end")) {
			this.#frame.setFollowTail(true);
			this.#onUpdate?.();
		}
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
	}

	render(width: number): readonly string[] {
		return this.#frame.render(Math.max(MIN_VIEWER_WIDTH, width));
	}

	#renderRawLines(innerWidth: number): string[] {
		const snapshot = this.#buffer.snapshot();
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
				lines.push(sanitizeFrameLine(line, innerWidth));
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
		const snapshot = this.#buffer.snapshot();
		const last = snapshot.lastUpdatedAt
			? `${theme.fg("muted", "last")} ${theme.fg("accent", formatRawSseIsoTime(snapshot.lastUpdatedAt))}`
			: theme.fg("muted", "waiting for first frame");
		const follow = this.#frame.isFollowingTail()
			? theme.fg("success", "follow on")
			: theme.fg("warning", "follow off");
		return `${theme.fg("muted", "events")} ${theme.fg("accent", String(snapshot.totalEvents))}  ${theme.fg("muted", "records")} ${theme.fg("accent", String(snapshot.records.length))}  ${last}  ${follow}`;
	}

	#statusText(): string {
		const help = "Esc close · Ctrl+C copy raw · End follow tail · wheel scroll · click summary toggles follow";
		return this.#statusMessage
			? `${theme.fg("success", this.#statusMessage)}  ${theme.fg("dim", help)}`
			: theme.fg("dim", help);
	}

	#copyAll(): void {
		const payload = this.#buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			this.#statusMessage = message;
			this.#onStatus?.(message);
			this.#onUpdate?.();
			return;
		}

		try {
			this.#deps.copyToClipboard(payload);
			const message = "Copied raw SSE stream";
			this.#statusMessage = message;
			this.#onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#statusMessage = `Copy failed: ${message}`;
		}
		this.#onUpdate?.();
	}
}
