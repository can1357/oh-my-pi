import * as crypto from "node:crypto";

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
		sha256: crypto.createHash("sha256").update(text, "utf16le").digest("base64"),
	};
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

/** Incrementally reports complete, non-empty output lines with bounded partial state. */
export class ProgressLines {
	static readonly MAX_LINE_CHARS = 500;
	static readonly #HEAD_CHARS = Math.floor(ProgressLines.MAX_LINE_CHARS / 2);
	static readonly #TAIL_CHARS = ProgressLines.MAX_LINE_CHARS - ProgressLines.#HEAD_CHARS;
	readonly #report: (line: ProgressLine) => void;
	#partial = "";
	#head = "";
	#tail = "";
	#truncated = false;
	#streamHash = crypto.createHash("sha256");
	#streamCodeUnits = 0;
	#pendingHighSurrogate = "";
	#latestReportedStreamProvenance: ProgressStreamProvenance | undefined;

	constructor(report: (line: ProgressLine) => void) {
		this.#report = report;
	}

	append(chunk: string): void {
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

	reset(): void {
		this.#partial = "";
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
		this.#streamHash = crypto.createHash("sha256");
		this.#streamCodeUnits = 0;
		this.#pendingHighSurrogate = "";
		this.#latestReportedStreamProvenance = undefined;
	}

	#appendPartial(segment: string): void {
		if (this.#truncated) {
			this.#tail =
				segment.length >= ProgressLines.#TAIL_CHARS
					? segment.slice(-ProgressLines.#TAIL_CHARS)
					: `${this.#tail.slice(-(ProgressLines.#TAIL_CHARS - segment.length))}${segment}`;
			return;
		}
		if (this.#partial.length + segment.length <= ProgressLines.MAX_LINE_CHARS) {
			this.#partial += segment;
			return;
		}
		this.#head = `${this.#partial}${segment.slice(0, ProgressLines.#HEAD_CHARS)}`.slice(0, ProgressLines.#HEAD_CHARS);
		this.#tail =
			segment.length >= ProgressLines.#TAIL_CHARS
				? segment.slice(-ProgressLines.#TAIL_CHARS)
				: `${this.#partial.slice(-(ProgressLines.#TAIL_CHARS - segment.length))}${segment}`;
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
