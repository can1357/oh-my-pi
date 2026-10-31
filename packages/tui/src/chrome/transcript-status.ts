import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Text } from "../components/text";
import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
import { type ThemeColor, theme } from "../theme";
import { TranscriptBlock } from "./transcript-container";
import { type NoticeTone, noticeRow } from "./transcript-notice";

/** One themed run of a status row's terminal line. */
export interface TranscriptStatusPart {
	readonly text: string;
	readonly color: ThemeColor;
}

/** A status row in a native terminal: its {@link noticeRow}'s tone, icon and message. */
export interface TranscriptStatusNative {
	readonly tone: NoticeTone;
	/** Icon name in place of the tone's own. */
	readonly icon?: string;
	readonly message: readonly TspSpan[];
}

/**
 * One compact transcript status row: the terminal line's themed parts (joined
 * by single spaces, glyphs and brackets included) and the same row natively.
 */
export interface TranscriptStatusRow {
	readonly parts: readonly (TranscriptStatusPart | undefined)[];
	readonly indent?: number;
	readonly native: TranscriptStatusNative;
}

/**
 * Shared compact status block for background activity and prompt file reads:
 * one themed line per row in a text terminal, one notice row per row natively
 * (`omp.status-block`).
 */
export class TranscriptStatusBlock extends TranscriptBlock {
	readonly #native: NativeNode;

	constructor(rows: readonly TranscriptStatusRow[]) {
		super();
		for (const row of rows) {
			const styled = row.parts.flatMap(part => (part ? [theme.fg(part.color, part.text)] : []));
			this.addChild(new Text(styled.join(" "), row.indent ?? 1, 0));
		}
		this.#native = col(
			rows.map(({ native }) => noticeRow(native.tone, native.message, { icon: native.icon })),
			{ role: "omp.status-block" },
		);
	}

	override describe(): NativeNode {
		return this.#native;
	}
}
