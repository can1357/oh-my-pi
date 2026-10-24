import { PROGRESS_LIMITS } from "./progress-limits";

/**
 * Fixed-size identity of the exact normalized stream consumed by
 * {@link ProgressLines}. UTF-16 code units match JavaScript string equality
 * while remaining invariant when a surrogate pair spans input chunks.
 */
export interface ProgressStreamProvenance {
	codeUnits: number;
	sha256: string;
}

export function progressStreamProvenanceForText(text: string): ProgressStreamProvenance {
	return {
		codeUnits: text.length,
		sha256: new Bun.CryptoHasher("sha256").update(text, "utf16le").digest("base64"),
	};
}
/** Keep at most `maxChars` UTF-16 code units from either edge, moving inward rather than splitting a surrogate pair. */
function boundedSlice(text: string, maxChars: number, fromEnd = false, precedingCodeUnit?: number): string {
	if (!fromEnd) {
		if (text.length <= maxChars) return text;
		let end = maxChars;
		const beforeEnd = text.charCodeAt(end - 1);
		const atEnd = text.charCodeAt(end);
		if (beforeEnd >= 0xd800 && beforeEnd <= 0xdbff && atEnd >= 0xdc00 && atEnd <= 0xdfff) {
			end--;
		}
		return text.slice(0, end);
	}

	let start = Math.max(0, text.length - maxChars);
	const beforeStart = start === 0 ? precedingCodeUnit : text.charCodeAt(start - 1);
	const atStart = text.charCodeAt(start);
	if (
		beforeStart !== undefined &&
		beforeStart >= 0xd800 &&
		beforeStart <= 0xdbff &&
		atStart >= 0xdc00 &&
		atStart <= 0xdfff
	) {
		start++;
	}
	return start === 0 ? text : text.slice(start);
}

export interface ProgressLine {
	text: string;
	truncated: boolean;
	/**
	 * Cumulative identity of the raw stream through this reported line. The
	 * object advances through following blank records that are suppressed from
	 * display, until another non-blank line is reported.
	 */
	streamProvenance: ProgressStreamProvenance;
}

/**
 * Incrementally reports complete, non-empty output lines with bounded partial
 * state; a line longer than {@link PROGRESS_LIMITS.LINE_CHARS} keeps only its
 * head and tail.
 */
export class ProgressLines {
	static readonly #HEAD_CHARS = Math.floor(PROGRESS_LIMITS.LINE_CHARS / 2);
	static readonly #TAIL_CHARS = PROGRESS_LIMITS.LINE_CHARS - ProgressLines.#HEAD_CHARS;
	readonly #report: (line: ProgressLine) => void;
	#partial = "";
	#head = "";
	#tail = "";
	#truncated = false;
	#streamHash = new Bun.CryptoHasher("sha256");
	#streamCodeUnits = 0;
	#pendingHighSurrogate = "";
	#latestReportedStreamProvenance: ProgressStreamProvenance | undefined;
	#epoch = 0;

	constructor(report: (line: ProgressLine) => void) {
		this.#report = report;
	}

	/**
	 * Current boundary generation. Feeds whose chunk delivery can lag (e.g.
	 * mirror-mode sinks that flush an artifact before notifying) capture this
	 * value when a chunk enters the pipeline and pass it back to `append` so
	 * chunks that predate a `resetDisplay()` boundary are discarded on arrival.
	 */
	get epoch(): number {
		return this.#epoch;
	}

	append(chunk: string, epoch?: number): void {
		if (epoch !== undefined && epoch !== this.#epoch) return;
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline !== -1) {
			const segment = chunk.slice(start, newline);
			this.#appendPartial(segment);
			this.#appendStream(segment);
			this.#appendStream("\n");
			this.#reportLine(this.#partial, this.#streamProvenance());
			this.#partial = "";
			this.#head = "";
			this.#tail = "";
			this.#truncated = false;
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) {
			const segment = chunk.slice(start);
			this.#appendPartial(segment);
			this.#appendStream(segment);
		}
	}

