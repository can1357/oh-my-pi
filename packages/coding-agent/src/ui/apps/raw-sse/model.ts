/**
 * The raw provider stream viewer's state: the captured buffer (re-read on
 * every change), the copy status, the native scroll requests, and the
 * terminal frame (scroll position, follow-tail) the viewer paints in.
 */
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { type Accessor, signal } from "@oh-my-pi/pi-tui";
import { stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspScrollBy } from "@oh-my-pi/pi-wire";
import {
	formatRawSseIsoTime,
	type RawSseDebugBuffer,
	type RawSseDebugRecord,
	type RawSseDebugSnapshot,
	rawSseRecordLines,
} from "../../../debug/raw-sse-buffer";
import { formatKeyHint } from "../../keys/hints";
import { ViewerFrameModel } from "../viewer-frame";

/** `data:` lines up to this long show as captured; longer JSON payloads are pretty-printed over several `data:` lines. */
const PRETTY_PRINT_DATA_THRESHOLD = 100;

/** Wheel notches scroll this many rows. */
const WHEEL_ROWS = 3;

/**
 * `data: <json>` lines too wide for a row as multi-line `data:` entries of
 * indented JSON (still valid SSE: the spec joins `data:` lines with `\n`).
 */
export function expandPrettyDataLines(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of raw) {
		const body = line.startsWith("data: ") ? line.slice(6).trim() : "";
		if (line.length <= PRETTY_PRINT_DATA_THRESHOLD || (body[0] !== "{" && body[0] !== "[")) {
			out.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			out.push(line);
			continue;
		}
		for (const pretty of JSON.stringify(parsed, null, 2).split("\n")) out.push(`data: ${pretty}`);
	}
	return out;
}

/** A copy outcome shown under the stream. */
export interface RawSseStatus {
	readonly text: string;
	readonly failed: boolean;
}

export interface RawSseViewerOptions {
	readonly buffer: RawSseDebugBuffer;
	/** Screen rows the terminal frame fills. */
	readonly terminalRows: number | Accessor<number>;
	copyToClipboard(text: string): void;
	onExit(): void;
	onStatus?(message: string): void;
}

const SCROLL_KEYS: Readonly<Record<string, TspScrollBy>> = {
	up: "line-up",
	down: "line-down",
	pageUp: "page-up",
	pageDown: "page-down",
	home: "start",
	end: "end",
};

export class RawSseViewerModel {
	readonly frame: ViewerFrameModel;
	readonly status = signal<RawSseStatus | undefined>(undefined);
	/** The last scroll key, forwarded to the native stream block. */
	readonly scroll = signal<{ by: TspScrollBy; n: number } | undefined>(undefined);
	readonly #options: RawSseViewerOptions;
	readonly #revision = signal(0);
	readonly #unsubscribe: () => void;
	readonly #pretty = new Map<number, string[]>();

