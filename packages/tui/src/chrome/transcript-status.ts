import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Text } from "../components/text";
import { col, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { type ThemeColor, theme } from "../theme";
import { TranscriptBlock } from "./transcript-container";
import { type NoticeTone, noticeRow } from "./transcript-notice";

/** One run of a status row's terminal line, in `color` unless the text is already styled. */
export interface TranscriptStatusPart {
	readonly text: string;
	readonly color?: ThemeColor;
}

/** A status row in a native terminal: its {@link noticeRow}'s tone, icon and message. */
export interface TranscriptStatusNative {
	readonly tone: NoticeTone;
	/** Icon name in place of the tone's own. */
	readonly icon?: string;
	readonly message: readonly TspSpan[];
	/**
	 * A body line of the notice row before it (a job's output under its header):
	 * natively wrapped beneath that row's message, without an icon or tone of its own.
	 */
	readonly body?: boolean;
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
 * (`omp.status-block`), body rows inside the notice they follow.
 */
export class TranscriptStatusBlock extends TranscriptBlock {
	readonly #native: NativeNode;

	constructor(rows: readonly TranscriptStatusRow[]) {
		super();
		for (const row of rows) {
			const styled = row.parts.flatMap(part =>
				part ? [part.color ? theme.fg(part.color, part.text) : part.text] : [],
			);
			this.addChild(new Text(styled.join(" "), row.indent ?? 1, 0));
		}
		const notices: NativeNode[] = [];
		for (let i = 0; i < rows.length; i++) {
			const { native } = rows[i];
			const body: NativeNode[] = [];
			while (rows[i + 1]?.native.body) body.push(text(rows[++i].native.message, { wrap: "word" }));
			notices.push(noticeRow(native.tone, native.message, { icon: native.icon, body }));
		}
		this.#native = col(notices, { role: "omp.status-block" });
	}

	override describe(): NativeNode {
		return this.#native;
	}
}