	finish(): void {
		if (this.#partial === "" && !this.#truncated) return;
		const line = this.#partial;
		this.#partial = "";
		this.#reportLine(line, this.#streamProvenance());
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
	}
	/**
	 * Marks a display boundary while preserving the cumulative raw-stream
	 * provenance used to deduplicate terminal output. Stale stamped chunks are
	 * ignored, and an unfinished foreground fragment is not replayed after the
	 * boundary.
	 */
	resetDisplay(): void {
		this.#epoch++;
		this.#partial = "";
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
	}
	/**
	 * Marks a display boundary and returns the cumulative stream identity shared
	 * with following suppressed blank records. Callers can retain this object to
	 * recognize output already shown before the boundary even when later blank
	 * records advance the raw stream without producing another progress line.
	 */
	resetDisplayAndCaptureProvenance(): ProgressStreamProvenance | undefined {
		this.resetDisplay();
		if (this.#streamCodeUnits === 0) return undefined;
		const streamProvenance = this.#streamProvenance();
		this.#latestReportedStreamProvenance = streamProvenance;
		return streamProvenance;
	}

	/** Clear both display state and cumulative stream provenance. */
	reset(): void {
		this.resetDisplay();
		this.#streamHash = new Bun.CryptoHasher("sha256");
		this.#streamCodeUnits = 0;
		this.#pendingHighSurrogate = "";
		this.#latestReportedStreamProvenance = undefined;
	}

	#appendPartial(segment: string): void {
		if (this.#truncated) {
			this.#tail =
				segment.length >= ProgressLines.#TAIL_CHARS
					? boundedSlice(segment, ProgressLines.#TAIL_CHARS, true, this.#tail.charCodeAt(this.#tail.length - 1))
					: `${boundedSlice(this.#tail, ProgressLines.#TAIL_CHARS - segment.length, true)}${segment}`;
			return;
		}
		if (this.#partial.length + segment.length <= PROGRESS_LIMITS.LINE_CHARS) {
			this.#partial += segment;
			return;
		}
		this.#head = boundedSlice(
			`${this.#partial}${boundedSlice(segment, ProgressLines.#HEAD_CHARS)}`,
			ProgressLines.#HEAD_CHARS,
		);
		this.#tail =
			segment.length >= ProgressLines.#TAIL_CHARS
				? boundedSlice(segment, ProgressLines.#TAIL_CHARS, true, this.#partial.charCodeAt(this.#partial.length - 1))
				: `${boundedSlice(this.#partial, ProgressLines.#TAIL_CHARS - segment.length, true)}${segment}`;
		this.#partial = "";
		this.#truncated = true;
	}

	#appendStream(text: string): void {
		this.#streamCodeUnits += text.length;
		if (text.length === 0) return;

		let start = 0;
		if (this.#pendingHighSurrogate) {
			const startsWithLowSurrogate = text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff;
			this.#streamHash.update(
				startsWithLowSurrogate ? `${this.#pendingHighSurrogate}${text[0]}` : this.#pendingHighSurrogate,
				"utf16le",
			);
			this.#pendingHighSurrogate = "";
			if (startsWithLowSurrogate) start = 1;
		}

		const lastCodeUnit = text.charCodeAt(text.length - 1);
		const endsWithHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
		const end = endsWithHighSurrogate ? text.length - 1 : text.length;
		if (start < end) {
			this.#streamHash.update(start === 0 && end === text.length ? text : text.slice(start, end), "utf16le");
		}
		if (endsWithHighSurrogate) this.#pendingHighSurrogate = text[text.length - 1];
	}

	#streamProvenance(): ProgressStreamProvenance {
		const hash = this.#streamHash.copy();
		if (this.#pendingHighSurrogate) hash.update(this.#pendingHighSurrogate, "utf16le");
		return {
			codeUnits: this.#streamCodeUnits,
			sha256: hash.digest("base64"),
		};
	}

	#reportLine(rawLine: string, streamProvenance: ProgressStreamProvenance): void {
		const preview = this.#truncated ? `${this.#head}${this.#tail}` : rawLine;
		const line = preview.replace(/\r$/, "");
		if (line.trim().length === 0) {
			if (this.#latestReportedStreamProvenance) {
				this.#latestReportedStreamProvenance.codeUnits = streamProvenance.codeUnits;
				this.#latestReportedStreamProvenance.sha256 = streamProvenance.sha256;
			}
			return;
		}
		this.#latestReportedStreamProvenance = streamProvenance;
		this.#report({ text: line, truncated: this.#truncated, streamProvenance });
	}
}
