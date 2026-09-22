import { Text } from "../components/text";
import { TranscriptBlock } from "./transcript-container";

/** One compact transcript status row assembled from already-styled parts. */
export interface TranscriptStatusRow {
	readonly parts: readonly (string | undefined)[];
	readonly indent?: number;
}

/** Shared compact status-pill block used by notices and background activity. */
export class TranscriptStatusBlock extends TranscriptBlock {
	constructor(rows: readonly TranscriptStatusRow[]) {
		super();
		for (const row of rows) {
			const parts: string[] = [];
			for (const part of row.parts) {
				if (part) parts.push(part);
			}
			this.addChild(new Text(parts.join(" "), row.indent ?? 1, 0));
		}
	}

	/** Append a supplemental line such as an artifact warning. */
	addLine(text: string, indent = 1): void {
		this.addChild(new Text(text, indent, 0));
	}
}
