import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Text } from "../components/text";
import { col, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { type ThemeColor, theme } from "../theme";
import { TranscriptBlock } from "./transcript-container";

/** One themed run of a status row. */
export interface TranscriptStatusPart {
	readonly text: string;
	readonly color: ThemeColor;
	/** Glyph art (tree connectors) drawn only in rows; native terminals draw their own structure. */
	readonly rowsOnly?: boolean;
}

/** One compact transcript status row assembled from themed parts, joined by single spaces. */
export interface TranscriptStatusRow {
	readonly parts: readonly (TranscriptStatusPart | undefined)[];
	readonly indent?: number;
}

/** Shared compact status-pill block used by notices and background activity. */
export class TranscriptStatusBlock extends TranscriptBlock {
	readonly #rows: TspSpan[][] = [];
	#native: NativeNode | undefined;

	constructor(rows: readonly TranscriptStatusRow[]) {
		super();
		for (const row of rows) this.addLine(row.parts, row.indent);
	}

	/** Append a supplemental line such as an artifact warning. */
	addLine(parts: readonly (TranscriptStatusPart | undefined)[], indent = 1): void {
		const styled: string[] = [];
		const spans: TspSpan[] = [];
		for (const part of parts) {
			if (!part) continue;
			styled.push(theme.fg(part.color, part.text));
			if (part.rowsOnly) continue;
			if (spans.length > 0) spans.push(span(" "));
			spans.push(span(part.text, part.color));
		}
		this.addChild(new Text(styled.join(" "), indent, 0));
		this.#rows.push(spans);
		this.#native = undefined;
	}

	/** One wrapped text line per status row. */
	override describe(): NativeNode {
		this.#native ??= col(
			this.#rows.map(spans => text(spans, { wrap: "word" })),
			{ role: "omp.status-block" },
		);
		return this.#native;
	}
}