	constructor(options: RawSseViewerOptions) {
		this.#options = options;
		this.#unsubscribe = options.buffer.subscribe(() => this.#revision.update(n => n + 1));
		this.frame = new ViewerFrameModel({
			title: "Raw Provider Stream",
			height: options.terminalRows,
			headerRows: 1,
			footerRows: 1,
			minimumBodyRows: 3,
			followTail: true,
			content: context => ({
				header: [this.#summary()],
				body: { lines: this.#bodyLines(context.contentWidth) },
				footer: [this.#footer()],
			}),
		});
	}

	/** The buffer's live window (re-read whenever it changes). */
	snapshot(): RawSseDebugSnapshot {
		this.#revision();
		return this.#options.buffer.snapshot();
	}

	/** A record's wire lines, `data:` JSON pretty-printed (cached per record). */
	recordLines(record: RawSseDebugRecord): string[] {
		let lines = this.#pretty.get(record.sequence);
		if (!lines) {
			lines = expandPrettyDataLines(rawSseRecordLines(record)).map(line => stripControl(line));
			this.#pretty.set(record.sequence, lines);
		}
		return lines;
	}

	/** Esc closes, Ctrl+C copies, ↑ ↓ PgUp PgDn Home End scroll (End follows the tail again). */
	key(id: string): boolean {
		if (id === "escape") {
			this.close();
			return true;
		}
		if (id === "ctrl+c") {
			this.copy();
			return true;
		}
		const by = SCROLL_KEYS[id];
		if (!by) return false;
		const page = this.frame.bodyHeight();
		if (by === "line-up") this.frame.scroll(-1);
		else if (by === "line-down") this.frame.scroll(1);
		else if (by === "page-up") this.frame.scroll(-page);
		else if (by === "page-down") this.frame.scroll(page);
		else if (by === "start") this.frame.setScrollOffset(0);
		else this.frame.setFollowTail(true);
		this.scroll.set({ by, n: (this.scroll.peek()?.n ?? 0) + 1 });
		return true;
	}

	/** A mouse event at frame row `row`: the wheel scrolls the body, a click on the summary toggles following, on the body pins that row to the top. */
	mouse(row: number, mouse: MouseEvent): boolean {
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			if (!this.frame.isBodyFrameRow(row)) return false;
			this.frame.scroll(mouse.button === "wheel-down" ? WHEEL_ROWS : -WHEEL_ROWS);
			return true;
		}
		if (mouse.button !== "left" || mouse.action !== "press") return false;
		if (this.frame.toHeaderRow(row) === 0) {
			this.frame.setFollowTail(!this.frame.isFollowingTail());
			return true;
		}
		const body = this.frame.toBodyRow(row);
		if (body === undefined) return false;
		this.frame.setScrollOffset(body);
		return true;
	}

	/** Copy the captured stream as SSE wire text. */
	copy(): void {
		const payload = this.#options.buffer.toRawText();
		if (payload.trim().length === 0) {
			const text = "No raw SSE frames to copy";
			this.status.set({ text, failed: true });
			this.#options.onStatus?.(text);
			return;
		}
		try {
			this.#options.copyToClipboard(payload);
			const text = "Copied raw SSE stream";
			this.status.set({ text, failed: false });
			this.#options.onStatus?.(text);
		} catch (error) {
			this.status.set({
				text: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
				failed: true,
			});
		}
	}

	close(): void {
		this.dispose();
		this.#options.onExit();
	}

	dispose(): void {
		this.#unsubscribe();
	}

	#summary(): string {
		const theme = currentTheme();
		const snapshot = this.snapshot();
		const last = snapshot.lastUpdatedAt
			? `${theme.fg("muted", "last")} ${theme.fg("accent", formatRawSseIsoTime(snapshot.lastUpdatedAt))}`
			: theme.fg("muted", "waiting for first frame");
		const follow = this.frame.isFollowingTail()
			? theme.fg("success", "follow on")
			: theme.fg("warning", "follow off");
		return `${theme.fg("muted", "events")} ${theme.fg("accent", String(snapshot.totalEvents))}  ${theme.fg("muted", "records")} ${theme.fg("accent", String(snapshot.records.length))}  ${last}  ${follow}`;
	}

	#bodyLines(width: number): string[] {
		const theme = currentTheme();
		const snapshot = this.snapshot();
		if (snapshot.records.length === 0) {
			this.#pretty.clear();
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
				"",
			);
		}
		for (const record of snapshot.records) {
			for (const line of this.recordLines(record)) lines.push(truncate(line, width));
			if (record.kind === "event" && record.truncated) {
				lines.push(theme.fg("warning", `: omp-debug-event-truncated originalChars=${record.originalChars}`));
			}
			lines.push("");
		}
		const first = snapshot.records[0]!.sequence;
		for (const sequence of this.#pretty.keys()) if (sequence < first) this.#pretty.delete(sequence);
		return lines;
	}

	#footer(): string {
		const theme = currentTheme();
		const help = theme.fg(
			"dim",
			`${formatKeyHint("escape")} close · ${formatKeyHint("ctrl+c")} copy raw · ${formatKeyHint("end")} follow tail · wheel scroll · click summary toggles follow`,
		);
		const status = this.status();
		return status ? `${theme.fg("success", status.text)}  ${help}` : help;
	}
}
